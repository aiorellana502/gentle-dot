import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const cache = resolve('.cache/windows-local/tests');
mkdirSync(cache, { recursive: true });
const modulePath = pathToFileURL(resolve('scripts/windows/local-app.mjs')).href;
const cli = resolve('scripts/windows/local-launch.mjs');
const buildCli = resolve('scripts/windows/local-build.mjs');

function fixture() {
  const root = mkdtempSync(join(cache, 'repo with spaces-'));
  for (const file of ['.cache/windows-local/target/debug/gentle-dot.exe',
    'packages/ui/dist/app/index.html', 'packages/daemon/src/cli.ts',
    'packages/pipe-bridge-windows/index.js', 'packages/pipe-bridge-windows/pipe-bridge-windows.win32-x64-msvc.node',
    'packages/daemon/node_modules/gentle-pi/bin/gentle-shell.mjs']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), 'fixture');
  }
  return root;
}

test('launch uses existing executable, preserved profile, explicit environment, no build', async () => {
  const { launch } = await import(modulePath);
  const root = fixture();
  try {
    const profile = join(root, '.cache/chatgpt-pro-validation');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'sentinel'), 'unchanged');
    const marker = join(root, 'observed.json');
    // A separate process observes the public launch specification; no GUI or actual profile access.
    const spawnApp = (exe, args, options) => {
      const result = spawnSync(process.execPath, ['-e',
        'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({argv:process.argv.slice(2),env:process.env,cwd:process.cwd()}))',
        marker, exe, ...args], { cwd: options.cwd, env: options.env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      return Promise.resolve();
    };
    await launch(root, { Path: process.env.Path ?? process.env.PATH, SystemRoot: process.env.SystemRoot,
      OPENAI_API_KEY: 'synthetic-secret', USERPROFILE: 'not-the-profile', GENTLE_DOT_DATA_DIR: 'wrong' }, spawnApp);
    const observed = JSON.parse(readFileSync(marker, 'utf8'));
    assert.deepEqual(observed.argv, [join(root, '.cache/windows-local/target/debug/gentle-dot.exe')]);
    assert.equal(observed.cwd, root);
    assert.equal(observed.env.GENTLE_DOT_DATA_DIR, profile);
    assert.equal(observed.env.GENTLE_DOT_PORT, '4417');
    assert.equal(observed.env.GENTLE_SHELL_NO_AUTO_SETUP, '1');
    assert.equal(observed.env.OPENAI_API_KEY, undefined);
    for (const name of ['HOME', 'USERPROFILE']) assert.equal(observed.env[name], join(profile, 'launcher-home'));
    assert.equal(observed.env.APPDATA, join(profile, 'launcher-home/AppData/Roaming'));
    assert.equal(observed.env.LOCALAPPDATA, join(profile, 'launcher-home/AppData/Local'));
    assert.equal(readFileSync(join(profile, 'sentinel'), 'utf8'), 'unchanged');
    assert.equal(existsSync(join(root, '.cache/windows-local/cargo-home')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('every missing prerequisite rejects before spawn or profile/cache mutation', async () => {
  const { launch, prerequisites } = await import(modulePath);
  const root = fixture();
  try {
    const required = prerequisites(root);
    for (const file of required) {
      const bytes = readFileSync(file);
      rmSync(file);
      let spawned = false;
      await assert.rejects(launch(root, {}, async () => { spawned = true; }),
        { message: `Missing prerequisite: ${file}\nRun node scripts/windows/local-build.mjs after preparing existing dependencies.` });
      assert.equal(spawned, false);
      assert.equal(existsSync(join(root, '.cache/windows-local/tmp')), false);
      assert.equal(existsSync(join(root, '.cache/chatgpt-pro-validation')), false);
      assert.equal(existsSync(join(root, '.cache/windows-local/cargo-home')), false);
      writeFileSync(file, bytes);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spawn failure is actionable and preserves synthetic profile', async () => {
  const { launch } = await import(modulePath);
  const root = fixture();
  try {
    const profile = join(root, '.cache/chatgpt-pro-validation');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'sentinel'), 'unchanged');
    await assert.rejects(launch(root, {}, async () => { throw new Error('access denied'); }),
      { message: 'Cannot open Gentle Dot: access denied' });
    assert.equal(readFileSync(join(profile, 'sentinel'), 'utf8'), 'unchanged');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const script of [cli, buildCli]) {
  test(`${script}: help and invalid arguments have exact streams and no side effects`, () => {
    const root = fixture();
    try {
      const result = spawnSync(process.execPath, [script, '--help'], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, `Usage: node scripts/windows/${script.endsWith('local-build.mjs') ? 'local-build' : 'local-launch'}.mjs [--help]\n`);
      const invalid = spawnSync(process.execPath, [script, '--invalid'], { cwd: root, encoding: 'utf8' });
      assert.equal(invalid.status, 1);
      assert.equal(invalid.stdout, '');
      assert.equal(invalid.stderr, 'Unknown argument: --invalid\n');
      assert.equal(existsSync(join(root, '.cache/chatgpt-pro-validation')), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
