import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

test('public cmd opens its adjacent entrypoint from an external cwd with spaces', {
  skip: process.platform !== 'win32',
}, () => {
  const area = resolve('.cache/windows-local/verify');
  mkdirSync(area, { recursive: true });
  const root = mkdtempSync(join(area, 'cmd-'));
  try {
    const folder = join(root, 'folder with spaces');
    const external = join(root, 'external cwd');
    const home = join(root, 'home');
    const tmp = join(root, 'tmp');
    for (const dir of [folder, external, home, tmp]) mkdirSync(dir);
    const cmd = join(folder, 'local-launch.cmd');
    const script = join(folder, 'local-launch.mjs');
    cpSync(resolve('scripts/windows/local-launch.cmd'), cmd);
    writeFileSync(script, 'console.log(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd()}));\n');
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${cmd}""`], {
      cwd: external, windowsVerbatimArguments: true, timeout: 10_000, encoding: 'utf8',
      env: { SystemRoot: process.env.SystemRoot, COMSPEC: process.env.ComSpec,
        PATH: `${dirname(process.execPath)};${process.env.PATH ?? process.env.Path ?? ''}`,
        HOME: home, USERPROFILE: home, TEMP: tmp, TMP: tmp, TMPDIR: tmp,
        NODE_COMPILE_CACHE: join(root, 'compile-cache'), NO_UPDATE_NOTIFIER: '1' },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, `${JSON.stringify({ argv: [script], cwd: external })}\n`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
