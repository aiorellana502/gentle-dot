//! Windows-only native bridge for the app/daemon private channel.
//! Verified, independently cancellable duplex I/O. No Unix build is promised.
use napi::bindgen_prelude::{AsyncTask, BigInt, Buffer};
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    ERROR_BROKEN_PIPE, ERROR_IO_PENDING, ERROR_NOT_FOUND, ERROR_NO_DATA, ERROR_OPERATION_ABORTED,
    ERROR_PIPE_NOT_CONNECTED,
};
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile, FILE_FLAG_OVERLAPPED};
use windows_sys::Win32::System::Threading::CreateEventW;
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::{
    Foundation::{
        GetLastError, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_PIPE_BUSY, FILETIME,
        GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    Storage::FileSystem::{CreateFileW, OPEN_EXISTING},
    System::{
        Pipes::GetNamedPipeServerProcessId,
        Threading::{
            GetProcessTimes, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
            PROCESS_SYNCHRONIZE,
        },
    },
};

fn filetime(value: BigInt) -> Result<u64> {
    match value.words.as_slice() {
        [word] if !value.sign_bit => Ok(*word),
        [] if !value.sign_bit => Ok(0),
        _ => Err(Error::new(
            Status::InvalidArg,
            "InvalidFileTime: expected unsigned 64-bit BigInt",
        )),
    }
}

/// Compare PID plus exact unsigned FILETIME ticks (not milliseconds or JS numbers).
/// Reject negative/oversized BigInts rather than truncating them to a matching identity.
#[napi]
pub fn identity_matches(
    expected_pid: u32,
    expected_created_at: BigInt,
    actual_pid: u32,
    actual_created_at: BigInt,
) -> Result<bool> {
    let expected = filetime(expected_created_at)?;
    let actual = filetime(actual_created_at)?;
    Ok(expected_pid == actual_pid && expected == actual)
}

fn failure(message: &str) -> Error {
    Error::new(Status::GenericFailure, message)
}

fn win32(operation: &str) -> Error {
    let code = unsafe { GetLastError() };
    failure(&format!("{operation}: Win32 error {code}"))
}

fn open_process(pid: u32) -> Result<OwnedHandle> {
    // SYNCHRONIZE enables retained-handle liveness without the STILL_ACTIVE/exit-code-259
    // ambiguity. Neither this nor the pipe handle is ever inheritable.
    let raw = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if raw.is_null() {
        return Err(win32("ServerProcessOpenFailed: OpenProcess"));
    }
    // SAFETY: successful API result transfers unique ownership to this RAII wrapper.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

fn creation_time(process: &OwnedHandle) -> Result<u64> {
    let mut created: FILETIME = unsafe { std::mem::zeroed() };
    let mut exit = created;
    let mut kernel = created;
    let mut user = created;
    if unsafe {
        GetProcessTimes(
            process.as_raw_handle(),
            &mut created,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return Err(win32("ServerProcessTimesFailed: GetProcessTimes"));
    }
    Ok(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
}

/// A verified server identity and its exact connected duplex pipe.
/// isAlive polls the same kernel process object; it never reopens a potentially reused PID.
/// close is idempotent; GC also releases the handle. A closed identity is not alive.
#[napi]
pub struct VerifiedServer {
    process: Option<OwnedHandle>,
    reader: Option<Arc<Direction>>,
    writer: Option<Arc<Direction>>,
}

#[derive(Default)]
struct DirectionState {
    revoked: bool,
    busy: bool,
    // Boxed OVERLAPPED address, registered only while this mutex protects it.
    active: Option<usize>,
}

struct Direction {
    pipe: Arc<OwnedHandle>,
    event: OwnedHandle,
    state: Mutex<DirectionState>,
}

impl Direction {
    fn new(pipe: Arc<OwnedHandle>) -> Result<Arc<Self>> {
        let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if event.is_null() {
            return Err(win32("PipeEventFailed: CreateEventW"));
        }
        Ok(Arc::new(Self {
            pipe,
            event: unsafe { OwnedHandle::from_raw_handle(event) },
            state: Mutex::new(DirectionState::default()),
        }))
    }

    fn state(&self) -> MutexGuard<'_, DirectionState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn cancel(&self) -> Result<()> {
        let mut state = self.state();
        state.revoked = true;
        if let Some(address) = state.active {
            // Submission and unregistering use this same mutex. The worker owns
            // all kernel-visible storage until settlement; cancellation never waits.
            if unsafe { CancelIoEx(self.pipe.as_raw_handle(), address as *const OVERLAPPED) } == 0 {
                let code = unsafe { GetLastError() };
                if code != ERROR_NOT_FOUND {
                    return Err(failure(&format!("PipeCancelFailed: Win32 error {code}")));
                }
            }
        }
        Ok(())
    }
}

// A reservation is made before queueing work, not when a worker finally starts.
// Dropping undelivered/unqueued/completed tasks also releases the reservation.
struct Reservation(Arc<Direction>);
impl Reservation {
    fn acquire(direction: &Option<Arc<Direction>>) -> Result<Self> {
        let direction = direction
            .as_ref()
            .ok_or_else(|| failure("PipeClosed: transport closed"))?;
        let mut state = direction.state();
        if state.revoked {
            return Err(failure("PipeCancelled: direction permanently revoked"));
        }
        if state.busy {
            return Err(failure("PipeBusy: direction already has an operation"));
        }
        state.busy = true;
        Ok(Self(direction.clone()))
    }

    fn transfer(&self, buffer: &mut [u8], read: bool) -> Result<usize> {
        let direction = &self.0;
        let mut operation: Box<OVERLAPPED> = Box::new(unsafe { std::mem::zeroed() });
        operation.hEvent = direction.event.as_raw_handle();
        let mut state = direction.state();
        if state.revoked {
            return Err(failure("PipeCancelled: direction permanently revoked"));
        }
        if buffer.is_empty() {
            return Ok(0);
        }
        state.active = Some((&mut *operation as *mut OVERLAPPED) as usize);
        let raw = direction.pipe.as_raw_handle();
        // Each direction owns its own event. Windows resets a manual-reset event
        // on submission; no other operation can reuse it until this one settles.
        let started = unsafe {
            if read {
                ReadFile(
                    raw,
                    buffer.as_mut_ptr(),
                    buffer.len().min(u32::MAX as usize) as u32,
                    std::ptr::null_mut(),
                    &mut *operation,
                )
            } else {
                WriteFile(
                    raw,
                    buffer.as_ptr(),
                    buffer.len().min(u32::MAX as usize) as u32,
                    std::ptr::null_mut(),
                    &mut *operation,
                )
            }
        };
        if started == 0 {
            let code = unsafe { GetLastError() };
            if code != ERROR_IO_PENDING {
                state.active = None;
                return transfer_error(code, read);
            }
        }
        drop(state);
        let mut transferred = 0;
        let completed = unsafe { GetOverlappedResult(raw, &*operation, &mut transferred, 1) };
        let code = if completed == 0 {
            unsafe { GetLastError() }
        } else {
            0
        };
        // Unregister before freeing operation. Cancellation can never observe a
        // dangling pointer, even if completion won the CancelIoEx race.
        direction.state().active = None;
        if completed == 0 {
            transfer_error(code, read)
        } else {
            Ok(transferred as usize)
        }
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.0.state().busy = false;
    }
}

fn transfer_error(code: u32, read: bool) -> Result<usize> {
    match code {
        ERROR_BROKEN_PIPE | ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED if read => Ok(0),
        ERROR_BROKEN_PIPE | ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED => {
            Err(failure("PipeBroken: peer disconnected"))
        }
        ERROR_OPERATION_ABORTED => Err(failure("PipeCancelled: operation aborted")),
        _ => Err(failure(&format!("PipeIoFailed: Win32 error {code}"))),
    }
}

pub struct ReadTask {
    reservation: Option<Result<Reservation>>,
    max_bytes: usize,
}
impl Task for ReadTask {
    type Output = Option<Vec<u8>>;
    type JsValue = Option<Buffer>;
    fn compute(&mut self) -> Result<Self::Output> {
        let reservation = self
            .reservation
            .take()
            .ok_or_else(|| failure("PipeTaskUsed: task already executed"))??;
        let mut bytes = vec![0; self.max_bytes];
        let count = reservation.transfer(&mut bytes, true)?;
        bytes.truncate(count);
        Ok((count != 0).then_some(bytes))
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.map(Buffer::from))
    }
}

pub struct WriteTask {
    reservation: Option<Result<Reservation>>,
    bytes: Vec<u8>,
}
impl Task for WriteTask {
    type Output = ();
    type JsValue = ();
    fn compute(&mut self) -> Result<()> {
        let reservation = self
            .reservation
            .take()
            .ok_or_else(|| failure("PipeTaskUsed: task already executed"))??;
        let mut offset = 0;
        // Even empty writes check revocation. Nonempty writes resolve only once
        // every byte has completed, including any partial native transfers.
        loop {
            let count = reservation.transfer(&mut self.bytes[offset..], false)?;
            offset += count;
            if offset == self.bytes.len() {
                return Ok(());
            }
            if count == 0 {
                return Err(failure("PipeBroken: zero-byte write"));
            }
        }
    }
    fn resolve(&mut self, _env: Env, _output: ()) -> Result<()> {
        Ok(())
    }
}

impl VerifiedServer {
    fn prepare_read(&self, max_bytes: f64) -> Result<ReadTask> {
        if !max_bytes.is_finite()
            || max_bytes.fract() != 0.0
            || !(1.0..=16_777_216.0).contains(&max_bytes)
        {
            return Err(Error::new(
                Status::InvalidArg,
                "InvalidReadSize: expected integer from 1 through 16777216",
            ));
        }
        Ok(ReadTask {
            reservation: Some(Reservation::acquire(&self.reader)),
            max_bytes: max_bytes as usize,
        })
    }
    fn prepare_write(&self, bytes: Buffer) -> Result<WriteTask> {
        Ok(WriteTask {
            reservation: Some(Reservation::acquire(&self.writer)),
            bytes: bytes.to_vec(),
        })
    }
}

impl Drop for VerifiedServer {
    fn drop(&mut self) {
        self.close();
    }
}

#[napi]
impl VerifiedServer {
    #[napi]
    pub fn is_alive(&self) -> Result<bool> {
        let Some(process) = &self.process else {
            return Ok(false);
        };
        match unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } {
            WAIT_TIMEOUT => Ok(true),
            WAIT_OBJECT_0 => Ok(false),
            _ => Err(win32("ServerLivenessFailed: WaitForSingleObject")),
        }
    }

    /// Read up to maxBytes (integer 1..16777216); null means clean EOF.
    /// Same-direction overlap rejects PipeBusy, including work still queued.
    #[napi]
    pub fn read(&self, max_bytes: f64) -> Result<AsyncTask<ReadTask>> {
        Ok(AsyncTask::new(self.prepare_read(max_bytes)?))
    }

    /// Copies the Buffer at call time; resolves once all bytes have completed.
    /// Peer disconnect rejects PipeBroken. Read and write may run concurrently.
    #[napi]
    pub fn write(&self, bytes: Buffer) -> Result<AsyncTask<WriteTask>> {
        Ok(AsyncTask::new(self.prepare_write(bytes)?))
    }

    /// Permanently revoke reads. Requests cancellation without waiting for settlement.
    #[napi]
    pub fn cancel_read(&self) -> Result<()> {
        self.reader
            .as_ref()
            .map_or(Ok(()), |direction| direction.cancel())
    }

    /// Permanently revoke writes; does not affect reads.
    #[napi]
    pub fn cancel_write(&self) -> Result<()> {
        self.writer
            .as_ref()
            .map_or(Ok(()), |direction| direction.cancel())
    }

    /// Idempotently release identity and transport ownership. Pending workers retain
    /// their pipe/event/buffer/OVERLAPPED until settlement; this method never joins them.
    #[napi]
    pub fn close(&mut self) {
        let _ = self.cancel_read();
        let _ = self.cancel_write();
        self.reader.take();
        self.writer.take();
        self.process.take();
    }
}

pub struct ConnectTask {
    name: String,
    expected_pid: u32,
    expected_created_at: u64,
    deadline: Instant,
}

impl ConnectTask {
    fn new(name: String, expected_pid: u32, expected_created_at: u64, timeout_ms: u32) -> Self {
        Self {
            name,
            expected_pid,
            expected_created_at,
            deadline: Instant::now() + Duration::from_millis(timeout_ms as u64),
        }
    }

    fn check_deadline(&self) -> Result<()> {
        if Instant::now() >= self.deadline {
            Err(failure("PipeConnectTimeout: connection deadline expired"))
        } else {
            Ok(())
        }
    }
}

impl Task for ConnectTask {
    type Output = VerifiedServer;
    type JsValue = VerifiedServer;

    fn compute(&mut self) -> Result<Self::Output> {
        let name: Vec<u16> = self.name.encode_utf16().chain(Some(0)).collect();
        let pipe = loop {
            self.check_deadline()?;
            // Non-inheritable from creation; this exact verified handle serves I/O.
            let raw = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED,
                    std::ptr::null_mut(),
                )
            };
            if raw != INVALID_HANDLE_VALUE {
                break unsafe { OwnedHandle::from_raw_handle(raw) };
            }
            let code = unsafe { GetLastError() };
            match code {
                ERROR_PIPE_BUSY => {
                    // Avoid WaitNamedPipeW's zero-timeout default and unbounded waits.
                    std::thread::sleep(
                        Duration::from_millis(5)
                            .min(self.deadline.saturating_duration_since(Instant::now())),
                    );
                }
                ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => {
                    return Err(failure(&format!(
                        "PipeConnectionRefused: CreateFileW: Win32 error {code}"
                    )))
                }
                _ => {
                    return Err(failure(&format!(
                        "PipeOpenFailed: CreateFileW: Win32 error {code}"
                    )))
                }
            }
        };
        let mut actual_pid = 0;
        if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut actual_pid) } == 0 {
            return Err(win32("ServerPidQueryFailed: GetNamedPipeServerProcessId"));
        }
        let process = open_process(actual_pid)?;
        let created = creation_time(&process)?;
        if !identity_matches(
            self.expected_pid,
            self.expected_created_at.into(),
            actual_pid,
            created.into(),
        )? {
            return Err(failure(
                "ServerIdentityMismatch: PID or creation FILETIME differs",
            ));
        }
        let pipe = Arc::new(pipe);
        let verified = VerifiedServer {
            process: Some(process),
            reader: Some(Direction::new(pipe.clone())?),
            writer: Some(Direction::new(pipe)?),
        };
        if !verified.is_alive()? {
            return Err(failure(
                "ServerExited: verified server process is no longer alive",
            ));
        }
        self.check_deadline()?;
        // Errors and failed task delivery drop all ownership through RAII.
        Ok(verified)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        self.check_deadline()?;
        if !output.is_alive()? {
            return Err(failure(
                "ServerExited: verified server process is no longer alive",
            ));
        }
        Ok(output)
    }
}

/// Open a local pipe and verify its server before any protocol bytes. Runs on Node's
/// worker pool, not the JS thread. timeoutMs includes queueing and busy-pipe retries;
/// zero expires immediately. Missing pipes fail immediately; busy pipes retry until expiry.
/// Win32 metadata calls are synchronous (not cancellable); late results are rejected.
/// Invalid arguments throw synchronously; connection failures reject the Promise with
/// operation-specific prefixes. Success retains this exact verified pipe for duplex I/O.
#[napi]
pub fn connect_verified(
    pipe_name: String,
    expected_pid: u32,
    expected_created_at: BigInt,
    timeout_ms: u32,
) -> Result<AsyncTask<ConnectTask>> {
    if !pipe_name.starts_with(r"\\.\pipe\") || pipe_name.len() <= 9 || pipe_name.contains('\0') {
        return Err(Error::new(
            Status::InvalidArg,
            "InvalidPipeName: expected local \\\\.\\pipe\\ name without NUL",
        ));
    }
    Ok(AsyncTask::new(ConnectTask::new(
        pipe_name,
        expected_pid,
        filetime(expected_created_at)?,
        timeout_ms,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use napi::Task;
    use std::sync::atomic::{AtomicU32, Ordering};
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_BROKEN_PIPE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
    use windows_sys::Win32::System::Pipes::{
        CreateNamedPipeW, PeekNamedPipe, PIPE_TYPE_BYTE, PIPE_WAIT,
    };

    fn fixture() -> (String, std::os::windows::io::OwnedHandle) {
        use std::os::windows::io::FromRawHandle;
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let name = format!(
            r"\\.\pipe\gentle-dot-addon-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let raw = unsafe {
            CreateNamedPipeW(
                wide.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_WAIT,
                1,
                4096,
                4096,
                0,
                std::ptr::null(),
            )
        };
        assert_ne!(raw, INVALID_HANDLE_VALUE);
        (name, unsafe {
            std::os::windows::io::OwnedHandle::from_raw_handle(raw)
        })
    }

    fn assert_no_bytes(server: &std::os::windows::io::OwnedHandle) {
        use std::os::windows::io::AsRawHandle;
        let mut available = 0;
        let ok = unsafe {
            PeekNamedPipe(
                server.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        };
        assert_eq!(available, 0, "verification must never write protocol bytes");
        if ok == 0 {
            assert_eq!(unsafe { GetLastError() }, ERROR_BROKEN_PIPE);
        }
    }

    fn connected() -> (VerifiedServer, OwnedHandle) {
        let (name, peer) = fixture();
        let process = open_process(std::process::id()).unwrap();
        let created = creation_time(&process).unwrap();
        (
            ConnectTask::new(name, std::process::id(), created, 1000)
                .compute()
                .unwrap(),
            peer,
        )
    }

    #[test]
    fn duplex_concurrent_roundtrip_and_eof() {
        use std::io::{Read, Write};
        let (mut verified, peer) = connected();
        let mut peer = std::fs::File::from(peer);
        let mut reading = verified.prepare_read(4096.0).unwrap();
        let (send, receive) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || send.send(reading.compute()).unwrap());
        let bytes: Vec<u8> = (0..=255).cycle().take(4096).collect();
        let mut writing = verified.prepare_write(bytes.clone().into()).unwrap();
        let writer = std::thread::spawn(move || writing.compute());
        let mut received = vec![0; bytes.len()];
        peer.read_exact(&mut received).unwrap();
        assert_eq!(received, bytes);
        peer.write_all(&received).unwrap();
        assert_eq!(
            receive
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap()
                .unwrap(),
            bytes
        );
        reader.join().unwrap();
        writer.join().unwrap().unwrap();
        drop(peer);
        assert!(verified
            .prepare_read(1.0)
            .unwrap()
            .compute()
            .unwrap()
            .is_none());
        assert!(verified
            .prepare_write(vec![1].into())
            .unwrap()
            .compute()
            .unwrap_err()
            .reason
            .starts_with("PipeBroken:"));
        verified.close();
        assert!(!verified.is_alive().unwrap());
    }

    #[test]
    fn duplex_close_cancels_pending_directions_and_is_prompt() {
        for read in [true, false] {
            let (mut verified, _peer) = connected();
            let (send, receive) = std::sync::mpsc::channel();
            let worker = if read {
                let mut task = verified.prepare_read(1024.0).unwrap();
                std::thread::spawn(move || send.send(task.compute().map(|_| ())).unwrap())
            } else {
                let mut task = verified
                    .prepare_write(vec![42; 8 * 1024 * 1024].into())
                    .unwrap();
                std::thread::spawn(move || send.send(task.compute()).unwrap())
            };
            std::thread::sleep(Duration::from_millis(50));
            let start = Instant::now();
            verified.close();
            verified.close();
            assert!(start.elapsed() < Duration::from_millis(500));
            assert!(receive
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap_err()
                .reason
                .starts_with("PipeCancelled:"));
            worker.join().unwrap();
            assert!(verified
                .prepare_read(1.0)
                .unwrap()
                .compute()
                .unwrap_err()
                .reason
                .starts_with("PipeClosed:"));
            assert!(verified
                .prepare_write(vec![1].into())
                .unwrap()
                .compute()
                .unwrap_err()
                .reason
                .starts_with("PipeClosed:"));
        }
    }

    #[test]
    fn duplex_overlap_and_permanent_directional_revocation() {
        use std::io::Read;
        let (mut verified, peer) = connected();
        let mut reserved = verified.prepare_read(1.0).unwrap();
        assert!(verified
            .prepare_read(1.0)
            .unwrap()
            .compute()
            .unwrap_err()
            .reason
            .starts_with("PipeBusy:"));
        verified.cancel_read().unwrap();
        assert!(reserved
            .compute()
            .unwrap_err()
            .reason
            .starts_with("PipeCancelled:"));
        drop(reserved);
        assert!(verified
            .prepare_read(1.0)
            .unwrap()
            .compute()
            .unwrap_err()
            .reason
            .starts_with("PipeCancelled:"));
        let mut write = verified.prepare_write(vec![7].into()).unwrap();
        assert!(verified
            .prepare_write(vec![8].into())
            .unwrap()
            .compute()
            .unwrap_err()
            .reason
            .starts_with("PipeBusy:"));
        write.compute().unwrap();
        drop(write);
        let mut peer = std::fs::File::from(peer);
        let mut byte = [0];
        peer.read_exact(&mut byte).unwrap();
        assert_eq!(byte, [7]);
        verified.cancel_write().unwrap();
        assert!(verified
            .prepare_write(vec![9].into())
            .unwrap()
            .compute()
            .unwrap_err()
            .reason
            .starts_with("PipeCancelled:"));
        verified.close();
    }

    #[test]
    fn matches_only_when_both_pid_and_creation_time_agree() {
        assert!(identity_matches(100, 5000u64.into(), 100, 5000u64.into()).unwrap());
        assert!(!identity_matches(100, 5000u64.into(), 101, 5000u64.into()).unwrap());
        assert!(!identity_matches(100, 5000u64.into(), 100, 5001u64.into()).unwrap());
    }

    #[test]
    fn compares_boundary_pids_and_full_width_creation_times() {
        assert!(identity_matches(0, 0u64.into(), 0, 0u64.into()).unwrap());
        assert!(identity_matches(u32::MAX, u64::MAX.into(), u32::MAX, u64::MAX.into()).unwrap());
        assert!(!identity_matches(
            1,
            133_700_000_000_000_001u64.into(),
            1,
            133_700_000_000_000_002u64.into()
        )
        .unwrap());
    }

    #[test]
    fn connects_to_real_server_and_closes_pipe_without_bytes() {
        let (name, server) = fixture();
        let process = open_process(std::process::id()).unwrap();
        let created = creation_time(&process).unwrap();
        let mut task = ConnectTask::new(name, std::process::id(), created, 1000);
        let mut verified = task.compute().unwrap();
        assert!(verified.is_alive().unwrap());
        assert_no_bytes(&server);
        verified.close();
        verified.close();
        assert!(!verified.is_alive().unwrap());
    }

    #[test]
    fn rejects_wrong_pid_and_creation_time_before_protocol_bytes() {
        let process = open_process(std::process::id()).unwrap();
        let created = creation_time(&process).unwrap();
        for (pid, time) in [
            (std::process::id() ^ 1, created),
            (std::process::id(), created + 1),
        ] {
            let (name, server) = fixture();
            let error = ConnectTask::new(name, pid, time, 1000)
                .compute()
                .err()
                .unwrap();
            assert_eq!(
                error.reason,
                "ServerIdentityMismatch: PID or creation FILETIME differs"
            );
            assert_no_bytes(&server);
        }
    }

    #[test]
    fn missing_and_closed_pipe_fail_cleanly_and_zero_deadline_expires() {
        let (name, server) = fixture();
        drop(server);
        let error = ConnectTask::new(name.clone(), 1, 1, 100)
            .compute()
            .err()
            .unwrap();
        assert!(error
            .reason
            .starts_with("PipeConnectionRefused: CreateFileW"));
        let error = ConnectTask::new(name, 1, 1, 0).compute().err().unwrap();
        assert_eq!(
            error.reason,
            "PipeConnectTimeout: connection deadline expired"
        );
    }

    #[test]
    fn retained_liveness_observes_actual_process_exit() {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tests::liveness_child", "--ignored"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let mut verified = VerifiedServer {
            process: Some(open_process(child.id()).unwrap()),
            reader: None,
            writer: None,
        };
        assert!(verified.is_alive().unwrap());
        child.stdin.take().unwrap().write_all(b"exit\n").unwrap();
        assert!(child.wait().unwrap().success());
        assert!(!verified.is_alive().unwrap());
        verified.close();
    }

    #[test]
    #[ignore = "subprocess fixture; invoked by retained_liveness_observes_actual_process_exit"]
    fn liveness_child() {
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
    }
}
