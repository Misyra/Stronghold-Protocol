import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { wsOriginAllowed, parseWsOrigins } from '../server/http/websocket.js';
import { startServer } from '../server/index.js';

const req = (origin, host = 'game.example.com') => ({ headers: { origin, host } });

test('the /ws origin gate: absent Origin passes, same host passes, anything else is refused', () => {
  assert.equal(wsOriginAllowed(req(undefined)), true, 'a non-browser client sends no Origin');
  assert.equal(wsOriginAllowed(req('')), true);
  assert.equal(wsOriginAllowed(req('https://game.example.com')), true);
  assert.equal(wsOriginAllowed(req('https://game.example.com:16657', 'game.example.com')), true,
    'nginx forwards Host without the port, so the browser\'s own port must not refuse its upgrade');
  assert.equal(wsOriginAllowed(req('https://other.example:16657', 'game.example.com')), false, 'a different name is still refused');
  assert.equal(wsOriginAllowed(req('http://game.example.com:8080', 'game.example.com:8080')), true);
  assert.equal(wsOriginAllowed(req('https://evil.example')), false);
  assert.equal(wsOriginAllowed(req('null')), false, 'an opaque origin is refused');
  assert.equal(wsOriginAllowed(req('not a url')), false);
  assert.equal(wsOriginAllowed(req('https://evil.example'), ['evil.example']), true, 'SP_WS_ORIGINS allowlists a host');
  assert.deepEqual(parseWsOrigins(' a.example ,B.example, '), ['a.example', 'b.example']);
});

test('a real server refuses an upgrade from another origin and accepts its own host and bare clients', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ws-origin-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, quiet: true, workers: 0, store: null,
    announcementFile: null, ipBanFile: path.join(dir, 'bans.jsonl') });
  t.after(async () => { await server.close(); fs.rmSync(dir, { recursive: true }); });
  const url = server.url.replace('http:', 'ws:') + '/ws';
  const host = server.url.replace(/^http:\/\//, '');

  const attempt = (headers) => new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('open', () => { ws.terminate(); resolve('open'); });
    ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve('status ' + res.statusCode); });
    ws.on('error', () => resolve('error'));
  });

  assert.equal(await attempt({ origin: 'https://evil.example', host }), 'status 403');
  assert.equal(await attempt({ origin: 'http://' + host, host }), 'open');
  assert.equal(await attempt({ host }), 'open');
});
