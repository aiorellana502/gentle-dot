import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const cache = resolve('.cache/windows-local/tests');
mkdirSync(cache, { recursive: true });
const modulePath = pathToFileURL(resolve('scripts/windows/preview-app.mjs')).href;
const cli = resolve('scripts/windows/preview-launch.mjs');

function fixture() {
  const root = mkdtempSync(join(cache, 'preview with spaces-'));
  for (const file of ['.cache/windows-local/target/debug/gentle-dot.exe',
    'packages/ui/dist/app/index.html', 'packages/daemon/src/cli.ts',
    'packages/pipe-bridge-windows/index.js',
    'packages/pipe-bridge-windows/pipe-bridge-windows.win32-x64-msvc.node',
    'packages/daemon/node_modules/gentle-pi/bin/gentle-shell.mjs']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), 'fixture');
  }
  return root;
}

test('preview launches with a separate empty profile and allowlisted home environment', async () => {
  const { launchPreview } = await import(modulePath);
  const root = fixture();
  try {
    const preserved = join(root, '.cache/chatgpt-pro-validation');
    mkdirSync(preserved, { recursive: true });
    writeFileSync(join(preserved, 'sentinel'), 'untouched');
    const profile = join(root, '.cache/windows-preview');
    const home = join(profile, 'launcher-home');
    const marker = join(root, 'observed.json');
    await launchPreview(root, {
      Path: process.env.Path ?? process.env.PATH, SystemRoot: process.env.SystemRoot,
      OPENAI_API_KEY: 'synthetic-only', ENGRAM_URL: 'synthetic-only',
      USERPROFILE: 'personal', GENTLE_DOT_DATA_DIR: preserved,
    }, async (exe, args, options) => {
      const result = spawnSync(process.execPath, ['-e',
        'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({argv:process.argv.slice(2),env:process.env,cwd:process.cwd()}))',
        marker, exe, ...args], { cwd: options.cwd, env: options.env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    });
    const actual = JSON.parse(readFileSync(marker, 'utf8'));
    assert.deepEqual(actual.argv, [join(root, '.cache/windows-local/target/debug/gentle-dot.exe')]);
    assert.equal(actual.cwd, root);
    assert.equal(actual.env.GENTLE_DOT_DATA_DIR, profile);
    for (const key of ['HOME', 'USERPROFILE']) assert.equal(actual.env[key], home);
    assert.equal(actual.env.HOMEDRIVE + actual.env.HOMEPATH, home);
    assert.equal(actual.env.APPDATA, join(home, 'AppData/Roaming'));
    assert.equal(actual.env.LOCALAPPDATA, join(home, 'AppData/Local'));
    assert.equal(actual.env.GENTLE_DOT_PORT, '4417');
    assert.equal(actual.env.GENTLE_SHELL_NO_AUTO_SETUP, '1');
    assert.equal(actual.env.OPENAI_API_KEY, undefined);
    assert.equal(actual.env.ENGRAM_URL, undefined);
    assert.equal(readFileSync(join(preserved, 'sentinel'), 'utf8'), 'untouched');
    assert.equal(existsSync(profile), false, 'a synthetic spawn must not fabricate profile state');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preview missing prerequisites refuses without spawning or creating profile state', async () => {
  const { launchPreview } = await import(modulePath);
  const root = fixture();
  try {
    const missing = join(root, 'packages/pipe-bridge-windows/index.js');
    rmSync(missing);
    let spawned = false;
    await assert.rejects(launchPreview(root, {}, async () => { spawned = true; }), {
      message: `Missing prerequisite: ${missing}\nRun node scripts/windows/local-build.mjs after preparing existing dependencies.`,
    });
    assert.equal(spawned, false);
    for (const path of ['.cache/windows-preview', '.cache/chatgpt-pro-validation', '.cache/windows-local/tmp']) {
      assert.equal(existsSync(join(root, path)), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preview CLI has exact help/errors and rejects arguments without launching', () => {
  const root = fixture();
  try {
    for (const [args, status, stdout, stderr] of [
      [['--help'], 0, 'Usage: node scripts/windows/preview-launch.mjs [--help]\n', ''],
      [['--invalid'], 1, '', 'Unknown argument: --invalid\n'],
    ]) {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, status);
      assert.equal(result.stdout, stdout);
      assert.equal(result.stderr, stderr);
      assert.equal(existsSync(join(root, '.cache/windows-preview')), false);
      assert.equal(existsSync(join(root, '.cache/chatgpt-pro-validation')), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
