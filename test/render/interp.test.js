// test/render/interp.test.js — snapshot interpolation buffer: clock, lerp, spawn/die mid-buffer, teleports,
// extrapolation guard, rate estimation, event stamping, robustness against junk.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotBuffer, normalizeSnapshot, isCosmeticEvent, frameTime, percentile95 } from '../../public/js/render/interp.js';

const fxFormOf = (e) => (e && e[0] === 'fx' && e[4] && Object.hasOwn(e[4], 'form') ? e[4].form : undefined);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const snap = (t, units) => ({ fieldId: 'n:1', t, units, dp: 10, killed: 0, total: 5 });
const U = (id, x, y, hp = 100, anim = 0, flags = 0) => [id, x, y, hp, 100, 5, 10, flags, anim];

/** Feed snapshots every 0.1 game s at 2× (every 50 ms real) starting at real time 0. */
function feed(buf, frames, t0 = 0, realStep = 0.05, gameStep = 0.1) {
  frames.forEach((units, i) => buf.push(snap(t0 + i * gameStep, units), i * realStep));
  return (frames.length - 1) * realStep;
}

describe('normalizeSnapshot', () => {
  test('rejects junk, keeps valid tuples, fills defaults', () => {
    assert.equal(normalizeSnapshot(null), null);
    assert.equal(normalizeSnapshot({ t: 'x' }), null);
    assert.equal(normalizeSnapshot({ t: NaN, units: [] }), null);
    const s = normalizeSnapshot({ t: 1, units: [U(1, 2, 3), [2, NaN, 1], 'x', [3], [{}, 1, 1], [4, 1, 2, 'hp']] });
    assert.deepEqual([...s.units.keys()], [1, 4]);
    assert.deepEqual(s.units.get(4), [4, 1, 2, 0, 0, 0, 0, 0, 0]);
  });

  test('wire frames: game time comes from `gt` (the frame `t` is the message type)', () => {
    const wire = { t: 'b.snap', fieldId: 'n:a', gt: 12.5, units: [U(1, 2, 9)], killed: 1, total: 3 };
    assert.equal(frameTime(wire), 12.5);
    assert.equal(normalizeSnapshot(wire).t, 12.5);
    assert.equal(frameTime({ t: 3.5 }), 3.5, 'raw Battle snapshot / recording');
    assert.equal(frameTime({ t: 3.5, gt: 4 }), 4, 'gt wins');
    assert.ok(Number.isNaN(frameTime({ t: 'b.snap' })));
    assert.ok(Number.isNaN(frameTime({ t: 'b.ev', gt: Infinity })));
    assert.ok(Number.isNaN(frameTime(null)));
    assert.equal(normalizeSnapshot({ t: 'b.snap', units: [] }), null, 'a wire frame without gt is unusable');
    // a buffer fed wire frames and gt-stamped events delivers the events at their snapshot time
    const b = new SnapshotBuffer({ delay: 0.1, rate: 2 });
    for (let i = 0; i <= 10; i++) {
      b.pushEvents([['dmg', 1, 5, 'phys']], i * 0.05, frameTime({ t: 'b.ev', gt: i * 0.1 }));
      assert.equal(b.push({ t: 'b.snap', gt: i * 0.1, units: [U(1, i * 0.1, 10)] }, i * 0.05), true);
    }
    assert.ok(near(b.newestT, 1.0));
    const due = b.takeEvents(0.55);
    assert.equal(due.length, 6, 'events stamped 0.0 … 0.5 are due at 0.55');
  });

  test('trusted (the local feed): the sim tuples are indexed as they are, samples match the guarded copy', () => {
    const tuple = U(1, 2, 3);
    const s = normalizeSnapshot({ t: 'b.snap', gt: 1, units: [tuple] }, true);
    assert.equal(s.units.get(1), tuple, 'no re-wrap: the buffer indexes the frame own tuple');
    assert.deepEqual([...s.units.get(1)], [1, 2, 3, 100, 100, 5, 10, 0, 0]);
    // junk inside a trusted frame still takes the guarded copy (or is dropped), like any wire frame
    const mixed = normalizeSnapshot({ t: 'b.snap', gt: 1, units: [U(2, 4, 5), [3, NaN, 1], 'x'] }, true);
    assert.equal(mixed.units.get(2).length, 9);
    assert.equal(mixed.units.has(3), false);
    assert.equal(mixed.units.has('x'), false);
    // and a buffer fed trusted frames samples exactly like one fed the same frames untrusted
    const frames = [];
    for (let i = 0; i <= 10; i++) frames.push([U(1, i * 0.1, 10)]);
    const a = new SnapshotBuffer({ delay: 0.1, rate: 2 });
    const b = new SnapshotBuffer({ delay: 0.1, rate: 2 });
    frames.forEach((units, i) => {
      // two separate frame objects: the trusted buffer may keep (and elem-extend) the tuples it is given
      a.push({ t: 'b.snap', gt: i * 0.1, units: units.map((u) => [...u]) }, i * 0.05);
      b.push({ t: 'b.snap', gt: i * 0.1, units: units.map((u) => [...u]) }, i * 0.05, true);
    });
    assert.deepEqual([...b.sample(0.55)], [...a.sample(0.55)]);
  });

  test('trusted: the elem view appends onto the reused tuple; a re-pushed frame with elem keeps its samples', () => {
    const tuple = U(1, 2, 3);
    const frame = { t: 'b.snap', gt: 1, units: [tuple], elem: [[1, 'burn', 0.5, 9, 4]] };
    const s = normalizeSnapshot(frame, true);
    assert.equal(s.units.get(1), tuple);
    assert.equal(tuple.length, 13, 'the elem entry rode onto the frame own tuple');
    assert.deepEqual([...tuple.slice(9)], ['burn', 0.5, 9, 4]);
    // the same frame normalized again (a stale re-push): the guarded copy rebuilds the tuple from its 9 fields
    const again = normalizeSnapshot(frame, true);
    assert.notEqual(again.units.get(1), tuple);
    assert.deepEqual([...again.units.get(1).slice(9)], ['burn', 0.5, 9, 4], 'elem is re-read from the frame list');
  });
});

test('face keeps ±1 for listed units and sample uses the older snapshot', () => {
  const s = normalizeSnapshot({ t: 1, units: [U(1, 2, 3), U(2, 4, 5)], face: [[1, 1], [2, -1], [9, 1], [1, 0], [2, 2]] });
  assert.deepEqual([...s.face], [[1, 1], [2, -1]]);
  assert.equal(normalizeSnapshot({ t: 1, units: [U(1, 0, 0)] }).face, null);
  const b = new SnapshotBuffer();
  b.push({ t: 0, units: [U(1, 0, 0)], face: [[1, 1]] });
  b.push({ t: 1, units: [U(1, 1, 0)] });
  assert.equal(b.sample(0).get(1).face, 1);
  assert.equal(b.sample(1).get(1).face, null);
});

describe('SnapshotBuffer', () => {
  test('render clock trails the newest snapshot by delay × rate', () => {
    const b = new SnapshotBuffer({ delay: 0.1, rate: 2 });
    const frames = [];
    for (let i = 0; i <= 20; i++) frames.push([U(1, i * 0.1, 10)]);
    const now = feed(b, frames);
    b.update(now);
    assert.ok(near(b.rate, 2, 0.05), `rate ${b.rate}`);
    assert.ok(near(b.renderT, b.newestT - 0.2, 0.03), `renderT ${b.renderT} newest ${b.newestT}`);
    // steady state: snapshots keep arriving every 50 ms real, frames every 16 ms → stays ~0.2 game s behind
    let t = 2, real = now;
    for (let i = 0; i < 60; i++) {
      real += 0.05; t += 0.1;
      b.push(snap(t, [U(1, t, 10)]), real);
      for (let f = 1; f <= 3; f++) b.update(real + f * 0.0166);
    }
    const lag = b.newestT - b.renderT;
    assert.ok(lag > 0.05 && lag < 0.25, `steady lag ${lag} (renderT ${b.renderT} newest ${b.newestT})`);
  });

  test('lerps positions / hp between bracketing snapshots; flags & anim from the older one', () => {
    const b = new SnapshotBuffer();
    b.push(snap(1.0, [U(1, 0, 10, 100, 1, 0)]), 0);
    b.push(snap(1.1, [U(1, 1, 10.5, 50, 2, 16)]), 0.05);
    const out = b.sample(1.05);
    const s = out.get(1);
    assert.ok(near(s.x, 0.5) && near(s.y, 10.25) && near(s.hp, 75));
    assert.equal(s.anim, 1);
    assert.equal(s.flags, 0);
    assert.ok(near(s.vx, 10) && near(s.vy, 5));
    const s2 = b.sample(1.1).get(1);
    assert.equal(s2.anim, 2);
    assert.equal(s2.flags, 16);
  });

  test('spawn mid-buffer appears only once renderT reaches it; die mid-buffer holds then disappears', () => {
    const b = new SnapshotBuffer();
    b.push(snap(0, [U(1, 0, 10), U(2, 5, 10)]), 0);
    b.push(snap(0.1, [U(1, 1, 10), U(3, 9, 12)]), 0.05);
    let out = b.sample(0.05);
    assert.ok(out.has(1) && out.has(2), 'dying unit still shown before the newer snapshot');
    assert.ok(!out.has(3), 'spawned unit not shown early');
    assert.ok(near(out.get(2).x, 5), 'holds last position');
    out = b.sample(0.1, out);
    assert.ok(out.has(3) && !out.has(2), 'sample map reused and pruned');
  });

  test('teleports (> teleport tiles between snapshots) snap instead of sliding', () => {
    const b = new SnapshotBuffer({ teleport: 2 });
    b.push(snap(0, [U(1, 0, 10)]), 0);
    b.push(snap(0.1, [U(1, 8, 10)]), 0.05);
    assert.equal(b.sample(0.05).get(1).x, 0);
    assert.equal(b.sample(0.1).get(1).x, 8);
  });

  test('a short parasite attachment blink snaps at its event time and does not create extrapolated walking', () => {
    const b = new SnapshotBuffer();
    b.push(snap(0, [U(1, 5.7, 9), U(2, 2, 9)]), 0);
    b.pushEvents([['fx', 'teleport', 5, 9, { id: 1, kind: 'parasite', fromX: 5.7, fromY: 9 }]], 0.05, 0.1);
    b.push(snap(0.1, [U(1, 5, 9), U(2, 2.2, 9)]), 0.05);
    assert.equal(b.sample(0.05).get(1).x, 5.7, 'hold at the contact point before the blink');
    assert.ok(near(b.sample(0.05).get(2).x, 2.1), 'ordinary movement still interpolates');
    b.takeEvents(0.1);
    assert.equal(b.sample(0.1).get(1).x, 5, 'the model jumps to the destination');
    assert.equal(b.sample(0.15).get(1).x, 5, 'a short blink does not extrapolate as a walk');
  });

  test('unrelated short teleport effects keep the usual interpolation and extrapolation', () => {
    const b = new SnapshotBuffer();
    b.push(snap(0, [U(1, 5.7, 9), U(2, 3.7, 9)]), 0);
    b.pushEvents([
      ['fx', 'teleport', 5, 9, { id: 1, kind: 'other' }],
      ['fx', 'teleport', 3, 9, { id: 2 }],
    ], 0.05, 0.1);
    b.push(snap(0.1, [U(1, 5, 9), U(2, 3, 9)]), 0.05);
    assert.ok(near(b.sample(0.05).get(1).x, 5.35));
    assert.ok(near(b.sample(0.05).get(2).x, 3.35));
    b.takeEvents(0.1);
    assert.ok(near(b.sample(0.15).get(1).x, 4.65));
    assert.ok(near(b.sample(0.15).get(2).x, 2.65));
  });

  test('extrapolation guard: never more than maxExtrapolate past the newest; then freezes', () => {
    const b = new SnapshotBuffer({ delay: 0.1, rate: 2, maxExtrapolate: 0.1 });
    const frames = [];
    for (let i = 0; i <= 10; i++) frames.push([U(1, i * 0.1, 10)]); // 1 tile/s game
    const now = feed(b, frames);
    b.update(now);
    for (let k = 1; k <= 200; k++) b.update(now + k * 0.02); // stream stalls for 4 s
    assert.ok(b.renderT <= b.newestT + 0.1 * b.rate + 1e-9, `renderT ${b.renderT}`);
    const s = b.sample();
    assert.ok(s.get(1).x <= 1.0 + 0.2 + 1e-6 && s.get(1).x >= 1.0, `extrapolated x ${s.get(1).x}`);
  });

  test('large lag snaps the clock; a stream restart (t jumps back) resets the buffer', () => {
    const b = new SnapshotBuffer({ delay: 0.1, rate: 2, snapAfter: 0.5 });
    b.push(snap(0, [U(1, 0, 10)]), 0);
    b.update(0);
    b.push(snap(30, [U(1, 3, 10)]), 0.1); // server jumped ahead
    b.update(0.11);
    assert.ok(b.renderT > 29, `snapped to ${b.renderT}`);
    b.pushEvents([['dmg', 1, 5, 'phys']], 0.12);
    assert.ok(b.push(snap(0.5, [U(9, 1, 1)]), 0.2), 'accepted after reset');
    assert.equal(b.size, 1);
    assert.equal(b.events.length, 0, 'old events dropped on restart');
  });

  test('duplicate / out-of-order / junk snapshots are ignored', () => {
    const b = new SnapshotBuffer();
    assert.ok(b.push(snap(1, [U(1, 0, 0)]), 0));
    assert.ok(!b.push(snap(1, [U(1, 9, 9)]), 0.01));
    assert.ok(!b.push(snap(0.9, [U(1, 9, 9)]), 0.02));
    assert.ok(!b.push({ t: 'no' }, 0.03));
    assert.ok(!b.push(null, 0.03));
    assert.equal(b.size, 1);
    assert.equal(b.sample(1).get(1).x, 0);
  });

  test('rate estimation follows the stream (1× and 4×) within clamps', () => {
    for (const rate of [1, 4]) {
      const b = new SnapshotBuffer({ rate: 2 });
      for (let i = 0; i < 80; i++) b.push(snap(i * 0.1, [U(1, 0, 0)]), i * 0.1 / rate);
      assert.ok(near(b.rate, rate, 0.1), `estimated ${b.rate} for ${rate}`);
    }
  });

  test('setNominalRate: a 2× battle clock starts at 4× (no half-speed first quarter second)', () => {
    // What a reset buffer does now: the arrival estimate is not trusted yet, so the clock runs at the old nominal rate.
    const slow = new SnapshotBuffer({ delay: 0.034, rate: 2 });
    slow.defaultRate = 4; // setLocalFeed's old assignment only
    // What setLocalFeed does now: the nominal rate moves the clock at once.
    const fast = new SnapshotBuffer({ delay: 0.034, rate: 2 });
    fast.setNominalRate(4);
    assert.equal(fast.defaultRate, 4);
    assert.equal(fast.rate, 4);
    assert.equal(fast.arrivals.length, 0);
    const run = (b) => {
      let now = 0, gt = 0;
      for (let i = 0; i < 20; i++) { // 60 fps, 4 game s per real s
        now += 1 / 60; gt += 4 / 60;
        b.push(snap(gt, [U(1, 0, 0)]), now);
        b.update(now);
      }
      return b.newestT - b.renderT;
    };
    assert.ok(run(fast) < 0.15, 'the clock trails by the local delay × 4 from the first frame');
    assert.ok(run(slow) > 0.28, 'without it the clock falls behind while the estimate catches up');
    // a repeat is a no-op (the arrival estimate keeps its window), and reset keeps the nominal rate
    fast.push(snap(10, [U(1, 0, 0)]), 3);
    const arrivals = fast.arrivals.length;
    fast.setNominalRate(4);
    assert.equal(fast.arrivals.length, arrivals);
    fast.reset();
    assert.equal(fast.rate, 4);
    fast.setNominalRate(2);
    assert.equal(fast.rate, 2);
  });

  test('adaptive delay: follows the stream\'s measured jitter, clamped, and the local feed keeps its own', () => {
    // a steady 2× stream (one snapshot each 0.05 real s): the p95 lateness is 0, so the delay settles on the minimum
    const steady = new SnapshotBuffer({ delay: 0.1, rate: 2, adaptive: true, minDelay: 0.05, maxDelay: 0.5, delayEase: 1, jitterMargin: 0 });
    let now = 0, t = 0;
    for (let i = 0; i < 40; i++) { now += 0.05; t += 0.1; steady.push(snap(t, [U(1, 0, 0)]), now); }
    assert.ok(steady.delay < 0.06, `steady delay ${steady.delay}`);
    assert.ok(steady.lateness.length > 0);
    // the same average cadence in alternating late / early arrivals (a 40 ms jitter): the window's p95 lifts the delay
    const jittery = new SnapshotBuffer({ delay: 0.05, rate: 2, adaptive: true, minDelay: 0.05, maxDelay: 0.5, delayEase: 1, jitterMargin: 0 });
    now = 0; t = 0;
    for (let i = 0; i < 40; i++) {
      now += i % 2 ? 0.01 : 0.09; t += 0.1;
      jittery.push(snap(t, [U(1, 0, 0)]), now);
    }
    assert.ok(jittery.delay > 0.08, `jitter delay ${jittery.delay}`);
    assert.ok(jittery.delay <= 0.5, 'clamped to maxDelay');
    // one long gap (under jitterGap) lifts the p95 far past maxDelay: the delay stops at maxDelay
    const capped = new SnapshotBuffer({ delay: 0.1, rate: 2, adaptive: true, minDelay: 0.05, maxDelay: 0.3 });
    now = 0; t = 0;
    for (let i = 0; i < 30; i++) {
      now += i === 20 ? 0.9 : 0.05; t += 0.1;
      capped.push(snap(t, [U(1, 0, 0)]), now);
    }
    assert.ok(capped.delay > 0.2 && capped.delay <= 0.3, `capped ${capped.delay}`);
    // a new nominal rate makes the old lateness samples incomparable: the window starts over
    capped.setNominalRate(4);
    assert.equal(capped.lateness.length, 0);
    assert.ok(Number.isNaN(capped.lastArrival));
  });

  test('drain: a finished feed runs its clock up to the newest snapshot (the tail is not held behind the jitter delay)', () => {
    const b = new SnapshotBuffer({ delay: 0.4, rate: 2, adaptive: true, minDelay: 0.4, maxDelay: 0.6 });
    let now = 0, t = 0;
    for (let i = 0; i < 20; i++) { now += 0.05; t += 0.1; b.push(snap(t, [U(1, 0, 0)]), now); }
    b.update(now);
    assert.ok(b.newestT - b.renderT > 0.5, `held behind the delay: ${b.newestT - b.renderT}`);
    b.drain();
    for (let i = 1; i <= 30; i++) b.update(now + i * 0.016);
    assert.ok(b.renderT >= b.newestT - 1e-6, `reached the end: ${b.renderT} / ${b.newestT}`);
    b.reset();
    assert.equal(b.draining, false, 'reset clears it for the next battle');
  });
  test('old snapshots are trimmed even without frames (hidden tab); events queue is bounded', () => {
    const b = new SnapshotBuffer({ keep: 1 });
    for (let i = 0; i < 200; i++) {
      b.push(snap(i * 0.1, [U(1, i, 0)]), i * 0.05);
      b.pushEvents([['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['dmg', 1, 5, 'phys'], ['die', i]], i * 0.05);
    }
    assert.ok(b.size < 40, `size ${b.size}`);
    assert.ok(b.events.length <= 6000, `events ${b.events.length}`);
    assert.equal(b.events.filter((e) => e.ev[0] === 'die').length, 200, 'state events never shed');
    b.update(10);
    const s = b.sample();
    assert.ok(s.get(1), 'sample available');
  });

  test('events: stamped inside the latest interval, delivered in order when renderT passes', () => {
    const b = new SnapshotBuffer({ delay: 0.1, rate: 2 });
    b.push(snap(0, [U(1, 0, 0)]), 0);
    b.push(snap(0.1, [U(1, 0, 0)]), 0.05);
    b.pushEvents([['atk', 1, 2, 'arrow'], ['dmg', 2, 50, 'phys'], 'junk', [5]], 0.05);
    b.push(snap(0.2, [U(1, 0, 0)]), 0.1);
    b.pushEvents([['die', 2]], 0.1);
    assert.equal(b.events.length, 3);
    assert.deepEqual(b.takeEvents(0.0), []);
    const first = b.takeEvents(0.06);
    assert.deepEqual(first.map((e) => e[0]), ['atk', 'dmg']);
    assert.deepEqual(b.takeEvents(0.2).map((e) => e[0]), ['die']);
    // server-provided stamp
    b.pushEvents([['skill', 1, 1]], 0.2, 0.15);
    b.pushEvents([['skill', 1, 0]], 0.2, 5);
    assert.deepEqual(b.takeEvents(0.16).map((e) => e[2]), [1]);
  });

  test('takeEvents can drop stale cosmetic events but keeps state events', () => {
    const b = new SnapshotBuffer();
    b.pushEvents([['dmg', 1, 5, 'phys'], ['die', 1], ['fx', 'burst', 1, 1, {}], ['spawn', { id: 3 }]], 0, 1);
    const out = b.takeEvents(10, [], 5);
    assert.deepEqual(out.map((e) => e[0]), ['die', 'spawn']);
    assert.ok(isCosmeticEvent(['atk']) && !isCosmeticEvent(['leak']) && !isCosmeticEvent(null));
    b.pushEvents([['leak', 4]], 0, 50);
    assert.deepEqual(b.flushEvents().map((e) => e[0]), ['leak']);
  });

  test('an enemy\'s form fx is state (player report #5 after 0.1.0): it survives the stale drop and the full-queue shed, a plain fx does not', () => {
    const form = (id, f) => ['fx', 'phase', 1, 1, { id, kind: f, form: f, dur: 2 }];
    assert.ok(!isCosmeticEvent(form(3, 'translator_youling')), 'a form fx is never cosmetic');
    assert.ok(!isCosmeticEvent(['fx', 'revive', 1, 1, { id: 3, form: null }]), 'back to the base clips (form null) too');
    assert.ok(isCosmeticEvent(['fx', 'phase', 1, 1, { id: 3, kind: 'artsBarrier' }]), 'a barrier phase stays cosmetic');
    // a 1 s stall at 2×: the render clock jumps past the 1.5 game s window
    const b = new SnapshotBuffer();
    b.pushEvents([['dmg', 3, 5, 'phys'], form(3, 'translator_youling'), ['fx', 'burst', 1, 1, {}]], 0, 1);
    const late = new Map();
    const out = b.takeEvents(10, [], 10 - 1.5, late);
    assert.deepEqual(out.map((e) => e[4]?.form ?? e[0]), ['translator_youling'], 'only the form fx is handed out');
    assert.ok(Math.abs(late.get(out[0]) - 9) < 1e-9, 'with its lateness (game s)');
    // replayed without a stamp right after a reset (screens/game.js early buffer: stamped 0)
    const r = new SnapshotBuffer();
    r.pushEvents([form(4, 'husk'), ['fx', 'ember', 1, 1, { r: 1 }]], 0);
    assert.deepEqual(r.takeEvents(30, [], 28.5).map(fxFormOf), ['husk']);
    // a hidden-tab flood: the shed keeps it
    const q = new SnapshotBuffer();
    q.pushEvents([form(5, 'reborn')], 0, 0.5);
    for (let i = 0; i < 70; i++) q.pushEvents(Array.from({ length: 100 }, () => ['fx', 'burst', 1, 1, {}]), 0, 1 + i * 0.01);
    assert.ok(q.events.length <= 6000, `bounded (${q.events.length})`);
    assert.equal(q.events.filter((e) => e.ev[4]?.form === 'reborn').length, 1, 'never shed');
  });

  test('sample before any snapshot / with NaN time is empty; update before snapshots is NaN', () => {
    const b = new SnapshotBuffer();
    assert.ok(Number.isNaN(b.update(1)));
    assert.equal(b.sample().size, 0);
    b.push(snap(2, [U(1, 1, 1)]), 1);
    assert.equal(b.sample(NaN).size, 0);
    assert.equal(b.sample(0).get(1).x, 1, 'time before the oldest clamps to the oldest');
  });

  test('no NaN anywhere through a noisy stream', () => {
    const b = new SnapshotBuffer();
    let now = 0, t = 0;
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const out = new Map();
    for (let i = 0; i < 500; i++) {
      now += 0.03 + rnd() * 0.05;
      if (rnd() < 0.8) { t += 0.1; b.push(snap(t, [U(1, rnd() * 20, rnd() * 18, rnd() * 100), U(2 + (i % 5), 3, 3)]), now); }
      b.update(now);
      b.sample(undefined, out);
      for (const s of out.values()) for (const k of ['x', 'y', 'hp', 'sp', 'vx', 'vy']) assert.ok(Number.isFinite(s[k]), k);
    }
  });

  test('adaptive delay: a constant 1.9× stream with no jitter keeps the floor delay and never climbs', () => {
    // the arrival cadence is 5% faster than the nominal 2× (one snapshot every 0.1 game s arrives every 52.6 ms):
    // the old lateness baseline treated that constant error as jitter and pinned the delay to maxDelay
    const b = new SnapshotBuffer({ delay: 0.1, rate: 2, adaptive: true });
    let now = 0, t = 0, peak = 0;
    for (let i = 0; i < 600; i++) {
      now += 0.1 / 1.9;
      t += 0.1;
      b.push(snap(t, [U(1, 0, 0)]), now);
      peak = Math.max(peak, b.delay);
    }
    assert.ok(near(b.rate, 1.9, 0.01), `rate estimate ${b.rate}`);
    assert.ok(b.delay >= 0.1 && b.delay <= 0.15, `delay ${b.delay}`);
    assert.ok(peak <= 0.15, `never rose past the floor (${peak})`);
  });

  test('adaptive delay: real jitter (a periodic 120 ms spike) raises it, and it eases back once the jitter stops', () => {
    const b = new SnapshotBuffer({ delay: 0.1, rate: 2, adaptive: true, minDelay: 0.1, maxDelay: 0.6, jitterWindow: 4 });
    let now = 0, t = 0;
    for (let i = 0; i < 300; i++) { // one arrival in five is 120 ms late
      now += i % 5 === 4 ? 0.17 : 0.05;
      t += 0.1;
      b.push(snap(t, [U(1, 0, 0)]), now);
    }
    const raised = b.delay;
    assert.ok(raised > 0.15, `raised by the jitter (${raised})`);
    for (let i = 0; i < 300; i++) { // 15 s of a steady stream again
      now += 0.05;
      t += 0.1;
      b.push(snap(t, [U(1, 0, 0)]), now);
    }
    assert.ok(b.delay < raised - 0.05, `eased back from ${raised} to ${b.delay}`);
    assert.ok(b.delay <= 0.15, `back at the floor (${b.delay})`);
  });

  test('percentile95 is not the maximum at n = 6, and a six-sample window raises the delay by one step at most', () => {
    // nearest rank (ceil(n × 0.95) − 1) still lands on the maximum for every n ≤ 19 — the case a single spike makes
    assert.equal(percentile95([0, 0, 0, 0, 0, 0.5]), 0.375);
    assert.ok(percentile95([...Array(19).fill(0), 0.5]) < 0.5);
    const b = new SnapshotBuffer({ delay: 0.1, rate: 2, adaptive: true, minDelay: 0.1, maxDelay: 0.6, jitterMargin: 0 });
    let now = 0, t = 0;
    for (let i = 0; i < 6; i++) { // one 0.5 s spike in a six-sample window
      now += i === 5 ? 0.55 : 0.05;
      t += 0.1;
      b.push(snap(t, [U(1, 0, 0)]), now);
    }
    assert.ok(b.delay <= 0.2 + 1e-9, `raised by at most one DELAY_RAISE (${b.delay})`);
    assert.ok(b.delay < 0.6, 'not lifted to maxDelay');
  });

  test('draining ends when the feed moves past the drained snapshot or a new nominal rate arrives, never on update()', () => {
    const b = new SnapshotBuffer({ delay: 0.4, rate: 2 });
    let now = 0, t = 0;
    for (let i = 0; i < 10; i++) { now += 0.05; t += 0.1; b.push(snap(t, [U(1, 0, 0)]), now); }
    b.drain();
    b.update(now + 0.2);
    assert.equal(b.draining, true, 'update() alone does not end the drain');
    const drained = b.drainEndT;
    now += 0.05; t += 0.1; b.push(snap(t, [U(1, 0, 0)]), now);
    assert.equal(b.draining, true, 'one interval past the drained snapshot is still draining');
    while (!(t > drained + 2 * b.interval + 1e-9)) { now += 0.05; t += 0.1; b.push(snap(t, [U(1, 0, 0)]), now); }
    assert.equal(b.draining, false, 'two intervals past it: the stream is live again');
    b.drain();
    b.setNominalRate(b.rate); // a repeat is still a new feed
    assert.equal(b.draining, false);
    b.drain();
    b.setNominalRate(4);
    assert.equal(b.draining, false);
  });
});
