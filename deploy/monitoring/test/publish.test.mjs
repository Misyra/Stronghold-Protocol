// SPDX-License-Identifier: GPL-3.0-or-later
// publish-dashboard.mjs against a fake Grafana API: creates the public dashboard once, leaves a correct one alone,
// corrects drift, prints key=value lines, and never prints the admin password.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClient, drift, ensurePublicDashboard, parseBaseUrl, report } from '../publish-dashboard.mjs';

const SCRIPT = fileURLToPath(new URL('../publish-dashboard.mjs', import.meta.url));
const PASSWORD = 'test-only-Pw-9f3a1c';

/** A fake Grafana under /monitor: health, the provisioned dashboard and its public dashboard (one per dashboard). */
async function fakeGrafana({ password = PASSWORD, dashboardReadyAfter = 0 } = {}) {
  const state = { publicDashboard: null, calls: [], dashboardLookups: 0 };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    state.calls.push(`${req.method} ${req.url}`);
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.url === '/monitor/api/health') return send(200, { database: 'ok' });
    if (req.headers.authorization !== 'Basic ' + Buffer.from(`admin:${password}`).toString('base64')) {
      return send(401, { message: 'Invalid username or password' });
    }
    if (req.url === '/monitor/api/dashboards/uid/sp-status') {
      return state.dashboardLookups++ < dashboardReadyAfter ? send(404, { message: 'Dashboard not found' }) : send(200, { dashboard: {} });
    }
    const base = '/monitor/api/dashboards/uid/sp-status/public-dashboards';
    if (req.url === base && req.method === 'GET') {
      return state.publicDashboard ? send(200, state.publicDashboard) : send(404, { message: 'Public dashboard not found' });
    }
    if (req.url === base && req.method === 'POST') {
      state.publicDashboard = { uid: 'pd1', dashboardUid: 'sp-status', accessToken: '0123456789abcdef0123456789abcdef', ...JSON.parse(body) };
      return send(200, state.publicDashboard);
    }
    if (req.url === `${base}/pd1` && req.method === 'PATCH') {
      Object.assign(state.publicDashboard, JSON.parse(body));
      return send(200, state.publicDashboard);
    }
    send(404, { message: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/monitor`;
  return { url, state, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

function run(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('creates once, then leaves it alone, then corrects drift (same token throughout)', async (t) => {
  const grafana = await fakeGrafana({ dashboardReadyAfter: 2 });
  t.after(grafana.close);
  const call = createClient(grafana.url, 'admin', PASSWORD);
  const pause = async () => {};
  const first = await ensurePublicDashboard(call, 'sp-status', { pause });
  assert.equal(first.status, 'created', 'waits for the provisioned dashboard, then creates');
  assert.deepEqual(drift(first.publicDashboard), {});
  assert.equal(grafana.state.publicDashboard.share, 'public');
  assert.equal(grafana.state.publicDashboard.annotationsEnabled, false);
  assert.equal(grafana.state.publicDashboard.timeSelectionEnabled, true);
  const second = await ensurePublicDashboard(call, 'sp-status', { pause });
  assert.equal(second.status, 'unchanged');
  assert.equal(grafana.state.calls.filter((c) => !c.startsWith('GET')).length, 1, 'no write when nothing changed');
  grafana.state.publicDashboard.annotationsEnabled = true;
  grafana.state.publicDashboard.isEnabled = false;
  const third = await ensurePublicDashboard(call, 'sp-status', { pause });
  assert.equal(third.status, 'updated');
  assert.deepEqual(drift(grafana.state.publicDashboard), {});
  assert.equal(third.publicDashboard.accessToken, first.publicDashboard.accessToken);
  assert.equal(report(third, grafana.url, 'sp-status', 'https://example.invalid/monitor/'), [
    'status=updated', 'dashboard_uid=sp-status', 'public_dashboard_uid=pd1', 'access_token=0123456789abcdef0123456789abcdef',
    'public_path=/monitor/public-dashboards/0123456789abcdef0123456789abcdef',
    'public_url=https://example.invalid/monitor/public-dashboards/0123456789abcdef0123456789abcdef', ''].join('\n'));
});

test('the script prints key=value lines and never the password; a wrong password fails without echoing it', async (t) => {
  const grafana = await fakeGrafana();
  t.after(grafana.close);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-publish-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pw');
  fs.writeFileSync(file, PASSWORD + '\n', { mode: 0o400 });
  const ok = await run({ GRAFANA_URL: grafana.url, GRAFANA_ADMIN_PASSWORD_FILE: file, WAIT_SECONDS: '5' });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /^status=created\ndashboard_uid=sp-status\npublic_dashboard_uid=pd1\naccess_token=[0-9a-f]{32}\npublic_path=\/monitor\/public-dashboards\/[0-9a-f]{32}\n$/);
  const again = await run({ GRAFANA_URL: grafana.url, GRAFANA_ADMIN_PASSWORD_FILE: file, WAIT_SECONDS: '5' });
  assert.match(again.stdout, /^status=unchanged\n/);
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, 'wrong-Pw-77d1');
  const bad = await run({ GRAFANA_URL: grafana.url, GRAFANA_ADMIN_PASSWORD_FILE: file, WAIT_SECONDS: '5' });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /HTTP 401/);
  for (const out of [ok, again, bad]) {
    assert.doesNotMatch(out.stdout + out.stderr, /test-only-Pw|wrong-Pw|Basic /);
  }
  const missing = await run({ GRAFANA_URL: grafana.url, GRAFANA_ADMIN_PASSWORD_FILE: path.join(dir, 'none') });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /cannot read GRAFANA_ADMIN_PASSWORD_FILE/);
});

test('GRAFANA_URL: https, or plain http on loopback only; no credentials', () => {
  assert.equal(parseBaseUrl('http://127.0.0.1:3160/monitor/'), 'http://127.0.0.1:3160/monitor');
  assert.equal(parseBaseUrl('http://localhost:3160/monitor'), 'http://localhost:3160/monitor');
  assert.equal(parseBaseUrl('https://example.invalid/monitor'), 'https://example.invalid/monitor');
  for (const bad of ['http://192.0.2.1:3160/monitor', 'http://admin:pw@127.0.0.1:3160/monitor', 'ftp://127.0.0.1/monitor',
    'http://127.0.0.1:3160/monitor?x=1', 'not a url']) {
    assert.throws(() => parseBaseUrl(bad), bad);
  }
});
