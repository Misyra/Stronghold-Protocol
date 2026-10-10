// test/wire-frames.test.js — outbound wire counters (/healthz `wire`) and the single-stringify frames
// (net.js ENCODED: the m.public / m.private dedup strings and the per-field snapshot emit are reused as
// the wire form instead of being stringified a second time).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { startServer } from '../server/index.js';
import { wireStats, wireStatsSnapshot } from '../server/net.js';
import { publicWireFrame } from '../server/match/Match.js';
import { TestClient } from './helpers/wsClient.js';

function httpReq(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET', agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

const healthz = async (port) => JSON.parse((await httpReq(port, '/healthz')).body.toString());

async function connect(t, serverOptions = {}) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, ...serverOptions });
  t.after(() => srv.close());
  const connection = once(srv.wss, 'connection');
  const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  t.after(() => client.close());
  await connection;
  return { srv, client };
}

test('publicWireFrame splices serverNow into the dedup string as valid JSON', () => {
  const view = { t: 'm.public', phase: 'COMBAT', round: 3, deadline: 0, serverNow: 1234, players: [{ playerId: 'p_a' }], fields: [] };
  const { serverNow, ...rest } = view;
  const json = JSON.stringify(rest);
  const wire = publicWireFrame(json, serverNow);
  assert.ok(wire != null && wire !== json);
  assert.deepEqual(JSON.parse(wire), view, 'the spliced frame parses to the full view, serverNow included');
  assert.equal(publicWireFrame('{"t":"other"}', 1), null, 'another leading layout falls back to a full encode');
  assert.equal(publicWireFrame(json, Number.NaN), null, 'a non-finite clock falls back to a full encode');
});

test('wire counters in /healthz grow per frame type', async (t) => {
  const { srv, client } = await connect(t);
  const welcome = await client.hello('线帧校验');
  assert.ok(welcome.token);
  const first = await healthz(srv.port);
  assert.ok(first.wire && first.wire.frames >= 1 && first.wire.bytes > 0, 'queued frames are counted');
  assert.ok(first.wire.byType.welcome && first.wire.byType.welcome.frames >= 1, 'the welcome frame is labelled');

  const before = wireStatsSnapshot();
  await client.request({ t: 'ping', c: 7 });
  const after = wireStatsSnapshot();
  assert.ok(after.byType.pong.frames > (before.byType.pong?.frames || 0), 'the pong reply is labelled');
  assert.ok(after.frames > before.frames && after.bytes > before.bytes);
  // byType is a plain-object snapshot of the module counters (which keep counting for other servers)
  assert.ok(wireStats.frames >= after.frames);
});

test('m.public frames through the spliced wire form still parse with serverNow', async (t) => {
  const { srv, client } = await connect(t);
  await client.hello('快照校验');
  await client.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
  await client.waitFor('room.state');
  await client.request({ t: 'room.start' });
  // every m.public of a started match goes through publicWireFrame; a malformed splice would fail here
  const pub = await client.waitFor('m.public', (m) => m.phase !== 'LOBBY', 8000);
  assert.ok(Number.isFinite(pub.serverNow), 'serverNow rides every m.public');
  assert.ok(pub.players.length === 1 && pub.combatMode === 'client');
  await client.request({ t: 'room.leave' });
});
