//! Fixed-schema evidence only: never accepts connection data, errors or raw window labels.
use std::sync::Mutex;
use std::time::Instant;

#[derive(Clone, Copy, Default, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Source {
    Initial,
    ListenerRecheck,
    AssistantReady,
    #[default]
    Unspecified,
}
impl Source {
    fn label(self) -> &'static str {
        match self {
            Self::Initial => "initial", Self::ListenerRecheck => "listener_recheck",
            Self::AssistantReady => "assistant_ready", Self::Unspecified => "unspecified",
        }
    }
}
#[derive(Clone, Copy)]
pub(crate) enum Window { Panel, Dot, Other }
impl Window {
    fn label(self) -> &'static str {
        match self { Self::Panel => "panel", Self::Dot => "dot", Self::Other => "other" }
    }
}
#[derive(Clone, Copy)]
pub(crate) enum Phase { Begin, Ok, Fail }
impl Phase {
    fn label(self) -> &'static str {
        match self { Self::Begin => "begin", Self::Ok => "ok", Self::Fail => "fail" }
    }
}
fn line(seq: u64, call: u64, window: Window, source: Source, phase: Phase, elapsed: u128) -> String {
    format!("[startup-diagnostics] panel seq={seq} call={call} window={} source={} phase={} elapsed_ms={elapsed}", window.label(), source.label(), phase.label())
}
fn ready_line(seq: u64, ok: bool, elapsed: u128) -> String {
    format!("[startup-diagnostics] ready_event seq={seq} phase={} elapsed_ms={elapsed}", if ok { "emitted" } else { "fail" })
}
struct Clock { start: Instant, seq: u64 }
static CLOCK: Mutex<Option<Clock>> = Mutex::new(None);
fn emit(make: impl FnOnce(u64, u128) -> String) -> Option<u64> {
    if std::env::var_os("GENTLE_DOT_STARTUP_DIAGNOSTICS").as_deref() != Some(std::ffi::OsStr::new("1")) { return None; }
    // Serialize numbering and writes, so native output order agrees with seq.
    let mut clock = CLOCK.lock().ok()?;
    let clock = clock.get_or_insert_with(|| Clock { start: Instant::now(), seq: 0 });
    clock.seq = clock.seq.checked_add(1)?;
    eprintln!("{}", make(clock.seq, clock.start.elapsed().as_millis()));
    Some(clock.seq)
}
pub(crate) struct Attempt { call: Option<u64>, window: Window, source: Source }
impl Attempt {
    pub(crate) fn begin(window: Window, source: Source) -> Self {
        let call = emit(|seq, elapsed| line(seq, seq, window, source, Phase::Begin, elapsed));
        Self { call, window, source }
    }
    pub(crate) fn finish(self, ok: bool) {
        if let Some(call) = self.call {
            emit(|seq, elapsed| line(seq, call, self.window, self.source, if ok { Phase::Ok } else { Phase::Fail }, elapsed));
        }
    }
}
pub(crate) fn ready_emitted(ok: bool) { emit(|seq, elapsed| ready_line(seq, ok, elapsed)); }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_schema_and_default_source() {
        assert_eq!(line(1, 1, Window::Panel, Source::default(), Phase::Begin, 0), "[startup-diagnostics] panel seq=1 call=1 window=panel source=unspecified phase=begin elapsed_ms=0");
        assert_eq!(line(3, 1, Window::Dot, Source::AssistantReady, Phase::Fail, 20), "[startup-diagnostics] panel seq=3 call=1 window=dot source=assistant_ready phase=fail elapsed_ms=20");
        assert_eq!(line(4, 2, Window::Other, Source::ListenerRecheck, Phase::Ok, 21), "[startup-diagnostics] panel seq=4 call=2 window=other source=listener_recheck phase=ok elapsed_ms=21");
        assert_eq!(ready_line(2, true, 10), "[startup-diagnostics] ready_event seq=2 phase=emitted elapsed_ms=10");
        assert_eq!(ready_line(5, false, 22), "[startup-diagnostics] ready_event seq=5 phase=fail elapsed_ms=22");
    }
}
