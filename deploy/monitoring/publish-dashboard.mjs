#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// deploy/monitoring/publish-dashboard.mjs(移植自 Stardust fork 的同名脚本)— make sure the provisioned status dashboard (uid sp-status) has an
// enabled Grafana public dashboard: share public, time selection on, annotations off. Idempotent: creates it once,
// corrects drifted settings, and otherwise changes nothing (the access token stays the same).
//
//   GRAFANA_URL=http://127.0.0.1:3160/monitor \
//   GRAFANA_ADMIN_PASSWORD_FILE=/etc/ark-monitor/grafana-admin-password \
//   [GRAFANA_PUBLIC_URL=https://<site>/monitor/] [DASHBOARD_UID=sp-status] [GRAFANA_ADMIN_USER=admin] \
//   [WAIT_SECONDS=90] node publish-dashboard.mjs
//
// Prints key=value lines on stdout: status (created / updated / unchanged), dashboard_uid, public_dashboard_uid,
// access_token, public_path and, with GRAFANA_PUBLIC_URL, public_url. The access token is the public URL itself and
// fine to print; the admin password is read from the file, sent only as HTTP basic auth to GRAFANA_URL and never
// printed or logged. Plain http is accepted for a loopback GRAFANA_URL only (run it on the edge host or through the
// SSH tunnel). No npm dependencies.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const WANT = { isEnabled: true, timeSelectionEnabled: true, annotationsEnabled: false, share: 'public' };
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_BYTES = 1024 * 1024;

/** The Grafana base URL (root_url path included, no trailing slash): https, or http on loopback; no credentials. */
export function parseBaseUrl(text) {
  let url;
  try { url = new URL(String(text ?? '')); } catch { throw new Error('GRAFANA_URL is not a URL'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('GRAFANA_URL must not carry credentials, query or fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new Error('GRAFANA_URL must be https, or http on a loopback address');
  }
  return url.href.replace(/\/+$/, '');
}

/** What must change on an existing public dashboard (an empty object: nothing). */
export function drift(current) {
  return Object.fromEntries(Object.entries(WANT).filter(([k, v]) => current?.[k] !== v));
}

/** A small JSON client: basic auth, timeout, no redirects, capped body; errors name the step and status only. */
export function createClient(base, user, password, { fetchFn = fetch, timeoutMs = 10_000 } = {}) {
  const auth = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
  return async function call(step, method, path, body, { authenticated = true } = {}) {
    let response;
    try {
      response = await fetchFn(base + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json', ...(authenticated ? { authorization: auth } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { return { status: 0, data: null }; }
    const text = await response.text();
    if (text.length > MAX_BYTES) throw new Error(`${step}: response too large`);
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { status: response.status, data };
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ensure the public dashboard; returns { status, publicDashboard }.
 * @param {(step: string, method: string, path: string, body?: any, opts?: any) => Promise<{status: number, data: any}>} call
 */
export async function ensurePublicDashboard(call, dashboardUid, { waitSeconds = 90, pause = sleep } = {}) {
  const uid = encodeURIComponent(dashboardUid);
  const deadline = Date.now() + waitSeconds * 1000;
  // Grafana up, then the file-provisioned dashboard present (provisioning runs shortly after start)
  for (const [step, path, authenticated] of [['health', '/api/health', false], ['dashboard', `/api/dashboards/uid/${uid}`, true]]) {
    for (;;) {
      const r = await call(step, 'GET', path, undefined, { authenticated });
      if (r.status === 200) break;
      if (r.status === 401 || r.status === 403) throw new Error(`${step}: HTTP ${r.status} (check the admin user / password file)`);
      if (Date.now() >= deadline) throw new Error(`${step}: not ready (HTTP ${r.status || 'no answer'})`);
      await pause(2000);
    }
  }
  const base = `/api/dashboards/uid/${uid}/public-dashboards`;
  const found = await call('get public dashboard', 'GET', base);
  if (found.status === 200 && found.data?.uid && found.data?.accessToken) {
    const changes = drift(found.data);
    if (!Object.keys(changes).length) return { status: 'unchanged', publicDashboard: found.data };
    const patched = await call('update public dashboard', 'PATCH', `${base}/${encodeURIComponent(found.data.uid)}`,
      { ...WANT });
    if (patched.status !== 200 || Object.keys(drift(patched.data)).length) {
      throw new Error(`update public dashboard: HTTP ${patched.status}`);
    }
    return { status: 'updated', publicDashboard: patched.data };
  }
  if (found.status !== 404 && !(found.status === 200 && !found.data?.uid)) throw new Error(`get public dashboard: HTTP ${found.status}`);
  const created = await call('create public dashboard', 'POST', base, { ...WANT });
  if (created.status !== 200 || !created.data?.accessToken || Object.keys(drift(created.data)).length) {
    throw new Error(`create public dashboard: HTTP ${created.status}`);
  }
  return { status: 'created', publicDashboard: created.data };
}

/** The key=value lines this script prints. */
export function report({ status, publicDashboard }, base, dashboardUid, publicUrl) {
  const token = String(publicDashboard.accessToken);
  if (!/^[0-9A-Za-z_-]{8,128}$/.test(token)) throw new Error('unexpected access token format');
  const prefix = new URL(base + '/').pathname.replace(/\/+$/, '');
  const lines = [`status=${status}`, `dashboard_uid=${dashboardUid}`, `public_dashboard_uid=${publicDashboard.uid}`,
    `access_token=${token}`, `public_path=${prefix}/public-dashboards/${token}`];
  if (publicUrl) lines.push(`public_url=${new URL(`public-dashboards/${token}`, publicUrl.replace(/\/*$/, '/')).href}`);
  return lines.join('\n') + '\n';
}

async function main(env = process.env) {
  const base = parseBaseUrl(env.GRAFANA_URL ?? 'http://127.0.0.1:3160/monitor');
  const file = env.GRAFANA_ADMIN_PASSWORD_FILE;
  if (!file) throw new Error('set GRAFANA_ADMIN_PASSWORD_FILE');
  let password;
  try { password = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, ''); } catch { throw new Error('cannot read GRAFANA_ADMIN_PASSWORD_FILE'); }
  if (!password) throw new Error('GRAFANA_ADMIN_PASSWORD_FILE is empty');
  const dashboardUid = env.DASHBOARD_UID || 'sp-status';
  if (!/^[0-9A-Za-z_-]{1,40}$/.test(dashboardUid)) throw new Error('invalid DASHBOARD_UID');
  if (env.GRAFANA_PUBLIC_URL) {
    const u = new URL(env.GRAFANA_PUBLIC_URL);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('invalid GRAFANA_PUBLIC_URL');
  }
  const waitSeconds = Number(env.WAIT_SECONDS ?? 90);
  const call = createClient(base, env.GRAFANA_ADMIN_USER || 'admin', password);
  const result = await ensurePublicDashboard(call, dashboardUid, { waitSeconds: Number.isFinite(waitSeconds) ? waitSeconds : 90 });
  process.stdout.write(report(result, base, dashboardUid, env.GRAFANA_PUBLIC_URL));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`publish-dashboard: ${e.message}`);
    process.exitCode = 1;
  });
}
