//! Windows lifecycle for an owned daemon and retained-peer-verified duplex channel.
//! Foreign daemons are refused, never adopted or terminated. Orphan recovery is not supported.

use crate::app_channel::{AppChannel, Handler};
use crate::health::check_health;
use crate::isolated_bootstrap_windows::ServerEndpoint;
use crate::owned_process_windows::{current_process_identity, OwnedProcess};
use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const HEALTH_TIMEOUT: Duration = Duration::from_millis(300);
const BOOTSTRAP_MS: u32 = 5000;
const DEV_ALLOWED_ORIGINS: &str = r#"["http://127.0.0.1:5173","http://localhost:5173"]"#;

#[derive(Debug, PartialEq, Eq)]
pub enum RestartOutcome {
    Restarted,
    External,
    Failed(String),
}

#[derive(Debug, PartialEq, Eq)]
struct LaunchSpec {
    program: OsString,
    args: Vec<OsString>,
    envs: Vec<(OsString, OsString)>,
}

// Only development/build-recorded paths are supported. No Windows bundle layout is assumed.
fn launch_spec(env: impl Fn(&str) -> Option<OsString>, dev: bool) -> LaunchSpec {
    let pick = |key: &str, fallback: &str| {
        env(key)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| fallback.into())
    };
    let mut envs = vec![("PATH".into(), env!("GENTLE_DOT_BUILD_PATH").into())];
    if dev {
        envs.push((
            "GENTLE_DOT_ALLOWED_ORIGINS".into(),
            DEV_ALLOWED_ORIGINS.into(),
        ));
    }
    LaunchSpec {
        program: pick("GENTLE_DOT_NODE", env!("GENTLE_DOT_BUILD_NODE")),
        args: vec![pick(
            "GENTLE_DOT_DAEMON_SCRIPT",
            env!("GENTLE_DOT_BUILD_DAEMON_SCRIPT"),
        )],
        envs,
    }
}

// Win32 process/job handles are movable between threads, with no thread-affine API or
// borrowed storage in OwnedProcess. Do not make the primitive globally Send/Sync:
// this wrapper is private, never exposes its owner, and every access is serialized
// by Daemon::owned. Sync is deliberately not implemented for this wrapper.
struct ChildOwner(OwnedProcess);
unsafe impl Send for ChildOwner {}

impl Drop for ChildOwner {
    fn drop(&mut self) {
        if let Err(error) = self.0.stop() {
            eprintln!("gentle-dot: cannot stop the owned assistant job: {error}");
        }
        // stop is asynchronous. Settle the immediate process before returning when
        // possible; OwnedProcess's job-close fallback remains armed on any error.
        if let Err(error) = self.0.wait(BOOTSTRAP_MS) {
            eprintln!("gentle-dot: cannot wait for the owned assistant: {error}");
        }
    }
}

#[derive(Default)]
struct Owned {
    child: Option<ChildOwner>,
    channel: Option<Arc<AppChannel>>,
}

impl Drop for Owned {
    fn drop(&mut self) {
        if let Some(channel) = self.channel.take() {
            channel.close();
        }
        self.child.take();
    }
}

pub struct Daemon {
    port: u16,
    data_dir: PathBuf,
    lifecycle: Mutex<()>,
    owned: Mutex<Owned>,
    handler: Option<Arc<dyn Handler>>,
    ready: Option<Arc<dyn Fn() + Send + Sync>>,
    refused: Mutex<Option<String>>,
    #[cfg(test)]
    launch: Option<LaunchSpec>,
    #[cfg(test)]
    health: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    #[cfg(test)]
    observed: Mutex<Option<crate::owned_process_windows::RetainedIdentity>>,
}

impl Daemon {
    pub fn new(port: u16, data_dir: PathBuf, _runtime_dir: Option<PathBuf>) -> Self {
        Self {
            port,
            data_dir,
            lifecycle: Mutex::new(()),
            owned: Mutex::new(Owned::default()),
            handler: None,
            ready: None,
            refused: Mutex::new(None),
            #[cfg(test)]
            launch: None,
            #[cfg(test)]
            health: None,
            #[cfg(test)]
            observed: Mutex::new(None),
        }
    }

    pub fn with_channel(mut self, handler: Arc<dyn Handler>) -> Self {
        self.handler = Some(handler);
        self
    }

    pub fn on_ready(mut self, ready: Arc<dyn Fn() + Send + Sync>) -> Self {
        self.ready = Some(ready);
        self
    }

    #[cfg(test)]
    fn with_launch(mut self, launch: LaunchSpec) -> Self {
        self.launch = Some(launch);
        self
    }

    #[cfg(test)]
    fn with_health(mut self, health: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        self.health = Some(health);
        self
    }

    pub fn channel(&self) -> Option<Arc<AppChannel>> {
        let owned = self.owned.lock().unwrap();
        if !owned
            .child
            .as_ref()
            .is_some_and(|child| matches!(child.0.wait(0), Ok(None)))
        {
            return None;
        }
        owned.channel.clone().filter(|channel| channel.is_open())
    }

    pub fn owns_running(&self) -> bool {
        self.owned
            .lock()
            .unwrap()
            .child
            .as_ref()
            .is_some_and(|child| matches!(child.0.wait(0), Ok(None)))
    }

    fn spawn(&self) -> io::Result<()> {
        #[cfg(test)]
        if let Some(spec) = &self.launch {
            return self.spawn_spec(spec, BOOTSTRAP_MS);
        }
        self.spawn_spec(
            &launch_spec(|key| std::env::var_os(key), cfg!(debug_assertions)),
            BOOTSTRAP_MS,
        )
    }

    fn spawn_spec(&self, spec: &LaunchSpec, timeout_ms: u32) -> io::Result<()> {
        let handler = self.handler.as_ref().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::Unsupported,
                "the Windows assistant requires a private channel handler",
            )
        })?;
        // Serialize the entire attempt with stop and other spawn attempts. A child
        // is not published until both identity verification and channel startup succeed.
        let mut owned = self.owned.lock().unwrap();
        if owned
            .child
            .as_ref()
            .is_some_and(|child| matches!(child.0.wait(0), Ok(None)))
        {
            return Ok(());
        }
        drop(std::mem::take(&mut *owned));
        let context = |stage: &str, error: io::Error| {
            io::Error::new(error.kind(), format!("{stage}: {error}"))
        };
        let endpoint = ServerEndpoint::create()
            .map_err(|error| context("cannot create the assistant's channel", error))?;
        let (pid, created) = current_process_identity()
            .map_err(|error| context("cannot identify the desktop process", error))?;
        let mut args = spec.args.clone();
        args.extend([
            OsString::from("--app-channel-named-pipe"),
            OsString::from(endpoint.name()),
            OsString::from("--app-channel-named-pipe-server-pid"),
            pid.to_string().into(),
            OsString::from("--app-channel-named-pipe-server-created-at"),
            created.to_string().into(),
            OsString::from("--app-channel-named-pipe-timeout-ms"),
            timeout_ms.to_string().into(),
        ]);
        // Include process creation in Rust's deadline. Node receives the same
        // duration explicitly; Rust remains the outer, authoritative deadline.
        let deadline = Instant::now() + Duration::from_millis(timeout_ms.into());
        let mut envs = spec.envs.clone();
        // Windows's crypto providers (what Node's own startup uses to seed its
        // CSPRNG) resolve system DLLs through SystemRoot; an explicit replacement
        // environment without it aborts the child before it can run anything.
        // This is a required OS variable, not ambient-credential inheritance.
        if let Some(system_root) = std::env::var_os("SystemRoot") {
            envs.push(("SystemRoot".into(), system_root));
        }
        // The embedded agent (gentle-shell) resolves its own home through
        // USERPROFILE on Windows; without it, its own system detection fails
        // before it can run, same as SystemRoot above.
        if let Some(user_profile) = std::env::var_os("USERPROFILE") {
            envs.push(("USERPROFILE".into(), user_profile));
        }
        envs.push(("GENTLE_DOT_PORT".into(), self.port.to_string().into()));
        envs.push((
            "GENTLE_DOT_DATA_DIR".into(),
            self.data_dir.clone().into_os_string(),
        ));
        let child = ChildOwner(OwnedProcess::spawn(&spec.program, &args, &envs).map_err(
            |error| {
                context(
                    "cannot start the assistant (GENTLE_DOT_NODE must name an absolute executable)",
                    error,
                )
            },
        )?);
        #[cfg(test)]
        {
            *self.observed.lock().unwrap() = Some(child.0.retained_identity()?);
        }
        let identity = child
            .0
            .retained_identity()
            .map_err(|error| context("cannot retain the assistant's identity", error))?;
        let verified = endpoint
            .accept_owned(identity, deadline)
            .map_err(|error| context("cannot authenticate the assistant's channel", error))?;
        let (reader, writer) = verified
            .into_duplex()
            .map_err(|error| context("cannot open the assistant's duplex channel", error))?;
        let channel = AppChannel::start_duplex(reader, writer, handler.clone())
            .map_err(|error| context("cannot start the assistant's channel", error))?;
        owned.child = Some(child);
        owned.channel = Some(channel.clone());
        // No application callback runs under the ownership lock.
        drop(owned);
        handler.opened(&channel);
        Ok(())
    }

    pub fn is_healthy(&self) -> bool {
        #[cfg(test)]
        if let Some(health) = &self.health {
            return health();
        }
        check_health(self.port, HEALTH_TIMEOUT)
    }

    pub fn refusal(&self) -> Option<String> {
        self.refused.lock().unwrap().clone()
    }

    /// HTTP health alone never establishes ownership or channel authentication.
    pub fn wait_ready(&self, timeout: Duration) -> Result<(), String> {
        let started = Instant::now();
        loop {
            if let Some(reason) = self.refusal() {
                return Err(reason);
            }
            if self.channel().is_some() && self.is_healthy() {
                return Ok(());
            }
            if started.elapsed() >= timeout {
                return Err(format!(
                    "the assistant did not answer on port {}",
                    self.port
                ));
            }
            std::thread::sleep(
                Duration::from_millis(50).min(timeout.saturating_sub(started.elapsed())),
            );
        }
    }

    /// Polls HTTP health only; callers must use wait_ready for authenticated readiness.
    pub fn wait_healthy(&self, timeout: Duration) -> bool {
        let started = Instant::now();
        loop {
            if self.is_healthy() {
                return true;
            }
            if started.elapsed() >= timeout {
                return false;
            }
            std::thread::sleep(
                Duration::from_millis(50).min(timeout.saturating_sub(started.elapsed())),
            );
        }
    }

    /// Blocking: call off the main thread. Failed readiness tears down this attempt.
    pub fn ensure_running(&self, timeout: Duration) -> Result<(), String> {
        {
            let _lifecycle = self.lifecycle.lock().unwrap();
            self.start(timeout)?;
        }
        if let Some(ready) = &self.ready {
            ready();
        }
        Ok(())
    }

    // Caller holds lifecycle, serializing the health/ownership decision with stop/restart.
    fn start(&self, timeout: Duration) -> Result<(), String> {
        *self.refused.lock().unwrap() = None;
        if !self.owns_running() && self.is_healthy() {
            let reason = foreign_daemon_message(self.port);
            *self.refused.lock().unwrap() = Some(reason.clone());
            return Err(reason);
        }
        if self.owns_running() && self.channel().is_none() {
            self.stop_owned();
        }
        self.spawn().map_err(|error| error.to_string())?;
        if let Err(error) = self.wait_ready(timeout) {
            self.stop_owned();
            return Err(error);
        }
        Ok(())
    }

    /// Closes the owned channel and terminates only this instance's owned job.
    pub fn stop(&self) {
        let _lifecycle = self.lifecycle.lock().unwrap();
        self.stop_owned();
    }

    fn stop_owned(&self) {
        let mut slot = self.owned.lock().unwrap();
        drop(std::mem::take(&mut *slot));
    }

    pub fn restart(&self, timeout: Duration) -> RestartOutcome {
        let result = {
            let _lifecycle = self.lifecycle.lock().unwrap();
            self.stop_owned();
            self.start(timeout)
        };
        match result {
            Ok(()) => {
                if let Some(ready) = &self.ready {
                    ready();
                }
                RestartOutcome::Restarted
            }
            Err(_) if self.refusal().is_some() => RestartOutcome::External,
            Err(reason) => RestartOutcome::Failed(reason),
        }
    }
}

pub fn runtime_dir(
    env: impl Fn(&str) -> Option<String>,
    resource_dir: Option<PathBuf>,
) -> Option<PathBuf> {
    env("GENTLE_DOT_RUNTIME_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| resource_dir.map(|dir| dir.join("runtime")))
}

pub fn foreign_daemon_message(port: u16) -> String {
    format!("Another Gentle Dot assistant is already running on port {port}, and this app did not start it. Stop the other assistant, then choose \"Restart assistant\" in the Gentle Dot menu. This app neither adopts nor stops external assistants.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approvals::ApprovalRequest;
    use serde_json::{json, Value};
    use std::io::{BufRead, BufReader, Write};
    use std::os::windows::io::FromRawHandle;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::Storage::FileSystem::*;
    use windows_sys::Win32::System::Pipes::GetNamedPipeServerProcessId;
    use windows_sys::Win32::System::Threading::*;

    #[derive(Default)]
    struct Opened(AtomicUsize, Mutex<std::sync::Weak<AppChannel>>);
    impl Handler for Opened {
        fn approve(&self, _: &ApprovalRequest) -> bool {
            false
        }
        fn opened(&self, channel: &Arc<AppChannel>) {
            *self.1.lock().unwrap() = Arc::downgrade(channel);
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn fixture_spec(role: &str) -> LaunchSpec {
        LaunchSpec {
            program: std::env::current_exe().unwrap().into_os_string(),
            // After --, libtest treats the private flags as additional filters,
            // not harness options. The exact fixture filter still selects the child.
            args: [
                "--exact",
                "daemon::tests::windows_daemon_fixture",
                "--nocapture",
                "--",
            ]
            .into_iter()
            .map(Into::into)
            .collect(),
            envs: vec![("DAEMON_FIXTURE_ROLE".into(), role.into())],
        }
    }

    #[test]
    fn windows_daemon_launch_selection() {
        let spec = launch_spec(|_| None, false);
        assert_eq!(spec.program, OsString::from(env!("GENTLE_DOT_BUILD_NODE")));
        assert_eq!(
            spec.args,
            vec![OsString::from(env!("GENTLE_DOT_BUILD_DAEMON_SCRIPT"))]
        );
        assert_eq!(
            spec.envs,
            vec![("PATH".into(), env!("GENTLE_DOT_BUILD_PATH").into())]
        );
        let spec = launch_spec(
            |key| match key {
                "GENTLE_DOT_NODE" => Some(r"C:\custom\node.exe".into()),
                "GENTLE_DOT_DAEMON_SCRIPT" => Some(r"C:\custom\cli.ts".into()),
                _ => None,
            },
            true,
        );
        assert_eq!(spec.program, OsString::from(r"C:\custom\node.exe"));
        assert_eq!(spec.args, vec![OsString::from(r"C:\custom\cli.ts")]);
        assert_eq!(
            spec.envs[1],
            (
                "GENTLE_DOT_ALLOWED_ORIGINS".into(),
                DEV_ALLOWED_ORIGINS.into()
            )
        );
        assert_eq!(
            launch_spec(|_| Some(OsString::new()), false),
            launch_spec(|_| None, false)
        );
    }

    #[test]
    fn windows_daemon_composition_round_trip_and_stop() {
        fn require_thread_safe<T: Send + Sync>() {}
        require_thread_safe::<Daemon>();
        let handler = Arc::new(Opened::default());
        let daemon = Daemon::new(1, PathBuf::new(), None).with_channel(handler.clone());
        assert!(!daemon.owns_running());
        assert!(daemon.channel().is_none());
        daemon
            .spawn_spec(&fixture_spec("echo"), BOOTSTRAP_MS)
            .unwrap();
        let channel = daemon.channel().expect("verified channel");
        assert!(daemon.owns_running());
        assert_eq!(handler.0.load(Ordering::SeqCst), 1);
        assert_eq!(
            channel.request("echo", json!({"value":7}), Duration::from_secs(5)),
            Ok(json!({"value":7}))
        );
        // Repeated private demand does not replace a live child or reopen the handler.
        let pid = daemon
            .observed
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .live_pid()
            .unwrap();
        daemon
            .spawn_spec(&fixture_spec("dead"), BOOTSTRAP_MS)
            .unwrap();
        assert_eq!(
            daemon
                .observed
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .live_pid()
                .unwrap(),
            pid
        );
        assert_eq!(handler.0.load(Ordering::SeqCst), 1);
        let stopping = Instant::now();
        daemon.stop();
        assert!(stopping.elapsed() < Duration::from_secs(5));
        daemon.stop();
        assert!(!daemon.owns_running());
        assert!(daemon.channel().is_none());
        assert!(!channel.is_open());
        assert!(daemon
            .observed
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .live_pid()
            .is_err());
        let deadline = Instant::now() + Duration::from_secs(5);
        while Arc::strong_count(&channel) != 1 {
            assert!(
                Instant::now() < deadline,
                "channel workers retained handles after stop"
            );
            std::thread::yield_now();
        }
    }

    // Only real-Node composition test in this file: every other test above spawns the
    // compiled test binary itself under a fixture role (fixture_spec), never the
    // production launch_spec target. This proves the build's own recorded Node/CLI
    // launch spec, a real provider-free agent, and the public ensure_running start path
    // (not the internal spawn_spec test hook the fixture tests use) compose end to end:
    // bilateral identity auth, the duplex AppChannel, and HTTP /health all pass against
    // the real packages/daemon CLI.
    #[test]
    fn windows_daemon_real_node_chat_round_trip() {
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .expect("repo root")
            .to_path_buf();
        let fake_agent = repo_root.join("packages/daemon/test/fixtures/fake-agent.ts");
        assert!(
            fake_agent.is_file(),
            "missing fixture: {}",
            fake_agent.display()
        );
        let node = OsString::from(env!("GENTLE_DOT_BUILD_NODE"));
        let data_dir = std::env::temp_dir().join(format!(
            "gentle-dot-windows-daemon-real-node-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&data_dir);
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let handler = Arc::new(Opened::default());
        let daemon = Daemon::new(port, data_dir.clone(), None)
            .with_channel(handler.clone())
            .with_launch(LaunchSpec {
                program: node.clone(),
                args: vec![OsString::from(env!("GENTLE_DOT_BUILD_DAEMON_SCRIPT"))],
                envs: vec![
                    ("PATH".into(), env!("GENTLE_DOT_BUILD_PATH").into()),
                    ("GENTLE_DOT_AGENT_BIN".into(), node),
                    (
                        "GENTLE_DOT_AGENT_ARGS".into(),
                        json!([fake_agent.to_str().unwrap()]).to_string().into(),
                    ),
                    // This test proves the pipe/channel composition, not gentle-shell's own
                    // first-run companion-package install, which hits the network and would
                    // make this test slow and flaky.
                    ("GENTLE_SHELL_NO_AUTO_SETUP".into(), "1".into()),
                ],
            });
        daemon
            .ensure_running(Duration::from_secs(20))
            .expect("the real Node daemon should start, authenticate and answer /health");
        let channel = daemon
            .channel()
            .expect("verified channel over the real named pipe");
        assert_eq!(handler.0.load(Ordering::SeqCst), 1);
        // computer_unregister is a real production app-channel method (connectors.ts); with no
        // computer ever registered by this channel it is a safe no-op that still proves the
        // real daemon parsed and dispatched a request over the real transport.
        assert_eq!(
            channel.request("computer_unregister", json!({}), Duration::from_secs(5)),
            Ok(json!({}))
        );
        daemon.stop();
        assert!(!daemon.owns_running());
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn windows_daemon_composition_failures_close_owned_process() {
        for role in ["dead", "no-connect", "wrong-peer"] {
            let handler = Arc::new(Opened::default());
            let daemon = Daemon::new(1, PathBuf::new(), None).with_channel(handler.clone());
            let error = daemon.spawn_spec(&fixture_spec(role), 1000).unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("cannot authenticate the assistant's channel"),
                "{role}: {error}"
            );
            assert!(!daemon.owns_running());
            assert!(daemon.channel().is_none());
            assert_eq!(handler.0.load(Ordering::SeqCst), 0);
            assert!(
                daemon
                    .observed
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .live_pid()
                    .is_err(),
                "{role}: failed spawn leaked child"
            );
        }
    }

    #[test]
    fn windows_daemon_drop_terminates_child() {
        let daemon = Daemon::new(1, PathBuf::new(), None).with_channel(Arc::new(Opened::default()));
        daemon
            .spawn_spec(&fixture_spec("echo"), BOOTSTRAP_MS)
            .unwrap();
        let identity = daemon.observed.lock().unwrap().take().unwrap();
        assert!(identity.live_pid().is_ok());
        drop(daemon);
        assert!(identity.live_pid().is_err());
    }

    #[test]
    fn windows_daemon_owned_lifecycle_and_restart() {
        let handler = Arc::new(Opened::default());
        let health = handler.clone();
        let ready = Arc::new(AtomicUsize::new(0));
        let announced = ready.clone();
        let daemon = Daemon::new(1, PathBuf::from(r"C:\isolated-lifecycle"), None)
            .with_channel(handler.clone())
            .with_launch(fixture_spec("echo"))
            .with_health(Arc::new(move || {
                health
                    .1
                    .lock()
                    .unwrap()
                    .upgrade()
                    .is_some_and(|channel| channel.is_open())
            }))
            .on_ready(Arc::new(move || {
                announced.fetch_add(1, Ordering::SeqCst);
            }));
        assert_eq!(daemon.ensure_running(Duration::from_secs(2)), Ok(()));
        assert!(daemon.owns_running());
        assert!(daemon.channel().is_some());
        assert!(daemon.is_healthy());
        assert!(daemon.wait_healthy(Duration::ZERO));
        assert_eq!(daemon.wait_ready(Duration::ZERO), Ok(()));
        let identity = daemon.observed.lock().unwrap().take().unwrap();
        assert_eq!(daemon.ensure_running(Duration::ZERO), Ok(()));
        assert_eq!(handler.0.load(Ordering::SeqCst), 1);
        assert_eq!(ready.load(Ordering::SeqCst), 2);
        assert_eq!(
            daemon.restart(Duration::from_secs(2)),
            RestartOutcome::Restarted
        );
        assert!(identity.live_pid().is_err());
        assert_eq!(handler.0.load(Ordering::SeqCst), 2);
        assert_eq!(ready.load(Ordering::SeqCst), 3);
        daemon.stop();
        assert!(!daemon.owns_running());
        assert!(daemon.channel().is_none());
        assert!(daemon.wait_ready(Duration::ZERO).is_err());
    }

    #[test]
    fn windows_daemon_refuses_foreign_health_without_spawning() {
        let daemon = Daemon::new(4317, PathBuf::new(), None)
            .with_channel(Arc::new(Opened::default()))
            .with_launch(fixture_spec("echo"))
            .with_health(Arc::new(|| true))
            .on_ready(Arc::new(|| panic!("foreign health is not readiness")));
        let expected = foreign_daemon_message(4317);
        assert_eq!(daemon.ensure_running(Duration::ZERO), Err(expected.clone()));
        assert_eq!(daemon.refusal(), Some(expected.clone()));
        assert_eq!(daemon.wait_ready(Duration::ZERO), Err(expected));
        assert_eq!(daemon.restart(Duration::ZERO), RestartOutcome::External);
        assert!(daemon.observed.lock().unwrap().is_none());
        assert!(!daemon.owns_running());
        assert!(daemon.channel().is_none());
        daemon.stop();
        assert!(daemon.is_healthy());
    }

    #[test]
    fn windows_daemon_failed_readiness_cleans_owned_child() {
        let daemon = Daemon::new(1, PathBuf::new(), None)
            .with_channel(Arc::new(Opened::default()))
            .with_launch(fixture_spec("echo"))
            .with_health(Arc::new(|| false))
            .on_ready(Arc::new(|| panic!("failed startup is not ready")));
        assert!(!daemon.wait_healthy(Duration::ZERO));
        assert_eq!(
            daemon.ensure_running(Duration::ZERO),
            Err("the assistant did not answer on port 1".into())
        );
        assert!(!daemon.owns_running());
        assert!(daemon.channel().is_none());
        assert!(daemon
            .observed
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .live_pid()
            .is_err());
        assert_eq!(daemon.refusal(), None);
        assert_eq!(
            daemon.restart(Duration::ZERO),
            RestartOutcome::Failed("the assistant did not answer on port 1".into())
        );
    }

    #[test]
    fn windows_runtime_path_selection_does_not_require_a_runtime() {
        assert_eq!(runtime_dir(|_| None, None), None);
        assert_eq!(
            runtime_dir(|_| None, Some("resources".into())),
            Some(PathBuf::from("resources/runtime"))
        );
        assert_eq!(runtime_dir(|_| Some(String::new()), None), None);
        assert_eq!(
            runtime_dir(|_| Some("custom".into()), None),
            Some("custom".into())
        );
    }

    // Real executable fixture. No production Node, GUI, credentials, files, or sockets.
    #[test]
    fn windows_daemon_fixture() {
        let Ok(role) = std::env::var("DAEMON_FIXTURE_ROLE") else {
            return;
        };
        if role == "dead" {
            return;
        }
        let args: Vec<String> = std::env::args().collect();
        let value = |flag: &str| args[args.iter().position(|arg| arg == flag).unwrap() + 1].clone();
        let name = value("--app-channel-named-pipe");
        let pid: u32 = value("--app-channel-named-pipe-server-pid")
            .parse()
            .unwrap();
        let created: u64 = value("--app-channel-named-pipe-server-created-at")
            .parse()
            .unwrap();
        let timeout: u32 = value("--app-channel-named-pipe-timeout-ms")
            .parse()
            .unwrap();
        assert!(timeout > 0);
        if role == "wrong-peer" {
            let mut spec = fixture_spec("intruder");
            let flags = args
                .iter()
                .position(|arg| arg == "--app-channel-named-pipe")
                .unwrap();
            spec.args.extend(args[flags..].iter().map(OsString::from));
            let child = OwnedProcess::spawn(&spec.program, &spec.args, &spec.envs).unwrap();
            let _ = child.wait(30_000);
            return;
        }
        if role == "no-connect" {
            std::thread::sleep(Duration::from_secs(30));
            return;
        }
        let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let raw = unsafe {
            CreateFileW(
                name.as_ptr(),
                FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(raw, INVALID_HANDLE_VALUE, "{}", io::Error::last_os_error());
        let mut writer = unsafe { std::fs::File::from_raw_handle(raw) };
        if role == "intruder" {
            // This is not the retained child. Rust must disconnect it before any
            // protocol is possible; the owning job bounds this descendant's life.
            std::thread::sleep(Duration::from_secs(30));
            return;
        }
        // Minimal stand-in for Node's addon: independently check the actual pipe
        // server PID and a live process handle's creation FILETIME before any frames.
        let mut actual_pid = 0;
        assert_ne!(
            unsafe { GetNamedPipeServerProcessId(raw, &mut actual_pid) },
            0
        );
        assert_eq!(actual_pid, pid);
        let server = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                0,
                actual_pid,
            )
        };
        assert!(!server.is_null());
        let server = unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(server) };
        use std::os::windows::io::AsRawHandle;
        let mut creation: FILETIME = unsafe { std::mem::zeroed() };
        let (mut exit, mut kernel, mut user) = (creation, creation, creation);
        assert_ne!(
            unsafe {
                GetProcessTimes(
                    server.as_raw_handle(),
                    &mut creation,
                    &mut exit,
                    &mut kernel,
                    &mut user,
                )
            },
            0
        );
        assert_eq!(
            ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64,
            created
        );
        assert_eq!(
            unsafe { WaitForSingleObject(server.as_raw_handle(), 0) },
            WAIT_TIMEOUT
        );
        let mut reader = BufReader::new(writer.try_clone().unwrap());
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            let frame: Value = serde_json::from_str(&line).unwrap();
            if writeln!(
                writer,
                "{}",
                json!({"kind":"response","id":frame["id"],"result":frame["params"]})
            )
            .is_err()
            {
                return;
            }
            // Ignore channel closure after the response: stop must terminate the
            // actual job, not merely rely on cooperative shutdown at pipe EOF.
            std::thread::sleep(Duration::from_secs(30));
            return;
        }
    }
}
