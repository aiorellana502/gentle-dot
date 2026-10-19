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
origins or URLs are included in these diagnostic lines. Existing ordinary logs are
not a sanitized diagnostic export.

This instrumentation does not change authentication, origins, retries or timeouts.
It does not establish the cause of the earlier intermittent black-panel failure.
