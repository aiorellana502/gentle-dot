# Open the existing local Windows app

For a separate contributor profile, use the
[Windows contributor preview](windows-contributor-preview.md), not this owner's
preserved-profile launcher. The offline build prerequisites below still apply.

Build once, then double-click `scripts/windows/local-launch.cmd`. Opening never
builds, installs dependencies, starts Vite, or changes the selected login profile.
This is a repository-local app, **not a portable executable or installer**.

## Build once

From the repository root, with Node.js 24+ and the existing dependencies available:

```text
node scripts/windows/local-build.mjs
```

The builder uses the installed Vite and Tauri JavaScript CLIs, stable MSVC Rust
binaries under `%USERPROFILE%\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin`,
and a copy of `%USERPROFILE%\.cargo\registry`. It does not load user Cargo config.
Existing MSVC/Windows SDK tools must be discoverable on PATH. Existing sherpa
libraries must be in `apps/desktop/src-tauri/target/sherpa-onnx-prebuilt/sherpa-onnx-v1.13.8-win-x64-static-MT-Release-lib/lib`.
Missing prerequisites stop the build; no download or installation is attempted.
Cargo runs offline and locked. Registry copy, build home, target and scratch
files stay under `.cache/windows-local`. The frontend uses the ordinary ignored
`packages/ui/dist/app` output, also used by the daemon's local web interface.
Tauri keeps its ordinary relative `frontendDist` configuration: an absolute Windows
path can be interpreted as an opaque URL rather than an embedded frontend directory.
Only `beforeBuildCommand` is cleared to avoid building the frontend twice.

Tauri builds Debug with `custom-protocol`, embedding the frontend without Vite;
no bundle is produced. Cargo's default features and ordinary dev workflow are unchanged.

## Open on subsequent runs

```text
node scripts/windows/local-launch.mjs
```

Or double-click `scripts/windows/local-launch.cmd` (no arguments supported; pauses
on failure). Both open `.cache/windows-local/target/debug/gentle-dot.exe` with
port `4417` and the existing `.cache/chatgpt-pro-validation` data directory.
They do not inspect, reset, or migrate that profile. Keep the repository, built
frontend, Node and installed daemon/pipe-bridge/gentle-pi dependencies in place.
The launcher's home is isolated; ambient provider keys are not forwarded.
`GENTLE_SHELL_NO_AUTO_SETUP=1` suppresses companion auto-installation, not explicit
user-requested app features. Never run build and launch concurrently.

Use `--help` on either Node command for usage. Other arguments are rejected.
If a prerequisite is missing, prepare it separately and rebuild. If another
assistant owns the port, close that instance; this launcher does not terminate it.
A successful process spawn is not proof of daemon readiness or working chat.
Native compilation and a human no-Vite/chat acceptance check are separate steps.

## Diagnostics

[Opt-in startup diagnostics](windows-startup-diagnostics.md) are disabled by the
normal launcher. Never share ordinary logs as if they were sanitized traces.

## Validation scope

The user confirmed the existing last conversation appeared and basic chat worked
in the supervised, instrumented build, with Vite off. Standalone `.cmd` quoting
was tested with synthetic fixtures, not a second real cold-start GUI replay.
The earlier intermittent black-panel/port-4417 failure did not prevent this
accepted run, but its cause has not been demonstrated. Repeated cold starts,
tools, voice and connectors were not validated by this acceptance.
If a startup warning returns, keep the profile intact and report the exact message;
do not reset it or repeat login as a workaround.
