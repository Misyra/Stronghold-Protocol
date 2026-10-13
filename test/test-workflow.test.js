import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('an explicitly requested browser run fails clearly when Chrome is missing', () => {
  const child = spawnSync(process.execPath, ['--import', './tools/browser-test-setup.mjs', '--input-type=module', '-e', ''], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, CHROME_PATH: path.join(root, '.state', 'missing-test-browser.exe') },
  });
  assert.equal(child.status, 1, child.stderr || String(child.error));
  assert.match(child.stderr, /Browser tests require Chrome/);
});

test('source-test preload ignores retained builds; explicit production tests and normal startup still use them', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'sp-test-client-mode-'));
  try {
    await mkdir(path.join(temp, 'build'));
    await writeFile(path.join(temp, 'index.html'), '<html>source fixture</html>');
    await writeFile(path.join(temp, 'build/index.html'), '<html>built fixture</html>');
    for (const [preload, options, expected] of [
      ['test-setup.js', {}, 'source'],
      ['test-setup.js', { clientBuild: true }, 'built'],
      ['moderation-fixture.js', {}, 'built'],
      ['moderation-fixture.js', { clientBuild: false }, 'source'],
    ]) {
      const child = spawnSync(process.execPath, ['--import', `./test/helpers/${preload}`, '--input-type=module', '-e', `
        import { startServer } from './server/index.js';
        const srv = await startServer({ port: 0, host: '127.0.0.1', workers: 0, stateFile: 'off',
          publicDir: ${JSON.stringify(temp)}, log: { info() {}, warn() {}, error() {}, debug() {} },
          ...${JSON.stringify(options)} });
        try { console.log(await (await fetch(srv.url)).text()); }
        finally { await srv.close(); }
      `], { cwd: root, encoding: 'utf8', timeout: 30000 });
      assert.equal(child.status, 0, child.stderr || String(child.error));
      assert.match(child.stdout, new RegExp(`${expected} fixture`));
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
