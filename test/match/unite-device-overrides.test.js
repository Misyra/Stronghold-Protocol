// GitHub #282: the flat escape template erased the helpers' terrain and blocking devices. Keep the round stage;
// escaped_single / _multi supply the 联防 enemy batches and routes (two halves joined at col 10). One helper →
// escaped_single (enemies enter at col 10), two helpers → escaped_multi (enemies enter at col 18 and pass (9,10)); the
// helpers' pieces stand on their prep tiles ("按休整期位置部署在场"), the first of two shifted 8 columns onto the right half
// ("率先迎敌(即位于右侧阵地)"). These additional regressions preserve per-helper device changes and browser parity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { Battle } from '../../server/sim/Battle.js';
import { createBattleFromSpec } from '../../server/sim/spec.js';
import { DataSource } from '../../server/sim/simdata.js';
import { FakeBattle } from './fakeBattle.js';
import { DATA, makeMatch, give, chessOfTier, legalTileFor } from './harness.js';

/** A real battle that only ends by its time limit (the check follows the enemies, whatever the helpers do). */
class NoFinish extends Battle {
  constructor(o) { super({ ...o, autoFinish: false }); }
}

/**
 * Co-op on 战场#01 (its row 9 is fenced off at cols 5–7: "##Err###rrSrr###rrS##"): p_0 leaks 3 enemies, the other
 * players are perfect — 1 helper with 2 humans, 2 helpers with 3. Each helper fields one ranged operator in its corner.
 */
function scenario({ humans, clientCombat, stageId = 'act1autochess_m01', configureHelper = () => {} }) {
  const h = makeMatch({
    mode: 'coop', humans, seed: 4101 + humans, fake: true, clientCombat,
    script: (b) => (b.kind === 'normal' ? { leaks: { p_0: 3 } } : {}),
  }).start();
  const m = h.m;
  h.toPrep(1);
  h.setStage(stageId);
  const ranged = chessOfTier(1, (c) => c.position === 'RANGED').filter((x) => m.pool.has(x));
  const helpers = [];
  for (let i = 1; i < humans; i++) {
    const ps = h.ps(`p_${i}`);
    const id = ranged[i];
    helpers.push({ ps, piece: give(m, ps, id, 'board', legalTileFor(m, ps, id)) });
    configureHelper(ps, i);
  }
  h.drive(() => m.phase === PHASE.UNITE);
  return { h, m, helpers };
}

/** The 联防 field's spec / options as the match built them, and a real battle over them. */
function uniteField(m, clientCombat) {
  if (clientCombat) {
    const f = m.fields[0];
    return { opts: f.spec, battle: createBattleFromSpec(f.spec, new DataSource(DATA, null), { BattleClass: NoFinish, recordEvents: false }) };
  }
  const u = FakeBattle.instances.find((b) => b.kind === 'unite');
  return { opts: u.opts, battle: new NoFinish({ ...u.opts, data: m.ds, logger: { warn() {}, error() {}, info() {}, debug() {} } }) };
}

for (const clientCombat of [true, false]) {
  for (const stageId of ['act1autochess_m01', 'act2autochess_m02']) {
    test(`#282: 联防 keeps ${stageId}'s terrain and blocking devices (${clientCombat ? 'client' : 'server'})`, () => {
      const { m } = scenario({ humans: 2, clientCombat, stageId });
      try {
        const { opts, battle: b } = uniteField(m, clientCombat);
        assert.equal(opts.stageId, stageId, 'the escape wave must not replace the helper battlefield');
        assert.deepEqual(b.stage.rows, m.stage.rows);
        b.step();
        const blocking = DATA.stages[stageId].devices.filter((d) => d.active && ['crate', 'platform'].includes(d.role)
          && d.pos[0] >= 9 && d.pos[0] <= 12 && d.pos[1] <= 10);
        assert.ok(blocking.length, 'the reported map has blocking devices');
        for (const d of blocking) {
          assert.equal(b.grid.groundPassable(...d.pos), false, `${d.alias}: still blocks the battlefield`);
        }
      } finally {
        m.dispose();
      }
    });
  }
}

for (const clientCombat of [true, false]) {
  test(`#282: helpers retain their own crate-removal effects (${clientCombat ? 'client' : 'server'})`, () => {
    const { m } = scenario({ humans: 3, clientCombat, configureHelper(ps, i) {
      if (i !== 1) return;
      for (const d of DATA.stages.act1autochess_m01.devices) if (d.role === 'crate') ps.deviceOverrides[d.alias] = false;
    } });
    try {
      const { opts, battle: b } = uniteField(m, clientCombat);
      assert.deepEqual(opts.players.map((p) => [p.playerId, p.colOffset]), [['p_1', 8], ['p_2', 0]]);
      b.step();
      const crates = b.allyUnits.filter((u) => u.kind === 'device' && u.defId === 'trap_1105_accrate' && u.alive);
      assert.ok(crates.some((u) => u.x < 10), 'the left helper keeps its crates');
      assert.equal(crates.some((u) => u.x > 10), false, 'only the right helper removed its crates');
      assert.equal(b.grid.obstacle[10 * 21 + 13], 0, 'removed right-hand crate leaves no device obstacle');
      assert.notEqual(b.grid.obstacle[10 * 21 + 5], 0, 'left-hand crate is still blocking');
    } finally {
      m.dispose();
    }
  });
}

test('#282: browser and server simulate the same obstacle-preserving two-helper field', () => {
  const { m } = scenario({ humans: 3, clientCombat: true, stageId: 'act2autochess_m02' });
  try {
    const spec = m.fields[0].spec;
    const local = createBattleFromSpec(JSON.parse(JSON.stringify(spec)), new DataSource(DATA, null), { quiet: true });
    const server = createBattleFromSpec(spec, m.ds, { quiet: true });
    const localResult = local.runToEnd(1000);
    const serverResult = server.runToEnd(1000);
    assert.deepEqual(localResult, serverResult);
    assert.equal(local.errorCount, 0);
    assert.equal(server.errorCount, 0);
  } finally {
    m.dispose();
  }
});
