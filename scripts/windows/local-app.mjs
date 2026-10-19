import { existsSync, mkdirSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const executable = root => join(root, '.cache/windows-local/target/debug/gentle-dot.exe');
export function prerequisites(root) {
  return [executable(root), join(root, 'packages/ui/dist/app/index.html'),
    join(root, 'packages/daemon/src/cli.ts'), join(root, 'packages/pipe-bridge-windows/index.js'),
    join(root, 'packages/pipe-bridge-windows/pipe-bridge-windows.win32-x64-msvc.node'),
    join(root, 'packages/daemon/node_modules/gentle-pi/bin/gentle-shell.mjs')];
}
export function requireFiles(files) {
  for (const file of files) if (!existsSync(file)) throw new Error(
    `Missing prerequisite: ${file}\nRun node scripts/windows/local-build.mjs after preparing existing dependencies.`);
}
export function environment(root, base) {
  const data = join(root, '.cache/chatgpt-pro-validation');
  const home = join(data, 'launcher-home');
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) {
    const key = Object.keys(base).find(key => key.toUpperCase() === name.toUpperCase());
    if (key && base[key] !== undefined) env[name] = base[key];
  }
  return { ...env, HOME: home, USERPROFILE: home,
    HOMEDRIVE: win32.parse(home).root.replace(/\\$/, ''), HOMEPATH: home.slice(Math.max(0, win32.parse(home).root.length - 1)),
    APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'),
    TEMP: join(root, '.cache/windows-local/tmp'), TMP: join(root, '.cache/windows-local/tmp'),
    GENTLE_DOT_DATA_DIR: data, GENTLE_DOT_PORT: '4417',
    GENTLE_DOT_NODE: process.execPath, GENTLE_DOT_DAEMON_SCRIPT: join(root, 'packages/daemon/src/cli.ts'),
    GENTLE_SHELL_NO_AUTO_SETUP: '1' };
}
export function startDetached(exe, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { ...options, detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
export async function launch(root, base, spawnApp = startDetached) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required.');
  requireFiles(prerequisites(root));
  const env = environment(root, base);
  mkdirSync(env.TEMP, { recursive: true });
  try { await spawnApp(executable(root), [], { cwd: root, env }); }
  catch (error) { throw new Error(`Cannot open Gentle Dot: ${error.message}`); }
}
export function help(script, args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(`Usage: node scripts/windows/${script}.mjs [--help]`);
    return true;
  }
  if (args.length) throw new Error(`Unknown argument: ${args[0]}`);
  return false;
}
