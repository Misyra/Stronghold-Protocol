// Regression: 浊心斯卡蒂 S1 (damage transfer to her) + 坚守 tier 2 (damage cut and shared to the 坚守 members) used to
// bounce redirected damage between Skadi and the members — every cycle branching once per member — until the hook
// depth guard: k members ≈ k^16 damage events per hit, which froze a boss field (an automated bot run, seed 2000301
// solo HARD). Redirected damage is now never redirected again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { getDefaultSource } from '../../server/sim/simdata.js';
import { bondBb } from '../../server/sim/content/bonds/addon/battle.js';

const ds = getDefaultSource();
const SID = 'skchr_skadi2_1';
const op = (id, bonds) => chessRec({ id, bonds, profession: 'WARRIOR', skill: null, stats: { def: 0, maxHp: 1e6 } });
const bond = (tier, layers = 0, count = 3) => ({ count, active: tier > 0, tier, layers });

for (const id of ['chess_char_6_04_a', 'chess_char_6_04_b']) {
  test(`${id}: Skadi S1 transfer + 坚守 tier 2 share do not bounce redirected damage`, () => {
    const skillIndex = ds.rawChess(id).skills.find((s) => s.skillId === SID).index;
    const share = ds.rawChess(id).skills.find((s) => s.skillId === SID).bb.damage_resistance;
    const cut = bondBb('steadShip').damage_resistance;
    const h = makeBattle({
      seed: 7, autoFinish: false, timeLimit: 400, captureNoisy: true, hooks: ['damaged'],
      defs: { chess: { d_1: op('d_1', ['steadShip']), d_2: op('d_2', ['steadShip']), d_3: op('d_3', ['steadShip']), d_n: op('d_n', []) },
        enemies: { dummy: enemyRec({ key: 'dummy', hp: 1e7, speed: 0 }) } },
      // Skadi and four allies next to her (in her range), three of them 坚守 members
      units: [{ chessId: id, row: 10, col: 4, skillIndex, carryState: { sp: 999 } },
        { chessId: 'd_1', row: 10, col: 5 }, { chessId: 'd_2', row: 10, col: 3 }, { chessId: 'd_3', row: 11, col: 4 }, { chessId: 'd_n', row: 9, col: 4 }],
      bonds: { steadShip: bond(2, 10) },
      enemies: [{ key: 'dummy', pos: [9, 9] }],
    });
    const u = h.unit(id);
    if (u.skill && !u.skill.active) h.b.startSkill?.(u);
    h.step(2);
    assert.ok(u.skill?.active, 'S1 active');
    const t0 = Date.now();
    const n0 = h.hooksOf('damaged').length;
    h.b.dealDamage(h.enemy('dummy'), h.unit('d_n'), { amount: 1000, type: 'true' });
    const events = h.hooksOf('damaged').length - n0;
    assert.ok(Date.now() - t0 < 500, `one hit resolves at once (${Date.now() - t0} ms)`);
    assert.ok(events <= 8, `a bounded number of damage events (${events})`);
    assert.equal(h.b.errors.filter((e) => /hookDepth/.test(String(e.key ?? e.label ?? JSON.stringify(e)))).length, 0, 'no hook-depth loop');
    // the non-member's hit: Skadi takes her share once; 坚守 shares the cut of the rest once, nothing is redirected twice
    const dn = h.unit('d_n');
    assert.ok(dn.s.maxHp - dn.hp > 0 && dn.s.maxHp - dn.hp < 1000, 'the ally keeps part of the hit');
    assert.ok(share > 0 && cut > 0);
    checkInvariants(h.b);
  });
}
