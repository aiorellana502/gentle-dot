import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('public offline build preserves relative frontend config and existing build workflow', { skip: process.platform !== 'win32' }, () => {
  const cache = resolve('.cache/windows-local');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(join(cache, 'build fixture-'));
  const put = (file, content = '') => {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    for (const name of ['local-build.mjs', 'local-app.mjs']) {
      put(`scripts/windows/${name}`);
      copyFileSync(resolve('scripts/windows', name), join(root, 'scripts/windows', name));
    }
    put('apps/desktop/src-tauri/tauri.conf.json');
    copyFileSync(resolve('apps/desktop/src-tauri/tauri.conf.json'), join(root, 'apps/desktop/src-tauri/tauri.conf.json'));
    for (const file of ['user/.rustup/toolchains/stable-x86_64-pc-windows-msvc/bin/cargo.exe',
      'user/.rustup/toolchains/stable-x86_64-pc-windows-msvc/bin/rustc.exe',
      'user/.cargo/registry/fixture', 'apps/desktop/src-tauri/Cargo.lock',
      'apps/desktop/src-tauri/target/sherpa-onnx-prebuilt/sherpa-onnx-v1.13.8-win-x64-static-MT-Release-lib/lib/fixture']) put(file, 'fake');
    put('packages/ui/node_modules/vite/bin/vite.js', `
      const fs = require('node:fs');
      const path = require('node:path');
      fs.writeFileSync('vite-argv.json', JSON.stringify(process.argv.slice(2)));
      const out = process.argv[process.argv.indexOf('--outDir') + 1];
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'index.html'), 'fake built frontend');
    `);
    put('apps/desktop/node_modules/@tauri-apps/cli/tauri.js', `
      const fs = require('node:fs');
      const argv = process.argv.slice(2);
      const config = JSON.parse(argv[argv.indexOf('--config') + 1]);
      fs.writeFileSync('tauri-observed.json', JSON.stringify({ argv, config }));
    `);
    const env = {};
    for (const name of ['SystemRoot', 'WINDIR']) if (process.env[name]) env[name] = process.env[name];
    for (const name of ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP']) env[name] = join(root, 'user');
    const result = spawnSync(process.execPath, [join(root, 'scripts/windows/local-build.mjs')],
      { cwd: root, env, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    const { argv, config } = JSON.parse(readFileSync(join(root, 'apps/desktop/tauri-observed.json'), 'utf8'));
    assert.deepEqual(argv, ['build', '--debug', '--no-bundle', '--features', 'custom-protocol',
      '--config', JSON.stringify(config), '--', '--offline', '--locked']);
    assert.equal(config.build.beforeBuildCommand, '');
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'packages/ui/vite-argv.json'), 'utf8')),
      ['build', '--outDir', join(root, 'packages/ui/dist/app')]);
    assert.equal(readFileSync(join(root, 'packages/ui/dist/app/index.html'), 'utf8'), 'fake built frontend');
    assert.equal(existsSync(join(root, '.cache/windows-local/cargo-home/registry/fixture')), true);
    assert.equal(Object.hasOwn(config.build, 'frontendDist'), false, 'frontendDist must not be overridden with an absolute Windows path');
    const ordinary = JSON.parse(readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
    assert.equal(ordinary.build.frontendDist, '../../../packages/ui/dist/app');
    assert.deepEqual(config, { build: { beforeBuildCommand: '' } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
