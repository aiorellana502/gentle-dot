# Try the unofficial Windows contributor preview

This aiorellana502 fork explores native Windows x64 desktop chat. It is for
contributors with a development toolchain, **not an installer or portable app**.
Original project: [Gentleman-Programming/gentle-dot](https://github.com/Gentleman-Programming/gentle-dot).
Keep the [MIT license and copyright notice](../LICENSE); this fork is not an
upstream release or an endorsement by the original maintainers.

## Readiness before you start

**An isolated-source install/build and later new-profile login/chat/history
succeeded on one existing Windows host. Reliable first cold start and a second
machine are not proven.** The first fresh-profile opening failed; a later
reopening worked. See the [evidence report](windows-preview-validation.md) for
successful stages, original failures and security-review limits.

| Area | Current evidence / limit |
| --- | --- |
| Existing-profile chat/history and early Quit | Accepted manually on the original host; not a latency benchmark |
| Source install, addon, UI, generated icon, desktop | Completed from isolated `cb30721` source with fresh dependency/native caches on the same host; desktop first failed, then succeeded without a correction |
| New local profile | Welcome, own login, ordinary chat and history after Quit/reopen accepted on a later run; first cold opening failed |
| Separate preview environment | Launcher isolates home/data and omits ambient provider keys; synthetic tests are not GUI acceptance |
| Independent Windows machine / toolchain installation | Pending; existing tools were used, not installed by this workflow |
| Voice, Discord, other connectors, tools, computer control, private memory | Outside this acceptance scope |
| Windows installers / portable binaries | Not provided by this workflow |

Do not copy another user's profile, `.cache`, Cargo registry, native target or
prebuilt executable. Use your own test account and disposable workspace without
sensitive documents: the assistant can execute commands and access files.

## Prepare a new checkout and installed tools

The branch source is already available:

```powershell
git clone --branch feat/windows-native-bootstrap https://github.com/aiorellana502/gentle-dot.git
cd gentle-dot
git rev-parse HEAD
```

Record the full commit; the build evidence below used
`cb30721b423f24656adcd9c4c61a8f78d384e510`, not an arbitrary future branch tip.
Use a Windows x64 **Developer PowerShell** with these tools already installed:

- Node.js 24+, pnpm **11.5.0** (repository pin), and Go 1.25.10+ on `PATH`.
- Stable x64 MSVC Rust, Visual Studio C++ tools / Windows SDK and WebView2.
- The observed host had Node 24.13.0, Go 1.26.2, Rust 1.99.0 and MSVC
  14.51.36231. This is not evidence that installing those tools works elsewhere.

Review the lockfiles, dependencies and build scripts first. **Installation and
compilation execute downloaded code**, including `gentle-pi`'s Windows Go
postinstall via the public module proxy/SumDB, and Cargo native build scripts.
Do not skip scripts, update locks, change global settings or disable validation
to force success. Stop at a failed stage; never substitute an old executable.

## Online source-build reference

These PowerShell commands correspond to observed successful stages, **not an
end-to-end tested PowerShell recipe or second-host guarantee**. Run in a new
checkout, with no app using it. Keep build and launch separate. Use a dedicated
terminal: the setup below changes only that process's environment.

### 1. Isolate build state

Resolve the existing tools before changing the home directory. This assumes the
usual stable Rust location; if absent, stop and report the prerequisite rather
than installing or copying it implicitly.

```powershell
$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
# Standalone pnpm installs expose pnpm.exe; npm/Corepack installs expose pnpm.cmd.
$pnpm = (Get-Command pnpm.cmd, pnpm.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (!$pnpm) { throw 'Missing pnpm' }
if ((& $pnpm --version) -ne '11.5.0') { throw 'pnpm 11.5.0 is required (repository pin)' }
$node = (Get-Command node.exe).Source
$rust = Join-Path $env:USERPROFILE '.rustup/toolchains/stable-x86_64-pc-windows-msvc/bin'
if (!(Test-Path "$rust/cargo.exe") -or !(Test-Path "$rust/rustc.exe")) { throw 'Missing stable MSVC Rust' }
# Cargo also reads .cargo/config.toml from every ancestor directory, even with an
# isolated CARGO_HOME; a source replacement there would make the build non-fresh.
$dir = Split-Path $root -Parent
while ($dir) {
  if ((Test-Path "$dir/.cargo/config.toml") -or (Test-Path "$dir/.cargo/config")) {
    throw "Ancestor Cargo config at $dir/.cargo; move the checkout or report it"
  }
  $dir = Split-Path $dir -Parent
}
$state = Join-Path $root '.cache/windows-local'
if (Test-Path $state) { throw 'Use a new checkout; do not overwrite existing build state' }
New-Item -ItemType Directory -Path $state | Out-Null

# Retain OS/compiler discovery, not provider keys or personal build overrides.
$keep = 'PATH','PATHEXT','SystemRoot','WINDIR','COMSPEC','NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE','INCLUDE','LIB','LIBPATH','VCToolsInstallDir',
  'VCINSTALLDIR','VSINSTALLDIR','WindowsSdkDir','WindowsSDKVersion',
  'UniversalCRTSdkDir','UCRTVersion','VSCMD_ARG_TGT_ARCH','VSCMD_ARG_HOST_ARCH'
Get-ChildItem Env: | Where-Object { $_.Name -notin $keep } |
  ForEach-Object { [Environment]::SetEnvironmentVariable($_.Name, $null, 'Process') }
$env:PATH = "$rust;$env:PATH"
$env:RUSTC = "$rust/rustc.exe"
$env:CARGO_HOME = "$state/cargo-home"
$env:CARGO_TARGET_DIR = "$state/target"
$env:HOME = $env:USERPROFILE = "$state/build-home"
$env:HOMEDRIVE = [IO.Path]::GetPathRoot($env:HOME).TrimEnd('\')
$env:HOMEPATH = $env:HOME.Substring($env:HOMEDRIVE.Length)
$env:APPDATA = "$env:HOME/AppData/Roaming"
$env:LOCALAPPDATA = "$env:HOME/AppData/Local"
$env:TEMP = $env:TMP = "$state/tmp"
$env:GOPATH = "$state/go"
$env:GOMODCACHE = "$state/go-mod"
$env:GOCACHE = "$state/go-build"
$env:GOTOOLCHAIN = 'local'
$env:GOENV = 'off'
$env:GENTLE_SHELL_NO_AUTO_SETUP = '1'
$utf8 = [Text.UTF8Encoding]::new($false)
foreach ($dir in @($env:HOME,$env:APPDATA,$env:LOCALAPPDATA,$env:TEMP,$env:CARGO_HOME)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}
$env:NPM_CONFIG_USERCONFIG = "$state/npm-user.conf"
$env:NPM_CONFIG_GLOBALCONFIG = "$state/npm-global.conf"
[IO.File]::WriteAllText($env:NPM_CONFIG_USERCONFIG, '', $utf8)
[IO.File]::WriteAllText($env:NPM_CONFIG_GLOBALCONFIG, '', $utf8)
```

No offline flag or host Sherpa override is set. Cargo and native downloads start
fresh here; the installed Rust/compiler tools remain prerequisites. If your
network needs private credentials, stop rather than putting them in a report.

### 2. Install, build the addon and UI, generate the Windows icon

```powershell
& $pnpm install --frozen-lockfile --store-dir "$state/pnpm-store"
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
& $pnpm --filter @gentle-dot/pipe-bridge-windows build -- --locked
if ($LASTEXITCODE -ne 0) { throw 'Windows addon build failed' }
& $pnpm --filter @gentle-dot/ui build
if ($LASTEXITCODE -ne 0) { throw 'UI build failed' }

$tauri = "$root/apps/desktop/node_modules/@tauri-apps/cli/tauri.js"
$icons = "$state/generated-icons"
$ico = "$root/apps/desktop/src-tauri/icons/icon.ico"
if ((Test-Path $icons) -or (Test-Path $ico)) { throw 'Stop: existing icon/output must not be overwritten' }
& $node $tauri icon "$root/apps/desktop/src-tauri/icons/source.png" --output $icons
if ($LASTEXITCODE -ne 0) { throw 'Icon generation failed' }
[IO.File]::Copy("$icons/icon.ico", $ico, $false)
```

The tracked 1024×1024 RGBA `source.png` is the master. Use the locked Tauri CLI
(2.12.1 in the observed build); install **only** its generated ICO into the
source icons directory. Never copy the owner's untracked ICO. Other generated
icons remain in the new ignored directory. The addon generates `index.js` and
`pipe-bridge-windows.win32-x64-msvc.node` in its package.

### 3. Build the embedded-UI desktop, without bundling

Use an explicit UTF-8 **without BOM** config file: inline JSON can lose quoting
through PowerShell / pnpm. Keep the tracked relative `frontendDist`;
do not replace it with an absolute Windows path or frontend URL.

```powershell
$config = "$state/tauri-reference.json"
[IO.File]::WriteAllText($config, '{"build":{"beforeBuildCommand":""}}', $utf8)
Push-Location "$root/apps/desktop"
try {
  & $node $tauri build --debug --no-bundle --features custom-protocol --config $config -- --locked
  if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed; do not launch a fallback binary' }
} finally { Pop-Location }
```

Only `beforeBuildCommand` is cleared because UI was built separately. Default
Cargo features stay enabled. Sherpa 1.13.8 native libraries are fetched publicly
from `github.com/k2-fsa/sherpa-onnx/releases`; the inspected build script does not
enforce an archive checksum. A locally observed hash is provenance, **not upstream
authentication** or a security guarantee. Successful output belongs at
`.cache/windows-local/target/debug/gentle-dot.exe`, directly usable by the preview
launcher without an alias or hardlink.

This online flow is distinct from [the existing offline builder](windows-local-launcher.md#build-once),
which copies an already populated Cargo registry and requires local Sherpa
libraries. Do not use that cache-dependent helper as proof of fresh installation.

## Launch only after the build finishes

```powershell
node scripts/windows/preview-launch.mjs
```

Keep the checkout, frontend, Node and installed runtime dependencies in place;
there is no Vite server. Port `4417` must be free. Use normal tray **Quit** on your
own other Dot instance first; the launcher neither kills processes nor resets
profiles. Do not overlap installation/build with launch.

Preview data lives at `.cache/windows-preview`, with an isolated home inside it;
subsequent launches reuse your own data. No owner profile is copied or read, and
ambient provider keys / Engram settings are not forwarded. Authenticate through
the app with your own provider account, never through this chat or a report.
Companion auto-setup remains disabled (`GENTLE_SHELL_NO_AUTO_SETUP=1`); report
missing provisioning rather than enabling unreviewed auto-installation.

Do **not** use `local-launch.cmd` or `local-launch.mjs` for contributors: they
retain the owner's preserved validation-profile path. The preview command accepts
only `--help` or no arguments. A successful spawn is not working-chat acceptance.

## Independent-machine acceptance checklist

Use a different Windows machine and a new checkout/profile, without importing
caches or data. These T7 items remain **unchecked**, regardless of same-host results:

- [ ] Record exact commit, Windows version/architecture and all tool versions.
- [ ] Frozen dependency installation, including enabled postinstall, succeeds.
- [ ] Addon, UI, generated ICO and locked native desktop builds succeed.
- [ ] First opening shows an empty welcome panel, not a persistent black panel.
- [ ] Own provider login and tool-free `Reply exactly PREVIEW_OK. Do not use tools or access files.` work.
- [ ] Normal tray Quit, same-profile reopen and previous conversation all work.

If the first opening fails but a later reopening succeeds, report **both**.
Preserve your profile; do not delete/reset it or repeat login to hide the failure.
Do not raise timeouts or remove extensions based on an unproven cause. Discord,
voice, tools and other integrations are outside this checklist. This is not
installer, portable-app, release or stable-Windows acceptance.

## Contribute or report a failure

Use [this fork's issues](https://github.com/aiorellana502/gentle-dot/issues), not the
upstream tracker for preview-specific failures. Include the exact commit,
Windows/tool versions, failing stage, elapsed time if observed, a short redacted
error and expected versus observed behavior. Known failures are valuable even if
a later reopen works. Never attach full logs, ordinary stderr, `.cache`, profiles,
auth URLs/fragments, tokens, keys, account data or user identity.
[Startup diagnostics](windows-startup-diagnostics.md) are opt-in; ordinary output
is not a sanitized export. A bounded pattern-based audit of the published history
found only test fixtures and no real credentials
([details](windows-preview-validation.md#security-and-next-acceptance-boundary)).
It was not a dedicated secret scanner, so it is not security approval.

For code contributions, keep one fix with its regression test, preserve original
attribution, and avoid unrelated formatting or generated build artifacts.
Synthetic launcher checks (no GUI/login) are available separately:

```powershell
node --test scripts/windows/*.test.mjs
```

Those checks do not establish clean-machine, runtime or security-history approval.
