import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('production SES composition and actual offer clicks complete trading and settlement', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./sandbox-smoke.js', import.meta.url))], {
    encoding: 'utf8', timeout: 45000, windowsHide: true,
    env: { ...process.env, SP_PLUGIN_SCRIPTS: 'sandbox' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /sandbox offers and settlement: ok/);
});


test('production SES loss settlement preserves and collects future-income shortfalls', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./loss-smoke.js', import.meta.url))], {
    encoding: 'utf8', timeout: 45000, windowsHide: true,
    env: { ...process.env, SP_PLUGIN_SCRIPTS: 'sandbox' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /sandbox loss and future-income repayment: ok/);
});
