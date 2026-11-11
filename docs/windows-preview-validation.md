# Windows contributor preview: validation evidence

**Same-host source build and later new-profile chat/history succeeded; reliable
first cold start and independent-machine acceptance remain unproven. A bounded
pattern-based source audit found only test fixtures.** This is an unofficial contributor preview, not an installer,
portable binary, stable Windows release or upstream endorsement.

For the reference steps and unchecked second-machine checklist, use the
[contributor guide](windows-contributor-preview.md). This report separates
observations from guarantees; it does not publish private profiles or runtime logs.

## Source and build evidence

Validated source: `cb30721b423f24656adcd9c4c61a8f78d384e510` on
`feat/windows-native-bootstrap`, already pushed before these validation phases.
The isolated archive contained 386 files matching Git blobs. Tracked source and
lockfiles remained unchanged; the Windows ICO was generated separately. All runs used the **same Windows host**, with installed
Node 24.13.0, pnpm 11.5.0, Go 1.26.2, stable Rust 1.99.0, MSVC 14.51.36231 and
Windows SDK. This does not validate toolchain installation on a clean machine.

| Stage | Observed result | Boundary |
| --- | --- | --- |
| Existing-workspace offline build | Exit 0; human chat/history and requested early Quit accepted | Existing dependencies/profile; not fresh installation or measured Quit latency |
| Isolated-source frozen install | Exit 0, scripts enabled, including `gentle-pi` postinstall | Fresh dependency state, not a newly provisioned host |
| Windows addon / UI / icon | Each exit 0 | Generated from public source; no owner's ICO copied |
| Initial native desktop build | Exit 1: `lzma-sys` / `cl.exe` compilation failure | Original compiler failure remains unexplained |
| Authorized contextual desktop continuation | Exit 0, **zero corrections**, locks/source unchanged | Later success does not turn the first attempt into a pass |

The earlier deeply nested installation attempt failed with Go's
`The directory name is invalid.` while invoking `asm.exe`; addon/desktop stages
were not reached then. Later isolated installation succeeded, without proving
path depth caused the earlier failure.

Tracked `apps/desktop/src-tauri/icons/source.png` (1024×1024 RGBA) was converted
by Tauri 2.12.1; only the generated ICO was added to the fresh source icons.
Generated ICO SHA256:
`a1379c27ffa6db2dfd0f971227f2db76c292f81e0a672136fd5a167a657b5c7b`.
Clean-built debug executable SHA256:
`0752e583c58b58b12ee96098f69edbe8011a72f2b28e8f3adcd742ef8729b36e`.
These identify observed artifacts, not signed releases or future build outputs.

Cargo and Sherpa assets were fetched into fresh isolated state, not copied from
the host registry/targets. Sherpa 1.13.8 came from its public GitHub release;
14 library files were present from the downloaded archive. The inspected upstream build script lacks archive
checksum enforcement: a locally recorded hash is provenance, not upstream
authentication or a broad supply-chain security guarantee.

## New-profile runtime evidence

The first fresh-profile opening failed with the black-panel message
`the assistant did not answer on port 4417`. High CPU was observed, but is **not
a demonstrated cause**. The failure remains unexplained, not fixed by this work.

A later diagnostic reopening observed an authenticated native channel, HTTP 200,
six successful `connection_info` results with no failures, and a ready event.
The app then exited normally with code 0. Human observation separately confirmed
welcome UI, own provider login and ordinary chat. After normal Quit and a
same-profile reopening, the human confirmed persisted chat. An exact marker
response was not independently established.

No agent/history diagnostic events were delivered in the actual capture; native
readiness is not interchangeable with agent/history readiness. The independent
collector checks passed **six original plus three additional synthetic tests**
for that collector's privacy/lifecycle boundary only. They are not app-wide
runtime or security approval; the private helper is not a shipped contributor step.
A build exit, launcher spawn or HTTP 200 alone is not working-chat evidence.

## Security and next acceptance boundary

A bounded pattern-based audit covered every text blob reachable from the published
branch at `cb30721` (1284 unique blobs; 35 binary blobs skipped), all 267 commit
messages and the pending documentation. It searched for private keys, cloud, GitHub,
OpenAI/Anthropic, Slack, Google and Discord token shapes, JWTs, credentials in URLs,
assigned secrets and user-specific Windows paths, printing only redacted locations.
No environment files exist anywhere in the published history. **Every match was a
synthetic test fixture or placeholder; no real credential was found.** No dedicated
secret scanner was available, and pattern matching can miss unknown formats, so this
is not security clearance. Keep credentials in the
app/browser, never in reports. Do not share auth URLs/fragments, tokens, keys,
ordinary stderr, full logs, profiles, `.cache` or account/identity data.

The guide's PowerShell recipe is a source-driven reference corresponding to
validated stages, not a script executed end-to-end or independent-host proof.
Next acceptance is the guide's **unchecked T7 second-machine checklist**:
frozen install, addon/UI/native build, first empty welcome, own login/tool-free
chat, and normal Quit/reopen/history. Report original failures even if reopening
works. Discord, voice, tools and other integrations remain outside scope.
