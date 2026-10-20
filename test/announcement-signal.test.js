import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnnouncementSignal } from '../server/announcement.js';
import { startServer } from '../server/index.js';
import WebSocket from 'ws';
import { once } from 'node:events';

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
test('announcement heartbeats share one read and signal edits, popup changes and withdrawal without private revisions', async () => {
  let now = 0, calls = 0, notice = null, popup = null, fail = false;
  const read = async () => { calls++; if (fail) throw Error(); return notice; };
  read.popup = () => popup;
  read.delivery = () => ({ revision: 'private' });
  const signal = createAnnouncementSignal(read, { now: () => now });
  for (let i = 0; i < 50; i++) assert.equal(signal(), null);
  await settle();
  const empty = signal(); assert.match(empty, /^[a-f0-9]{24}$/); assert.equal(calls, 1);
  notice = { id: 'a', text: 'maintenance' }; now += 1001; assert.equal(signal(), empty); await settle();
  const first = signal(); assert.notEqual(first, empty);
  notice = { ...notice, text: 'edited same id' }; now += 1001; signal(); await settle();
  const edited = signal(); assert.notEqual(edited, first);
  popup = { id: 'popup' }; now += 1001; signal(); await settle(); assert.notEqual(signal(), edited);
  notice = null; popup = null; now += 1001; signal(); await settle(); assert.equal(signal(), empty);
  fail = true; now += 1001; signal(); await settle(); assert.equal(signal(), empty, 'read errors do not invent a revision');
});

test('the server supplies optional revision hints on pre-login heartbeat replies', async () => {
  const server = await startServer({ port: 0, host: '127.0.0.1', stateFile: 'off', workers: 0, quiet: true });
  const ws = new WebSocket(server.url.replace(/^http/, 'ws') + '/ws');
  try {
    await once(ws, 'open');
    const ping = async (c) => { const reply = once(ws, 'message'); ws.send(JSON.stringify({ t: 'ping', c })); return JSON.parse(String((await reply)[0])); };
    await ping(1);
    let pong;
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20)); pong = await ping(i + 2);
      if (pong.announcementRevision) break;
    }
    assert.equal(pong.t, 'pong'); assert.match(pong.announcementRevision, /^[a-f0-9]{24}$/);
    assert.deepEqual(Object.keys(pong).sort(), ['announcementRevision', 'c', 's', 't']);
  } finally { ws.terminate(); await server.close(); }
});
