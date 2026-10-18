// The monitoring stack end to end, against THIS fork's /metrics body: the exporter must accept it and the mapper must
// turn it into Prometheus series without inventing anything and without leaking a player identity into a label.
// (xinhai's test/metrics.test.js asserts their /metrics shape; this fork's report carries more process diagnostics and a
// different persistence block, so the compatibility is checked here instead.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/index.js';
import { fetchSnapshot, startExporter } from '../deploy/monitoring/exporter/index.mjs';
import { renderMetrics } from '../deploy/monitoring/exporter/metrics.mjs';

async function boot(t) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, stateFile: 'off' });
  t.after(() => srv.close());
  const port = srv.port ?? srv.server?.address?.()?.port;
  return `http://127.0.0.1:${port}`;
}

test('/metrics is accepted by the collector and maps to the core series', async (t) => {
  const base = await boot(t);
  const snapshot = await fetchSnapshot(`${base}/metrics`);
  assert.equal(snapshot.ok, true);
  assert.equal(typeof snapshot.uptimeSec, 'number');
  assert.ok(snapshot.websocket?.diagnostics, 'the websocket diagnostics ride with the report');
  assert.ok(snapshot.memory, 'process memory is part of it');
  assert.equal(typeof snapshot.sockets, 'number');

  const targets = [{ name: 'local', url: `${base}/metrics` }];
  const states = new Map([['local', { data: snapshot, up: true, errors: 0, lastSuccess: 1, durationSeconds: 0.01 }]]);
  const text = renderMetrics(targets, states, 2);
  for (const name of ['sp_target_up', 'sp_uptime_seconds', 'sp_process_rss_bytes', 'sp_players_rooms', 'sp_players_sockets']) {
    assert.match(text, new RegExp(`^# TYPE ${name} gauge`, 'm'), `${name} is exported`);
  }
  assert.match(text, /^sp_target_up\{game="local"\} 1$/m);
  // Labels are the configured game name and fixed protocol types only — never a player, room or address.
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const labels = line.slice(line.indexOf('{'), line.indexOf('}') + 1);
    assert.doesNotMatch(labels, /player|token|ip=|room=/i, line);
  }
});

test('a real exporter poll reads the live game and reports it up', async (t) => {
  const base = await boot(t);
  const exporter = await startExporter({ targets: [{ name: 'live', url: `${base}/metrics` }], port: 0, intervalMs: 5000, timeoutMs: 3000 });
  t.after(() => exporter.close());
  await exporter.ready;
  const state = exporter.states.get('live');
  assert.equal(state.up, true, 'the game is reachable and speaks the JSON contract');
  const body = renderMetrics([{ name: 'live', url: `${base}/metrics` }], exporter.states, Date.now() / 1000);
  assert.match(body, /^sp_target_up\{game="live"\} 1$/m);
  assert.match(body, /^sp_process_cpu_available\{game="live"\} 1$/m);
});
