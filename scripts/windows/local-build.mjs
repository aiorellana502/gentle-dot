import { cpSync, mkdirSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { environment, help, repoRoot, requireFiles } from './local-app.mjs';

try {
  if (!help('local-build', process.argv.slice(2))) {
    if (process.platform !== 'win32') throw new Error('This builder requires Windows.');
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required.');
    // Resolve only the two explicitly authorized prerequisite locations before isolation.
    const user = process.env.USERPROFILE;
    if (!user) throw new Error('USERPROFILE is required to locate the existing offline toolchain.');
    const toolchain = join(user, '.rustup/toolchains/stable-x86_64-pc-windows-msvc/bin');
    const registry = join(user, '.cargo/registry');
    const cache = join(repoRoot, '.cache/windows-local');
    const vite = join(repoRoot, 'packages/ui/node_modules/vite/bin/vite.js');
    const tauri = join(repoRoot, 'apps/desktop/node_modules/@tauri-apps/cli/tauri.js');
    const sherpa = join(repoRoot, 'apps/desktop/src-tauri/target/sherpa-onnx-prebuilt/sherpa-onnx-v1.13.8-win-x64-static-MT-Release-lib/lib');
    requireFiles([vite, tauri, registry, join(toolchain, 'cargo.exe'), join(toolchain, 'rustc.exe'),
      sherpa, join(repoRoot, 'apps/desktop/src-tauri/Cargo.lock')]);
    const env = { ...environment(repoRoot, process.env),
      CARGO_HOME: join(cache, 'cargo-home'), CARGO_TARGET_DIR: join(cache, 'target'),
      CARGO_NET_OFFLINE: 'true', SHERPA_ONNX_LIB_DIR: sherpa,
      RUSTC: join(toolchain, 'rustc.exe') };
    // Build tools must never use the preserved chat profile as HOME.
    env.HOME = env.USERPROFILE = join(cache, 'build-home');
    env.APPDATA = join(env.HOME, 'AppData/Roaming');
    env.LOCALAPPDATA = join(env.HOME, 'AppData/Local');
    env.HOMEPATH = env.HOME.slice(env.HOMEDRIVE.length);
    env.PATH = `${toolchain}${delimiter}${env.PATH ?? ''}`;
    for (const dir of [env.CARGO_HOME, env.HOME, env.TEMP]) mkdirSync(dir, { recursive: true });
    cpSync(registry, join(env.CARGO_HOME, 'registry'), { recursive: true });
    const run = (script, args, cwd) => {
      const result = spawnSync(process.execPath, [script, ...args], { cwd, env, stdio: 'inherit', shell: false });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Local build stopped (${result.status ?? result.signal}); resolve the offline prerequisite above. No installation attempted.`);
    };
    const frontend = join(repoRoot, 'packages/ui/dist/app');
    run(vite, ['build', '--outDir', frontend], join(repoRoot, 'packages/ui'));
    run(tauri, ['build', '--debug', '--no-bundle', '--features', 'custom-protocol',
      '--config', JSON.stringify({ build: { beforeBuildCommand: '' } }),
      '--', '--offline', '--locked'], join(repoRoot, 'apps/desktop'));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
