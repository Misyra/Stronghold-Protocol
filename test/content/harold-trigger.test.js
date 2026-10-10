// Harold's DEFAULT cast must accompany a heal of element damage even when every ally has full HP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec, checkInvariants } from '../helpers/battleHarness.js';
import { AUTO_OP_COOLDOWN } from '../../server/sim/constants.js';

const allyId = 'chess_char_1_02_a';
const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);
const done = (h) => { checkInvariants(h.b); assert.deepEqual(h.b.errors, []); };

function harold({ id = 'chess_char_2_05_a', ready = true, col = 5, ...opts } = {}) {
  const order = [];
  const h = makeBattle({
    seed: 7, autoFinish: false, captureNoisy: true,
    units: [{ chessId: id, row: 10, col: 4, carryState: ready ? { sp: 999 } : undefined },
      { chessId: allyId, row: 10, col }],
    setup(b) {
      b.on('skillStart', (c) => order.push(['skillStart', c.unit.id]));
      b.on('attack', (c) => order.push(['attack', c.attacker.id]));
    },
    ...opts,
  });
  h.step();
  return { h, u: h.unit(id), ally: h.unit(allyId), order };
}

test('Harold S2: full-HP element damage casts DEFAULT before the first heal, normal and elite', () => {
  for (const id of ['chess_char_2_05_a', 'chess_char_2_05_b']) {
    for (const element of ['neural', 'burn', 'necrosis', 'apoptosis', 'erosion']) {
      const { h, u, ally, order } = harold({ id });
      assert.equal(u.skill.id, 'skchr_harold_2');
      assert.equal(u.skill.rule, 'DEFAULT');
      assert.ok(u.skill.ready && !u.skill.opCooling);
      assert.ok(h.allies().every((a) => a.hp === a.s.maxHp));
      assert.equal(u.skill.activations, 0);
      ally.elem[element] = 900;
      h.step();
      assert.equal(u.skill.activations, 1, `${id} ${element}: skill casts for element healing alone`);
      assert.ok(u.skill.active);
      assert.deepEqual(order.filter(([, who]) => who === u.id).map(([name]) => name), ['skillStart', 'attack']);
      assert.equal(h.hooksOf('skillStart').find((c) => c.unit === u).reason, 'DEFAULT');
      assert.equal(h.hooksOf('attack').find((c) => c.attacker === u).targets[0].id, ally.id);
      approx(ally.elem[element], 900 - u.s.atk * u.profile.heal.elementHealRatio * u.skill.bb.trait_scale);
      assert.ok(h.allies().every((a) => a.hp === a.s.maxHp));
      done(h);
    }
  }
});

test('Harold S2: without full SP, ordinary element healing still works on a full-HP ally', () => {
  const { h, u, ally } = harold({ ready: false });
  assert.ok(!u.skill.ready);
  ally.elem.neural = 900;
  h.step();
  assert.equal(u.skill.activations, 0);
  assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u).length, 1);
  approx(ally.elem.neural, 900 - u.s.atk * u.profile.heal.elementHealRatio);
  assert.equal(ally.hp, ally.s.maxHp);
  done(h);
});

test('Harold S2: no healing need keeps a ready skill idle; HP damage still triggers it', () => {
  const { h, u, ally } = harold();
  h.run(0.2);
  assert.equal(u.skill.activations, 0);
  assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u).length, 0);
  assert.ok(u.skill.ready);
  ally.hp = ally.s.maxHp * 0.3;
  h.step();
  assert.equal(u.skill.activations, 1);
  assert.ok(ally.hp > ally.s.maxHp * 0.3);
  done(h);
});

test('Harold S2: an element-damaged ally outside the range or under noHeal does not trigger', () => {
  for (const outside of [false, true]) {
    const { h, u, ally } = harold({ col: outside ? 10 : 5 });
    ally.elem.neural = 900;
    if (!outside) h.b.addBuff(ally, { key: 'test:noHeal', flags: { noHeal: true } });
    h.run(0.2);
    assert.equal(u.skill.activations, 0);
    assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u).length, 0);
    approx(ally.elem.neural, 900);
    done(h);
  }
});

test('Harold S2: element healing respects the initial MANUAL operation cooldown', () => {
  const { h, u, ally } = harold({ flags: { startOpCooldown: AUTO_OP_COOLDOWN } });
  assert.ok(u.skill.opCooling);
  ally.elem.neural = 900;
  h.step();
  assert.equal(u.skill.activations, 0);
  approx(ally.elem.neural, 900 - u.s.atk * u.profile.heal.elementHealRatio);
  assert.ok(h.runUntil(() => u.skill.activations > 0, 6));
  const start = h.hooksOf('skillStart').find((c) => c.unit === u);
  assert.ok(start.t >= AUTO_OP_COOLDOWN);
  assert.equal(start.reason, 'DEFAULT');
  done(h);
});

test('Harold S2: silence holds back the cast while ordinary element healing continues', () => {
  const { h, u, ally } = harold();
  h.b.addBuff(u, { key: 'test:silence', flags: { silence: true } });
  ally.elem.neural = 900;
  h.step();
  assert.equal(u.skill.activations, 0);
  approx(ally.elem.neural, 900 - u.s.atk * u.profile.heal.elementHealRatio);
  h.b.removeBuff(u, 'test:silence');
  assert.ok(h.runUntil(() => u.skill.activations > 0, 4));
  done(h);
});

test('DEFAULT physician still requires HP damage; wandermedic special strategies retain their conditions', () => {
  const cases = [
    ['physician', 'DEFAULT', false], ['wandermedic', 'NEVER', false], ['wandermedic', 'TAKE_DAMAGE', false],
    ['wandermedic', 'SKILL_RANGE', false], ['wandermedic', 'SP_FULL', true],
  ];
  for (const [subProfessionId, rule, cast] of cases) {
    const healer = chessRec({ id: 't_healer', profession: 'MEDIC', subProfessionId,
      attackKind: 'heal', dmgType: 'heal', rangeGrid: [[0, 0], [0, 1]],
      skill: { skillType: 'MANUAL', spCost: 10, initSp: 10, duration: 5 } });
    const h = makeBattle({
      seed: 7, captureNoisy: true,
      defs: { chess: { t_healer: healer } },
      units: [{ chessId: 't_healer', row: 10, col: 4 }, { chessId: allyId, row: 10, col: 5 }],
      kits: { t_healer: () => ({ skill: { kind: 'duration', heal: true,
        trigger: { rule, grid: [[0, 0], [0, 1]], allies: rule === 'SKILL_RANGE', hpAtMost: 0.5 } } }) },
    });
    h.step();
    const u = h.unit('t_healer'), ally = h.unit(allyId);
    ally.elem.neural = 900;
    h.step();
    assert.equal(u.skill.activations, cast ? 1 : 0, `${subProfessionId} ${rule}`);
    if (subProfessionId === 'physician') {
      approx(ally.elem.neural, 900);
      assert.equal(h.hooksOf('attack').filter((c) => c.attacker === u).length, 0);
      ally.hp = ally.s.maxHp * 0.3;
      h.step();
      assert.equal(u.skill.activations, 1);
      assert.ok(ally.hp > ally.s.maxHp * 0.3);
    }
    done(h);
  }
});
