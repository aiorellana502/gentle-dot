# Windows contributor preview
Prepare a source-only experimental preview without publishing. Branch: feat/windows-native-bootstrap; base: d3d4fcfc6dd672450e21f0cd75f6a939c80860f6.
Delivery: ask-on-risk, forecast ~300 authored lines; runner: Node built-in tests, no GUI/build/install or history-scan retry.

## Specs
S1. User intent: "bueno revisemos por que si quisiera publicarlo para que otros lo prueben y tal vez nos apoyen con el desarrollo".
S2. Implementation authorization: "si avancemos con eso". Accepted proposal: "Recomiendo preparar una **preview para colaboradores técnicos**, no un instalador todavía: instrucciones reproducibles, primer inicio independiente y límites claros. La revisión pendiente de secretos seguiría bloqueando el push." / "¿Querés que avancemos con esa preparación, sin publicar aún?"
S3. Constraints retained from the accepted preparation: do not publish, copy/read the existing validation profile, install dependencies, build native binaries or retry the failed history secret scan. Preserve unrelated dirty files. First-start and clean-machine success must not be claimed without evidence.

## Tasks
T1 | S1-S3 | inline (one sequential behavior, no writer trigger) | done | Added preview-launch/preview-app; initial missing-module run exit1, meaningful RED against default launch 1fail/2pass exit1, GREEN 3pass exit0; shared launcher unchanged; Risk: item 2 (isolated environment/profile selection); commit pending T3.
T2 | S1-S3 | inline (documentation for T1) | done | Added unofficial fork notice, guide, offline prerequisites, unverified bootstrap/icon gaps, own-profile acceptance and safe reporting; local links checked exit0; commit pending T3.
T3 | S1-S3 | inline + independent gentle-ai-verify (item 2) | in_progress | Full launcher suite 10passed exit0; assess exact work unit, independently verify synthetic behavior/docs, record missing real first-start/clean-machine/history proof; commit pending.

## Log
L1. User: "bueno revisemos por que si quisiera publicarlo para que otros lo prueben y tal vez nos apoyen con el desarrollo".
L2. User: "si avancemos con eso". Scope accepted: preview preparation only, no push/release. Exploration confirms offline builder assumes existing Cargo registry, Rust MSVC, Sherpa 1.13.8 and installed JS dependencies; addon build is separate. Clean bootstrap and empty-profile login remain unverified.
L3. Design: add a separate preview-launch command reusing the existing allowlisted environment, prerequisites and launch flow, changing all profile/home paths to .cache/windows-preview. Keep local-launch and the preserved validation profile untouched. Add documentation rather than a new installer/bootstrapper. History heuristic scan previously timed out at 30s with no result; no retry. New preview first launch requires explicit human acceptance, not inferred from a synthetic spawn.
L4. T1: dedicated preview launcher overrides data and all Windows home/AppData variables after the existing allowlist/prerequisite checks. Synthetic child observed exact environment, no inherited synthetic provider key/Engram URL, untouched synthetic validation-profile sentinel, no fabricated profile state. Initial missing-module run failed (not meaningful behavioral RED); default-launch stub then failed the profile assertion (1fail/2pass exit1); implementation GREEN 3passed exit0. No real profile read or app launch.
L5. T2/T3: README unofficial-fork notice and guide clarify prerequisites and unvalidated clean bootstrap, including existing untracked Windows icon. Full Node launcher suite 10passed/0failed exit0, including existing local launcher/build/CMD behaviors; all local links in three changed public docs resolve. No existing code was changed: differential execution against old shared code is not applicable (new command only; imported helpers unchanged). No native build, login, install, clean clone or history scan run.
