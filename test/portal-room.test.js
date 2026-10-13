import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { createPortalRoomHandler } from '../server/http/portalRoom.js';

const key = 'a'.repeat(64), token = 'b'.repeat(32);
async function fixture(t, overrides = {}) {
  let at = 1800000000000, calls = 0, remote;
  const room = { code: 'ABCD', hostId: 'host' }, session = { playerId: 'host', connected: true };
  const handler = createPortalRoomHandler({ registry: { byToken: (value) => value === token ? session : null },
    lobby: { roomOf: () => room, getRoomStatus: () => ({ joinable: true }) },
    url: 'https://portal.example', siteId: 'test', key, now: () => at,
    fetchImpl: async (url, options) => { calls++; remote = { url, ...options }; return new Response(null, { status: 200 }); },
    ...overrides });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/api/portal-room`;
  const post = (extra = {}) => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json', ...extra.headers }, body: JSON.stringify({ code: 'ABCD' }), ...extra });
  return { url, post, session, room, advance: () => { at += 60001; }, calls: () => calls, remote: () => remote };
}

test('relay authenticates current room host and signs only server-selected destination and room', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post({ headers: {} })).status, 401);
  f.session.playerId = 'guest'; assert.equal((await f.post()).status, 403);
  f.session.playerId = 'host';
  assert.equal((await f.post({ headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' } })).status, 403);
  const response = await f.post();
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
  assert.equal(f.calls(), 1);
  const remote = f.remote(), h = remote.headers;
  assert.equal(remote.url.href, 'https://portal.example/api/rooms/from-game');
  assert.equal(remote.redirect, 'error');
  assert.equal(h['X-Portal-Signature'], createHmac('sha256', key)
    .update(`POST\n/api/rooms/from-game\ntest\n${h['X-Portal-Timestamp']}\n${h['X-Portal-Nonce']}\n${remote.body}`).digest('hex'));
  assert.equal((await f.post()).status, 429); assert.equal(f.calls(), 1);
  f.advance(); assert.equal((await f.post()).status, 200);
});

test('relay rejects stale room clicks, oversized body and non-joinable rooms without outbound requests', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post({ body: JSON.stringify({ code: 'EFGH', url: 'https://evil.example' }) })).status, 409);
  f.advance(); assert.equal((await f.post({ body: JSON.stringify({ code: 'ABCD', pad: 'x'.repeat(200) }) })).status, 413);
  assert.equal(f.calls(), 0);
  const full = await fixture(t, { lobby: { roomOf: () => ({ hostId: 'host', code: 'ABCD' }), getRoomStatus: () => ({ joinable: false }) } });
  assert.equal((await full.post()).status, 409);
});

test('relay is opt-in and fails closed for partial or unsafe configuration', async (t) => {
  const f = await fixture(t, { url: '', siteId: '', key: '' });
  assert.deepEqual(await (await fetch(f.url)).json(), { enabled: false });
  assert.equal((await f.post()).status, 503);
  assert.throws(() => createPortalRoomHandler({ url: 'http://evil.example', siteId: 'test', key }), /HTTPS/);
  assert.throws(() => createPortalRoomHandler({ url: 'https://portal.example', siteId: 'test', key: 'short' }), /configuration/);
});

test('relay reserves cooldown before awaiting outbound requests and hides remote errors', async (t) => {
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { fetchImpl: async () => { entered(); await blocked; return new Response('secret remote error', { status: 401 }); } });
  const first = f.post();
  await started;
  assert.equal((await f.post()).status, 429);
  release(); const response = await first;
  assert.equal(response.status, 502); assert.ok(!(await response.text()).includes('secret'));
});
