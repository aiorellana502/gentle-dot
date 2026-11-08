# Try the unofficial Windows contributor preview

This aiorellana502 fork explores native Windows x64 desktop chat. It is for
contributors with a development toolchain, **not an installer or portable app**.
Original project: [Gentleman-Programming/gentle-dot](https://github.com/Gentleman-Programming/gentle-dot).
Keep the [MIT license and copyright notice](../LICENSE); this fork is not an
upstream release or an endorsement by the original maintainers.

## Readiness before you start

**Preparation only: a clean-clone build and empty-profile first login have not
been validated.** The owner's existing-profile chat worked on one Windows host;
that does not establish fresh-install success. A bounded heuristic review of the
outgoing commit history found no credential-pattern matches, but that is not an
exhaustive security guarantee (no dedicated secret scanner was available), so
publication remains blocked during preparation. Do not ask for, copy, upload or
reuse the owner's profile or build cache.

| Area | Current evidence / limit |
| --- | --- |
| Basic text chat and last conversation | Accepted manually on the original host/profile |
| Separate preview launch environment | Eight isolated launcher tests passed independently; not a real first login |
| Native pipe / startup recovery | Existing targeted tests; not a fresh-machine report |
| Clean Windows setup | Overall dependency installation failed in the isolated checkout; addon and desktop builds were not reached. A standalone Go build succeeded, but does not validate the full workflow |
| Voice, computer control, connectors, tools, private memory | Not validated for this preview |
| Windows installers / portable binaries | Not provided by this workflow |

## Prepare source dependencies

Use a Windows x64 development terminal with Node.js 24+, pnpm 11.5.0, stable
Rust MSVC, Visual Studio C++ build tools / Windows SDK and WebView2 available,
and a real Go 1.25.10+ toolchain on `PATH` (`go version`): `gentle-pi`'s
postinstall builds the bundled `gentle-ai` engine from source via Go's module
proxy/SumDB on Windows, since no signed Windows release is published yet.
The assistant can execute commands and access files: use a disposable test
workspace/account, not sensitive documents or a production environment.

**Known unresolved installation failure:** in the deeply nested validation
checkout, Go reported `The directory name is invalid.` while invoking `asm.exe`.
Path depth is a hypothesis, not a demonstrated root cause or a verified workaround.
A separate Go build succeeded; the actual `gentle-pi` postinstall still failed.
Do not change Windows system settings or treat an existing binary as clean-build
validation. The fresh-profile GUI also showed a black panel with
`the assistant did not answer on port 4417`; this remains unresolved.

Once the preview commits are actually published, obtain the source with:

```powershell
git clone --branch feat/windows-native-bootstrap https://github.com/aiorellana502/gentle-dot.git
cd gentle-dot
git rev-parse HEAD
pnpm install --frozen-lockfile
pnpm --filter @gentle-dot/pipe-bridge-windows build
```

Installation and compilation can download dependencies and execute build scripts;
review them before running. These are proposed contributor steps, not a clean
machine execution report. Record the exact commit, not only the branch name.
The addon must produce `packages/pipe-bridge-windows/index.js` and
`pipe-bridge-windows.win32-x64-msvc.node`; both are generated, ignored files.

Before the offline desktop build, separately prepare these prerequisites:

- Rust binaries under `%USERPROFILE%\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin`.
- A populated `%USERPROFILE%\.cargo\registry` compatible with the locked native dependencies.
- Sherpa 1.13.8 libraries under
  `apps/desktop/src-tauri/target/sherpa-onnx-prebuilt/sherpa-onnx-v1.13.8-win-x64-static-MT-Release-lib/lib`.
- Windows icon resources: the original host has an untracked
  `apps/desktop/src-tauri/icons/icon.ico`; clean-clone availability is not established.

**No verified bootstrap for the Cargo cache, Sherpa assets or Windows icon is
provided yet.** If any is missing, stop and report the prerequisite; do not copy
another user's cache, disable validation or assume `pnpm install` solves it.
See the [existing offline builder](windows-local-launcher.md#build-once) for its
exact assumptions. It copies the existing Cargo registry into repository-local
scratch and does not install missing tools or fetch native dependencies.

## Build, then use your own preview profile

With the prerequisites prepared, run from the repository root:

```powershell
node scripts/windows/local-build.mjs
node scripts/windows/preview-launch.mjs
```

Build and launch must not run concurrently. The preview launcher uses the existing
Debug executable in `.cache/windows-local/target/debug/gentle-dot.exe`, with
embedded UI and no Vite server. Keep the checkout and runtime dependencies in place.

Your preview data goes to `.cache/windows-preview`, with a home directory inside
it; repeated preview launches reuse your own data. The launcher does not copy or
read `.cache/chatgpt-pro-validation`. Do **not** use `local-launch.cmd` or
`local-launch.mjs` for this preview: those retain the owner's validation path.

The launch environment does not forward ambient provider keys or Engram settings.
Authenticate explicitly in the app using your own test account if first startup
succeeds. Companion auto-setup remains disabled (`GENTLE_SHELL_NO_AUTO_SETUP=1`);
if fresh startup needs more provisioning, report that gap instead of enabling
unreviewed auto-installation. Port `4417` must be free: close your own other Dot
instance first. This command does not kill another process or reset any profile.
Use `node scripts/windows/preview-launch.mjs --help` for usage; no other arguments
are supported. A successful spawn alone is not a working-chat result.

## First-start acceptance checklist

Run this manually on your own new preview directory, without importing a profile:

- [ ] Record Windows version/architecture and the exact commit/tool versions.
- [ ] Desktop rose and panel render; no persistent black panel or startup error.
- [ ] Your own provider login succeeds without sharing credentials.
- [ ] Request `Reply exactly PREVIEW_OK. Do not use tools or access files.` and observe the reply.
- [ ] Exit normally, reopen with `preview-launch.mjs`, and confirm the conversation returns.

These items are **not pre-checked**. If startup fails, preserve your profile and
report the failure; do not reset it or repeat login to hide the problem.

## Contribute or report a failure

Use [this fork's issues](https://github.com/aiorellana502/gentle-dot/issues), not the
upstream maintainer's tracker for failures unique to this preview. Include commit,
Windows/tool versions, failed step, elapsed time, exact redacted error and expected
versus observed behavior. A short reproduction is more useful than a full log dump.
Never attach `.cache`, profiles, auth URLs, access tokens, account data or ordinary
logs. [Startup diagnostics](windows-startup-diagnostics.md) are opt-in; ordinary
logs are not sanitized exports.

For code contributions, branch from the preview branch, keep one fix per change,
and include its regression test. Preserve original attribution and avoid unrelated
formatting, generated build artifacts, installer work or competing channel rewrites.
Useful first reports: missing build prerequisites, empty-profile startup, delayed
history recovery, and a second machine's basic-chat checklist.

Run the synthetic launcher checks without logging in or opening the GUI:

```powershell
node --test scripts/windows/*.test.mjs
```

Do not claim installer, security-history or clean-machine validation from these tests.
