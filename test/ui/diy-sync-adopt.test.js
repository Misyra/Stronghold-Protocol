// The ok reply of room.diy carries the picks the server actually kept (shared/protocol.js checkDiyPicks drops the
// illegal ones; server/lobby.js diy): the sync's `adopt` writes that copy back, so the surface self-corrects instead
// of re-sending the refused picks on every edit. A reply without the field (an older server) changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../public/js/store.js';
import { installDiySync } from '../../public/js/ui/loadoutSync.js';

const ticks = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

const SENT = { s1: { charId: 'chess_char_4011_a' }, s2: { charId: 'chess_char_1021_a', skillIndex: 2 } };
const KEPT = { s1: { charId: 'chess_char_4011_a' } };

function harness({ reply } = {}) {
  const listeners = new Map(), pending = new Map();
  let time = 0, timerId = 0;
  const timers = {
    setTimeout(fn, ms) { const id = ++timerId; pending.set(id, { fn, at: time + ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    async advance(ms) {
      time += ms;
      for (const [id, task] of [...pending]) if (task.at <= time) { pending.delete(id); task.fn(); await ticks(); }
      await ticks();
    },
  };
  const net = {
    status: 'online', sent: [],
    on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    emit(name, msg = {}) { listeners.get(name)?.(msg); },
    async request(t, fields) { net.sent.push({ t, ...fields }); return reply ?? { t: 'ok' }; },
  };
  const target = createStore({ diy: SENT, diySync: 'idle', open: true });
  const content = createStore({ status: 'ready', kitted: null });
  const sync = installDiySync({ net, timers, target, content, app: null, gate: () => true });
  return { net, timers, target, ...sync };
}

test('room.diy 的 ok 带回服务器保留的 picks：本地采纳被裁剪后的副本，随后一次 flush 收敛、不再重发', async (t) => {
  const h = harness({ reply: { t: 'ok', picks: KEPT } });
  t.after(h.dispose);
  await h.flush();
  assert.deepEqual(h.target.get().diy, KEPT);
  assert.equal(h.target.get().diySync, 'synced');
  await h.timers.advance(1000); // the write-back's own flush converges (payload equals lastSent)
  assert.equal(h.net.sent.length, 1);
  assert.equal(h.target.get().diySync, 'synced');
});

test('服务器原样保留时不采纳、不产生额外请求', async (t) => {
  const h = harness({ reply: { t: 'ok', picks: SENT } });
  t.after(h.dispose);
  await h.flush();
  assert.deepEqual(h.target.get().diy, SENT);
  await h.timers.advance(1000);
  assert.equal(h.net.sent.length, 1);
  assert.equal(h.target.get().diySync, 'synced');
});

test('ok 不带 picks 字段（旧服务器）时行为不变', async (t) => {
  const h = harness({ reply: { t: 'ok' } });
  t.after(h.dispose);
  await h.flush();
  assert.deepEqual(h.target.get().diy, SENT);
  assert.equal(h.target.get().diySync, 'synced');
});
