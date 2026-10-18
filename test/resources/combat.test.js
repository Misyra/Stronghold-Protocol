import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { bindResourceCombat, resourceCombatActive } from '../../public/js/resources/combat.js';
import { createStore } from '../../public/js/store.js';

const state = (phase, battle = null, entered = true) => ({ session: { entered }, match: { public: phase ? { phase } : null, battle } });

test('combat resource gate covers fighting phases, spectators, paused fights and pending b.start, not prep/result', () => {
  for (const phase of [PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]) {
    assert.equal(resourceCombatActive(state(phase)), true, phase);
    assert.equal(resourceCombatActive(state(phase, { battleId: 'b', done: true })), true, 'own field done: teammates still fighting');
    assert.equal(resourceCombatActive({ ...state(phase), room: { spectator: true } }), true);
    assert.equal(resourceCombatActive({ ...state(phase), match: { public: { phase, paused: true }, battle: null } }), true);
  }
  for (const phase of [PHASE.LOBBY, PHASE.INFO_CHECK, PHASE.BAND_DRAFT, PHASE.BATTLE_CHECK, PHASE.ROUND_START,
    PHASE.SP_DRAFT, PHASE.PREP, PHASE.SETTLE, PHASE.RESULT]) {
    assert.equal(resourceCombatActive(state(phase)), false, phase);
    assert.equal(resourceCombatActive(state(phase, { battleId: 'stale', done: false })), false, 'stale view after phase boundary');
  }
  assert.equal(resourceCombatActive(state(PHASE.PREP, { battleId: 'b', loading: true })), true);
  assert.equal(resourceCombatActive(state(null, { battleId: 'b', loading: true })), true);
  assert.equal(resourceCombatActive(state(null, { battleId: 'b', done: false })), true);
  assert.equal(resourceCombatActive(state(PHASE.PREP, { battleId: 'b', done: true })), false);
  assert.equal(resourceCombatActive(state(PHASE.COMBAT, null, false)), false);
  assert.equal(resourceCombatActive(null), false);
});

test('binding applies initial restored combat before enabled sync, deduplicates updates, and unsubscribes', async () => {
  const store = createStore(state(PHASE.COMBAT));
  const calls = [];
  const resources = { async syncResourceCombat(active) { calls.push(active); } };
  const off = bindResourceCombat(store, resources);
  assert.deepEqual(calls, [true]);
  store.set(state(PHASE.COMBAT));
  store.set(state(PHASE.UNITE));
  store.set(state(PHASE.PREP));
  store.set(state(PHASE.FINAL_ASSAULT));
  store.set(state(PHASE.RESULT));
  assert.deepEqual(calls, [true, false, true, false]);
  off();
  store.set(state(PHASE.COMBAT));
  assert.deepEqual(calls, [true, false, true, false]);
  const errors = [];
  bindResourceCombat(store, { syncResourceCombat: () => Promise.reject(new Error('fixture')) }, err => errors.push(err.message));
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(errors, ['fixture']);
});
