// test/match/broadcast-encode.test.js — the pre-encoded broadcast chain (MatchMessaging → sendFn / broadcastFn).
//
// messaging.js stringifies each m.private / m.public view exactly once: the dedup baseline and the wire bytes come
// from the same JSON.stringify, and the bytes ride down as `encoded` (lobby.js matchSend / matchBroadcast reuse them
// instead of running encode(msg) again). The invariant these tests pin: for every view frame `encoded` is
// byte-for-byte what the transport's own encode(msg) would have produced, so removing the second serialization can
// never change the wire; every other frame (toasts, tickers, results) carries no encoded and is encoded once
// downstream, exactly as before. The public dedup baseline stays the old text too: the full stringify with
// `"serverNow":…,` spliced out (messaging.js _maybeSendPublic), asserted here against the same view.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';
import { botPrepBegin } from '../../server/match/bot.js';

const script = () => ({ duration: 2, leaks: {}, bossDps: 1e9 });

test('每个 m.private / m.public 的 encoded 字节等于 encode(msg) 的输出;其他帧不携带 encoded', () => {
  const h = makeMatch({ humans: 2, bots: 2, seed: 7, fake: true, botRehearsal: 0, script });
  const m = h.m;
  let pub = 0, priv = 0;
  const send = m.sendFn, broadcast = m.broadcastFn;
  // 断言在发送的同一同步时刻做:视图可能借用活数组(stateTransport 的基线之所以解析字节),滞后 stringify 会把
  // 借用状态的变化误算进来
  m.sendFn = (id, msg, encoded) => {
    if (msg.t === 'm.private') { assert.equal(encoded, JSON.stringify(msg), 'm.private 的 encoded 必须是这次 stringify 的字节'); priv++; }
    else assert.equal(encoded ?? null, null, `${msg.t} 不携带 encoded`);
    return send(id, msg);
  };
  m.broadcastFn = (msg, encoded) => {
    if (msg.t === 'm.public') { assert.equal(encoded, JSON.stringify(msg), 'm.public 的 encoded 必须是这次 stringify 的字节'); pub++; }
    else assert.equal(encoded ?? null, null, `${msg.t} 不携带 encoded`);
    broadcast(msg);
  };
  try {
    h.start();
    h.toPrep(2);
    for (const ps of m.order) if (ps.isBot) botPrepBegin(m, ps);
    // real intents on a human seat: shop refresh / freeze touch private and public state, flush drives both lanes
    m.handle('p_0', { t: 'g.refresh' });
    m.handle('p_0', { t: 'g.freeze', slot: 0 });
    m.flush(true);
    assert.ok(pub > 0 && priv > 0, `两种帧都捕到(public ${pub}, private ${priv})`);
    h.invariants();
  } finally { m.dispose(); }
});

test('公共去重基线:线上字节剥掉 serverNow 后与旧实现的去重串逐字节一致;只有时钟走动不重发', () => {
  const h = makeMatch({ mode: 'solo', humans: 1, seed: 7, fake: true, botRehearsal: 0, script });
  const m = h.m;
  let pubFrames = 0, lastRestJson = null, lastWire = null;
  m.broadcastFn = (msg, encoded) => {
    if (msg.t !== 'm.public') return;
    pubFrames++;
    // 旧实现 (messaging.js):const { serverNow, ...rest } = view; JSON.stringify(rest) — 对象展开把键置为
    // undefined,stringify 时整个条目消失,与旧去重串字节一致
    lastRestJson = JSON.stringify({ ...msg, serverNow: undefined });
    lastWire = encoded;
  };
  try {
    h.start();
    h.toPrep(2);
    m.flush(true);
    assert.ok(lastWire && lastRestJson, '已有 m.public 发出');
    assert.equal(m._lastPubJson, lastRestJson, '去重基线 = 线上字节剥掉 serverNow');
    assert.ok(lastWire.includes('"serverNow":'), '线上字节仍带 serverNow');

    // 只推时钟(状态一个字段都没动):serverNow 变了,内容没变 → 节流窗外同样不重发
    const sent = pubFrames;
    h.sched.advance(200); // > DELAYS.PUBLIC_THROTTLE (100)
    m.markPublic();
    m.flush();
    assert.equal(pubFrames, sent, '只有 serverNow 变化:不重发');
    assert.equal(m._lastPubJson, lastRestJson, '去重基线未变');

    // 对照:真实的公共变化(lp 是公共字段)照常重发,encoded 仍是那次 stringify
    const baseline = m._lastPubJson;
    const ps = h.ps('p_0');
    ps.lp -= 1;
    ps.dirty();
    m.flush();
    assert.equal(pubFrames, sent + 1, '真实公共变化:重发');
    assert.ok(lastWire.includes('"serverNow":'), '新帧的线上字节仍带 serverNow');
    assert.notEqual(m._lastPubJson, baseline, '基线随内容前进');
  } finally { m.dispose(); }
});
