# Capture startup states without secrets

Only an explicitly supervised helper should set `GENTLE_DOT_STARTUP_DIAGNOSTICS=1`
in its environment; the normal launcher does not enable it. Absent or other values
leave diagnostic output off. Native forwards only literal `1` to its owned daemon.

`[startup-diagnostics]` lines contain only fixed phases, safe status enums, booleans
and times: native spawn/auth/channel phases and changed readiness gates, history
subscription/readiness/stopped/60-second timeout, and the existing origin decision.
The native window readiness budget (20 seconds) is distinct from history readiness.
`NOT_EVALUATED` means HTTP health was skipped because the owned channel was unavailable.
No extra health probes are made. No frames, event payloads, keys, config, paths,
origins or URLs are included in these diagnostic lines; a stall names an HTTP entry
only by a fixed route (`health`, `ws`, `upload`, `mcp` or `static`). Existing ordinary logs are
not a sanitized diagnostic export.

This instrumentation does not change authentication, origins, retries or timeouts.
It does not establish the cause of the earlier intermittent black-panel failure.

## Bootstrap failure and optional profiling

Fixed native failures are `spawn_error`, `auth_timeout` (returned `TimedOut`), and
`auth_error` (other authentication errors). Each includes only `elapsed_ms` and
`child_state=running|exited|unknown`. Authentication failure samples the retained
child with a zero-wait status check **before** cleanup terminates its owned job.
`exited` is not an exit-code report or proof of the cause; `unknown` means the status
query failed (or no child was created). The outer 5000 ms deadline, identity checks,
origin policy and owned-job cleanup are unchanged. No retries or extra health probes.

Daemon `bootstrap` phases are `entry`, `pipe_begin`, `pipe_ok`, `pipe_fail`,
`profiler_begin`, `profiler_ready`, `profiler_fail`, with elapsed milliseconds only.
Pipe phases occur only for selected named-pipe startup. Authentication completes
before optional profiler setup. Inspector is loaded lazily only with the exact flag
and an already-existing repo-local `.cache/windows-local/cpu-profiles` folder.
Disabled profiling neither imports inspector nor creates/writes folders. Default
sampling remains 60 seconds. Inspector failures are nonfatal and disconnect sessions.
Profiler elapsed times are relative to profiler setup, not daemon entry.

CPU profiles contain code/module paths and timings and are **not sanitized exports**;
keep them local. Sampling may miss stalls and cannot establish every stall's cause;
no blanket claim about impossible sensitive contents is made. The collector keeps
only allowlisted fixed events, including repeated bootstrap/failure records, within
its existing total 256-event bound; it never retains raw output.

## Same-run panel connection evidence

With the same opt-in flag, native `connection_info` emits fixed whole-line records:

```text
[startup-diagnostics] panel seq=1 call=1 window=panel source=initial phase=begin elapsed_ms=0
[startup-diagnostics] ready_event seq=2 phase=emitted elapsed_ms=100
[startup-diagnostics] panel seq=3 call=1 window=panel source=initial phase=ok elapsed_ms=110
```

`seq` orders native writes; `call` links begin and finish. Times are monotonic
milliseconds since the first panel/ready diagnostic. Window is only `panel`, `dot`,
or `other`; source is only `initial`, `listener_recheck`, `assistant_ready`, or
`unspecified` (existing callers). Connection phases are `begin`, `ok`, `fail`;
ready-event phases are `emitted`, `fail`. No error text or connection data enters
this formatter. An emitted event proves emission completed, not handler receipt.
An `assistant_ready` call identifies a received-event-triggered attempt, not success.

The private safe capture helper accepts only this fixed schema and existing native
phases, retaining at most 256 events with repeated call IDs in arrival order. Native
readiness, failure, and panel results do not stop observation: capture continues
for the bounded 180-second observation or until natural exit (human tray Quit).
This retains initial failure, ready-event emission, and existing event-triggered
recovery attempts in order. After the observation deadline, pipes still drain until
human tray Quit; there is no automatic retry or kill. Summary version 2 separates
`native_status` (`unobserved`, `ready`, `failed`) and `panel_status` (`unobserved`,
`connecting`, `connection_ok`, `connection_fail`). Native status follows fresh native
readiness/failure outcomes; unrelated panel events cannot restore stale readiness.
Panel status and capture outcome retain the latest completed panel result; a new
attempt does not erase an observed failure, but a later successful result records
recovery. Capture success means only the latest completed panel `connection_info`
returned successfully, never that chat rendered. With no completed panel result,
outcome is `incomplete` with reason `panel_result_unobserved`, not an invented app
timeout. `observation_end` distinguishes `observation_deadline` from `app_exit`
(or a fixed collector fault). Frontend and
history remain `unobservable`; no history transport is added. Native 20-second UI,
180-second owned startup, and 60-second history product budgets are unchanged.
