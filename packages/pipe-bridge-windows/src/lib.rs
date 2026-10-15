//! Windows-only native bridge for the app/daemon private channel.
//! 3c.1b verifies without protocol I/O, then closes the pipe. Only the verified process
//! handle survives; 3c.1c will add cancellable duplex ownership. No Unix build is promised.
use napi::bindgen_prelude::{AsyncTask, BigInt};
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::time::{Duration, Instant};
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

/// A retained verified server identity, NOT a usable pipe transport yet.
/// isAlive polls the same kernel process object; it never reopens a potentially reused PID.
/// close is idempotent; GC also releases the handle. A closed identity is not alive.
#[napi]
pub struct VerifiedServer {
    process: Option<OwnedHandle>,
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

    #[napi]
    pub fn close(&mut self) {
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
            // Synchronous handle, NULL security attributes: non-inheritable from creation.
            // No I/O is submitted in this unit. Duplex/overlapped flags belong to 3c.1c.
            let raw = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    0,
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
        let verified = VerifiedServer {
            process: Some(process),
        };
        if !verified.is_alive()? {
            return Err(failure(
                "ServerExited: verified server process is no longer alive",
            ));
        }
        self.check_deadline()?;
        // Required closing stub: success and every error path drop the pipe without any
        // ReadFile/WriteFile. RAII also closes the process on errors or failed task delivery.
        drop(pipe);
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
/// operation-specific prefixes. Success closes the pipe and returns only retained liveness.
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
