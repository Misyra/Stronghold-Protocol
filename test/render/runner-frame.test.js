// test/render/runner-frame.test.js — the runner's animation frame keeps going after an entry throws, and dispose()
// stops it for good (public/js/battle/runner.js frame / schedule / dispose).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattleRunner } from '../../public/js/battle/runner.js';
import { createStore, initialState } from '../../public/js/store.js';

const SPEC = { fieldId: 'n:frame', kind: 'normal', players: [{ playerId: 'p_0' }] };

/** A fake in-page host whose battle throws from `tickCount` while `state.boom` is set. */
function rig() {
  let nowMs = 1000;
  const frames = [];
  const state = { boom: false, snaps: 0, steps: 0, added: 0, removed: 0 };
  const battle = {
    time: 0, finished: false, leakedCount: 0, flags: {},
    get tickCount() { if (state.boom) throw new Error('tickCount blew up'); return state.ticks; },
    snapshot() { return { t: 0, units: [] }; },
    drainEvents() { return []; },
    fieldMeta() { return { units: [] }; },
    getPlayer() { return null; },
    forceEnd() { this.finished = true; },
  };
  state.ticks = 0;
  const host = {
    remote: false,
    battle: null,
    meter: {},
    start() { this.battle = battle; },
    step(n) { state.steps++; state.ticks += n; return { ticks: n, slices: [] }; },
    stop() {},
    progress: () => ({ gt: 0, killed: 0, total: 1, done: false, leaks: 0 }),
    compactResult: () => null,
    uniteLeft: () => null,
  };
  const net = {
    sent: [],
    on() { return () => {}; },
    send() { return true; },
    request() { return Promise.resolve({ t: 'ok' }); },
  };
  const doc = { hidden: false, addEventListener() { state.added++; }, removeEventListener() { state.removed++; } };
  const runner = createBattleRunner({
    net, store: createStore(initialState), doc, combatMetrics: false,
    now: () => nowMs,
    raf: (fn) => { frames.push(fn); return frames.length; },
    caf: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    loadSim: async () => ({ cs: null }),
    createHost: () => host,
  });
  runner.on('snap', () => { state.snaps++; });
  return {
    runner, state, host,
    frames,
    set now(ms) { nowMs = ms; },
    get now() { return nowMs; },
    async start() {
      await runner.onStart({
        t: 'b.start', battleId: 'frame-1', fieldId: 'n:frame', kind: 'normal',
        spec: SPEC, speed: 2, authoritative: false,
      });
    },
    /** run every queued animation frame once */
    runFrames() { for (const fn of frames.splice(0)) fn(nowMs); },
  };
}

test('a frame whose advance throws still schedules the next one; dispose() ends the loop', async () => {
  const r = rig();
  await r.start();
  const e = r.runner._entries.get('frame-1');
  assert.ok(e && e.battle, 'the battle was prepared and shown');
  const snapsAfterShow = r.state.snaps;
  assert.ok(snapsAfterShow >= 1, 'the first frame of the field was emitted');
  r.now = 2000; // behind the field clock: the next frame steps and emits
  r.state.boom = true;
  r.runFrames();
  assert.equal(r.state.steps, 0, 'the throwing frame never stepped');
  assert.equal(r.frames.length, 1, 'a throw in advance did not stop the loop: the next frame is queued');
  r.state.boom = false;
  r.runFrames();
  assert.equal(r.state.steps, 1, 'the next frame ran');
  assert.ok(r.state.snaps > snapsAfterShow, 'and rendered its snapshot');
  assert.equal(r.frames.length, 1, 'and queued the one after it');
  assert.equal(r.state.added, 1);
  assert.equal(r.state.removed, 0);
  r.runner.dispose();
  assert.equal(r.state.removed, 1, 'dispose() removes the visibilitychange listener');
  const queued = r.frames.length;
  r.runner._frame();
  assert.equal(r.frames.length, queued, 'dispose() leaves no frame scheduled');
});
