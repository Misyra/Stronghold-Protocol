// test/state-delta.test.js — the state-delta transport end to end at the unit level: negotiation, shared transitions,
// the process-global sequence, the counters, the SP_STATE_DELTA_VERIFY replay, the browser decoder and a whole match.
//
// Ported from the archive repository's test/state-delta.test.js and adapted to this repository: only m.public is a
// delta channel here (DELTA_KINDS), the hello field is named `delta`, the browser receiver is `net._receiver`, and
// the archive's wireStats / ENCODED accounting has no counterpart in this build, so its last test is not ported.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffState, applyStatePatch, StateReceiver } from '../shared/stateDelta.js';
import {
  negotiateStateDelta, prepareStateFrame, resetStateDelta, stateDeltaStats,
} from '../server/stateTransport.js';
import { send, NET_DEFAULTS } from '../server/net.js';
import { Net } from '../public/js/net.js';
import { validateC2S } from '../shared/protocol.js';
import { makeMatch, legalTileFor } from './match/harness.js';

const makeView = (extra = {}) => ({ t: 'm.public', playerId: 'p1', funds: 10,
  board: [{ uid: 1, row: 2, col: 3, items: [] }], padding: 'unchanged'.repeat(300), ...extra });
const socket = () => ({ readyState: 1, bufferedAmount: 0, frames: [],
  send(data) { this.frames.push(JSON.parse(data)); }, terminate() { this.readyState = 3; } });
const frame = (ws, view) => prepareStateFrame(ws, view, JSON.stringify(view));
const wire = (f) => JSON.parse(f.data);

test('JSON exactness: object deletes/adds, nulls, array length/type changes, nested player/board fields', () => {
  const before = { t: 'm.public', removed: 2, nullable: { x: 1 }, players: [{ hp: 12, board: [null, { col: 4 }] }], empty: [] };
  const after = { t: 'm.public', added: false, nullable: null, players: [{ hp: 8, board: [null, { col: 5, dir: 'UP' }] }], empty: [1] };
  const saved = structuredClone(before);
  assert.deepEqual(applyStatePatch(before, diffState(before, after)), after);
  assert.deepEqual(before, saved);
  let seed = 17;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const value = (depth) => {
    const n = random();
    if (!depth) return [null, true, false, n, String(n)][n % 5];
    if (n % 3 === 0) return Array.from({ length: n % 5 }, () => value(depth - 1));
    if (n % 3 === 1) return Object.fromEntries(Array.from({ length: n % 5 }, (_, i) => ['k' + i, value(depth - 1)]));
    return value(0);
  };
  for (let i = 0; i < 500; i++) {
    const a = { t: 'm.public', data: value(4) }, b = { t: 'm.public', data: value(4) };
    assert.deepEqual(applyStatePatch(a, diffState(a, b)), b);
  }
});

test('unsafe/malformed patches are rejected atomically; previous views and prototypes stay intact', () => {
  const base = makeView();
  for (const op of [
    [['__proto__', 'polluted'], true], [['constructor', 'prototype', 'polluted'], true],
    [['board', -1], null], [['board', '0'], null], [['board', 0]], [['absent', 'x'], 1],
    [['t'], 'm.private'], [[], null], [['funds'], 1, 2],
  ]) {
    assert.throws(() => applyStatePatch(base, [[['funds'], 0], op]));
    assert.equal(base.funds, 10);
    assert.equal({}.polluted, undefined);
  }
  assert.equal(diffState({}, JSON.parse('{"__proto__":{"x":1}}')), null);
  assert.equal(diffState({ t: 'm.public' }, {
    t: 'm.public', ...Object.fromEntries(Array.from({ length: 4097 }, (_, i) => ['k' + i, i])),
  }), null, 'bounded op count falls back to full');
  const deep = (leaf) => { for (let i = 0; i < 70; i++) leaf = { value: leaf }; return { t: 'm.public', nested: leaf }; };
  assert.equal(diffState(deep(1), deep(2)), null, 'bounded path depth falls back to full');
});

test('negotiation: legacy/unknown versions retain exact full JSON, new clients get full then a small delta', () => {
  const a = makeView(), b = makeView({ funds: 9 });
  for (const version of [undefined, 0, 2]) {
    const ws = socket();
    negotiateStateDelta(ws, version);
    assert.equal(frame(ws, a).data, JSON.stringify(a));
  }
  const ws = socket();
  negotiateStateDelta(ws, 1);
  const first = frame(ws, a);
  assert.deepEqual(wire(first).full, a);
  first.commit();
  const next = frame(ws, b);
  assert.deepEqual(wire(next).patch, [[['funds'], 9]]);
  assert.equal(wire(next).base, wire(first).seq);
  assert.ok(Buffer.byteLength(next.data) < Buffer.byteLength(first.data) / 10);
  const rx = new StateReceiver();
  assert.deepEqual(rx.receive(wire(first)).message, a);
  assert.deepEqual(rx.receive(wire(next)).message, b);
});

test('a broadcast shares one transition and one sequence; mutable source views cannot corrupt the baseline', () => {
  const sockets = [socket(), socket(), socket(), socket()];
  const a = makeView();
  const firstSeqs = [];
  for (const ws of sockets) {
    negotiateStateDelta(ws, 1);
    const f = frame(ws, a);
    firstSeqs.push(wire(f).seq);
    f.commit();
  }
  assert.equal(new Set(firstSeqs).size, 1, 'the same snapshot carries one process-wide number');
  a.board[0].col = 7; // like an upstream view borrowing a mutable game array
  const b = makeView({ funds: 8 });
  const encodings = sockets.map((ws) => frame(ws, b).data);
  assert.ok(encodings.every((s) => s === encodings[0]), 'the transition is computed once and shared');
  assert.deepEqual(JSON.parse(encodings[0]).patch, [[['funds'], 8]]);
});

test('stateDeltaStats: one parse per snapshot, and the split between full and delta frames', () => {
  const before = { ...stateDeltaStats };
  const sockets = [socket(), socket(), socket()];
  for (const ws of sockets) negotiateStateDelta(ws, 1);
  const view = makeView();
  const encoded = JSON.stringify(view);
  const first = sockets.map((ws) => prepareStateFrame(ws, view, encoded));
  for (const f of first) f.commit();
  assert.equal(stateDeltaStats.frames - before.frames, 3);
  assert.equal(stateDeltaStats.fullFrames - before.fullFrames, 3);
  assert.equal(stateDeltaStats.parsedBaselines - before.parsedBaselines, 1, 'three recipients parse the snapshot once');

  const next = { ...view, funds: 11 };
  const nextEncoded = JSON.stringify(next);
  const second = sockets.map((ws) => prepareStateFrame(ws, next, nextEncoded));
  for (const f of second) f.commit();
  const deltas = second.map(wire);
  assert.ok(deltas.every((f) => Array.isArray(f.patch)), 'every recipient gets the patch');
  assert.ok(deltas.every((f) => f.base === wire(first[0]).seq && f.seq === deltas[0].seq));
  assert.equal(stateDeltaStats.deltaFrames - before.deltaFrames, 3);
  assert.equal(stateDeltaStats.parsedBaselines - before.parsedBaselines, 2);
});

test('a resend of the connection baseline is full under a fresh number, never a rewound one', () => {
  const ws = socket();
  negotiateStateDelta(ws, 1);
  const view = makeView();
  const encoded = JSON.stringify(view);
  const first = prepareStateFrame(ws, view, encoded);
  first.commit();
  const again = prepareStateFrame(ws, view, encoded); // the very same bytes
  assert.ok('full' in wire(again), 'a duplicate is re-sent whole');
  assert.ok(wire(again).seq > wire(first).seq, 'with a number ahead of the baseline it replaces');
  again.commit();
  const changedView = { ...view, funds: 12 };
  const changed = prepareStateFrame(ws, changedView, JSON.stringify(changedView));
  assert.equal(wire(changed).base, wire(again).seq, 'the following delta builds on the fresh baseline');
});

test('failed sends do not advance the baseline; reliable state retains backpressure thresholds and FIFO', () => {
  const ws = socket();
  negotiateStateDelta(ws, 1);
  assert.equal(send(ws, makeView()), true);
  ws.send = () => { throw new Error('send failure'); };
  assert.equal(send(ws, makeView({ funds: 9 })), false);
  ws.send = function (data) { this.frames.push(JSON.parse(data)); };
  ws.bufferedAmount = NET_DEFAULTS.snapDropBytes + 1;
  assert.equal(send(ws, makeView({ funds: 8 })), true, 'state is reliable, never droppable');
  assert.equal(ws.frames[1].base, ws.frames[0].seq);
  assert.deepEqual(ws.frames[1].patch, [[['funds'], 8]]);
  assert.equal(send(ws, { t: 'ok', rid: 1 }), true);
  assert.equal(ws.frames[2].t, 'ok');
  ws.bufferedAmount = NET_DEFAULTS.hardBufferBytes + 1;
  assert.equal(send(ws, makeView({ funds: 7 })), false);
  assert.equal(ws.readyState, 3);
});

test('public baselines are per connection and isolated; m.private keeps its plain encoding; reset uses full', () => {
  const ws = socket(), other = socket();
  for (const s of [ws, other]) negotiateStateDelta(s, 1);
  send(ws, makeView());
  send(ws, makeView({ funds: 9 }));
  send(other, makeView({ playerId: 'p2', funds: 77 }));
  assert.equal(ws.frames[1].base, ws.frames[0].seq);
  assert.equal(other.frames[0].full.funds, 77, 'a second connection starts from its own full frame');
  assert.equal(send(ws, { t: 'm.private', playerId: 'p1', funds: 10 }), true);
  assert.equal(ws.frames.at(-1).t, 'm.private', 'm.private is not a delta channel in this build');
  resetStateDelta(ws);
  send(ws, makeView({ funds: 8 }));
  assert.ok(ws.frames.at(-1).full);
  assert.ok(ws.frames.at(-1).seq > ws.frames[1].seq);
});

test('gap/malformed delta emits no partial state; resync coalesces across channels until full recovery', () => {
  const rx = new StateReceiver(), a = makeView();
  rx.receive({ kind: a.t, seq: 1, full: a });
  assert.deepEqual(rx.receive({ kind: a.t, seq: 3, base: 2, patch: [[['funds'], 8]] }), { message: null, resync: true });
  assert.deepEqual(rx.receive({ kind: 'm.private', seq: 4, base: 1, patch: [] }), { message: null, resync: false });
  assert.deepEqual(rx.receive({ kind: a.t, seq: 5, base: 3, patch: [] }), { message: null, resync: false });
  assert.deepEqual(rx.receive({ kind: a.t, seq: 6, full: makeView({ funds: 8 }) }).message, makeView({ funds: 8 }));
  rx.receive({ kind: 'm.private', seq: 7, full: { t: 'm.private' } });
  const bad = rx.receive({ kind: a.t, seq: 8, base: 6, patch: [[['board', 0, 'col'], 1], [['absent', 'x'], 1]] });
  assert.equal(bad.resync, true);
  assert.equal(a.board[0].col, 3);
  rx.reset();
  assert.equal(rx.states.size, 0);
});

test('client dispatch reconstructs ordinary public views before listeners run; duplicates do not re-emit', () => {
  const net = new Net({ url: 'ws://test/ws' }), ws = socket(), events = [], requests = [];
  net.request = (t) => { requests.push({ t }); return Promise.resolve(); };
  net.on('m.public', (msg) => events.push(msg));
  negotiateStateDelta(ws, 1);
  send(ws, makeView());
  send(ws, makeView({ funds: 9 }));
  for (const f of ws.frames) net._onMessage(JSON.stringify(f));
  net._onMessage(JSON.stringify(ws.frames[1]));
  assert.equal(events.length, 2, 'the duplicate frame is never emitted twice');
  assert.equal(events[0].t, 'm.public');
  assert.equal(events[0].funds, 10);
  assert.equal(events[1].funds, 9);
  // a frame ahead of the baseline cannot be applied: one rate-limited state.resync asks for a full one
  net._onMessage(JSON.stringify({ t: 'm.state', kind: 'm.public', seq: 100, base: 99, patch: [] }));
  assert.deepEqual(requests, [{ t: 'state.resync' }]);
  net._teardownSocket();
  assert.equal(net._receiver.states.size, 0);
  assert.equal(validateC2S({ t: 'hello', name: 'test', delta: 1 }), null);
  assert.equal(validateC2S({ t: 'state.resync' }), null);
  assert.notEqual(validateC2S({ t: 'hello', name: 'test', delta: '1' }), null);
});

test('SP_STATE_DELTA_VERIFY replays every emitted delta against the state it describes', () => {
  const before = { verifyChecked: stateDeltaStats.verifyChecked, verifyMismatches: stateDeltaStats.verifyMismatches };
  process.env.SP_STATE_DELTA_VERIFY = '1';
  try {
    const ws = socket();
    negotiateStateDelta(ws, 1);
    const a = makeView();
    frame(ws, a).commit();
    const b = makeView({ funds: 9, board: [{ uid: 1, row: 2, col: 3, items: [{ id: 'x' }] }] });
    const delta = frame(ws, b);
    assert.ok(Array.isArray(wire(delta).patch));
    assert.equal(stateDeltaStats.verifyChecked - before.verifyChecked, 1, 'the emitted delta was replayed');
    assert.equal(stateDeltaStats.verifyMismatches - before.verifyMismatches, 0, 'and agreed with the state');
  } finally {
    delete process.env.SP_STATE_DELTA_VERIFY;
  }
});

test('complete scripted match: every reconstructed public view equals the original across purchases, moves and phases', () => {
  // SP_STATE_DELTA_VERIFY replays every emitted delta through the client decoder and compares it with the server's own
  // state (stateTransport.verifyTransition): the full-match proof for the invariant
  // "差分基线必须跟实际发送一致" — the deltas are checked, not assumed.
  const before = { verifyChecked: stateDeltaStats.verifyChecked, verifyMismatches: stateDeltaStats.verifyMismatches };
  process.env.SP_STATE_DELTA_VERIFY = '1';
  const h = makeMatch({ humans: 4, seed: 7, fake: true, captureFrames: false,
    script: () => ({ duration: 2, leaks: {}, bossDps: 1e9 }) });
  const peers = new Map(h.m.order.map((ps) => {
    const ws = socket(); negotiateStateDelta(ws, 1);
    return [ps.playerId, { ws, rx: new StateReceiver() }];
  }));
  const phases = new Set();
  let checked = 0, patches = 0;
  const deliver = (id, msg, encoded = JSON.stringify(msg)) => {
    const { ws, rx } = peers.get(id);
    assert.equal(send(ws, msg, encoded), true);
    const sent = ws.frames.pop();
    if (msg.t === 'm.private') {
      assert.equal(sent.t, 'm.private', 'private views stay plain in this build');
      return;
    }
    if (msg.t === 'm.result') { rx.reset(); return; }
    if (msg.t !== 'm.public') return;
    assert.equal(sent.t, 'm.state');
    const decoded = rx.receive(sent);
    assert.equal(decoded.resync, false);
    assert.deepEqual(decoded.message, JSON.parse(encoded), `m.public R${h.m.round} ${h.m.phase}`);
    checked++; if (sent.patch) patches++;
    if (msg.phase) phases.add(msg.phase);
  };
  h.onSend.push(deliver);
  h.onBroadcast.push((msg) => {
    const encoded = JSON.stringify(msg);
    for (const id of peers.keys()) deliver(id, msg, encoded);
  });
  try {
    h.start(); h.toPrep();
    const ps = h.ps('p_0');
    assert.ok(h.m.handle(ps.playerId, { t: 'g.freeze' }).ok);
    const slot = ps.privateView().shop.slots.findIndex((s) => s?.kind === 'chess' && s.price <= ps.funds);
    assert.ok(slot >= 0);
    assert.ok(h.m.handle(ps.playerId, { t: 'g.buy', slot }).ok);
    const piece = ps.hand.find((p) => p?.kind === 'chess');
    const tile = legalTileFor(h.m, ps, piece.id);
    assert.ok(tile);
    assert.ok(h.m.handle(ps.playerId, { t: 'g.move', uid: piece.uid, to: { area: 'board', row: tile[0], col: tile[1] }, dir: 'UP' }).ok);
    assert.ok(h.m.handle(ps.playerId, { t: 'g.sell', uid: piece.uid }).ok);
    assert.ok(h.drive(() => h.ended !== null));
    assert.ok(checked > 100 && patches > 50, `checked ${checked}, patched ${patches}`);
    assert.ok(phases.has('PREP') && phases.has('INFO_CHECK') && phases.has('RESULT'));
    assert.equal(h.m.errorCount, 0);
    assert.ok(stateDeltaStats.verifyChecked - before.verifyChecked > 50, 'every transition was replayed');
    assert.equal(stateDeltaStats.verifyMismatches - before.verifyMismatches, 0, 'no delta disagreed with the state it describes');
  } finally {
    h.m.dispose();
    delete process.env.SP_STATE_DELTA_VERIFY;
  }
});
