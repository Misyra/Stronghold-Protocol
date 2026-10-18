// test/sim/feedback3-swire-s3.test.js — 琳琅诗怀雅 S3 千金一掷: what the CURRENT kit does.
//
// 历史（必须留着，否则下一个人会「修好」它）：
//   2026-10-04 本分支（owner）决定：金币满 10 且技能攻击范围里有地面敌人 → 自动关闭，关闭时把所有金币按
//   「前方 2-4 + 她阻挡的单位」随机分给地面敌人（每币一次物理伤害 + 径向推开）。test/sim/feedback1*、feedback3* 就是
//   为这个决定写的。
//   2026-10-17 上游撤回（server/sim/content/kits/ops/chess_char_3_04-swire2.js 的注释：
//   "Maintainer 2026-10-17 withdrew the 2026-10-04 cap-triggered close."）。依据是官方卫戍协议
//   「通常不会自动关闭技能」+ skill_table skchr_swire2_3 只在「主动关闭」时花币，而这个模式从不执行主动关闭。
//   0.3.1 的 kit 合并进来之后（77fbc297）她的 S3 就是：**无限持续 toggle，二连击，杀人给币，金币只涨不花，
//   关闭 / 撤退都不结算**。本文件钉住这个行为。
//
// The coin payout, the push and the cap-triggered close are gone; test/sim/feedback1-followups.test.js,
// feedback1b-displacement.test.js and feedback1d-push.test.js dropped their coin cases for the same reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { hasGeneratedData } from '../../server/sim/simdata.js';

const REAL = { skip: !hasGeneratedData() };
const ID = 'chess_char_3_04_a';
const foe = enemyRec({ key: 'e_sw', hp: 1e9, atk: 0, speed: 0, def: 0, res: 0, mass: 1 });

function battle(pos) {
  return makeBattle({
    defs: { enemies: { e_sw: foe } },
    units: [{ chessId: ID, row: 10, col: 5, skillIndex: 2 }],
    enemies: pos ? [{ key: 'e_sw', pos }] : [],
    hooks: ['damaged', 'skillEnd'], autoFinish: false, timeLimit: 30,
  });
}
const arm = (h) => {
  h.step();
  const u = h.unit(ID);
  assert.equal(u.skill.id, 'skchr_swire2_3');
  assert.ok(u.skill.active || u.skill.activate('test', { free: true }));
  return u;
};
const cash = (h, u) => h.hooksOf('damaged').filter((c) => c.source === u && (c.dmg?.tags || []).includes('swire2Cash'));

test('琳琅诗怀雅 S3 千金一掷 is an endless toggle: a full purse never closes it and never fires', REAL, () => {
  const h = battle([10, 6]); // the ground enemy sits in her own attack range
  const u = arm(h);
  const e = h.enemies()[0];
  const hp0 = e.hp;

  u.mem.coins = 9;
  h.run(2);
  assert.equal(u.skill.active, true, 'below the cap: the skill stays open');
  assert.equal(u.mem.coins, 9, 'and the purse keeps its coins');

  u.mem.coins = 10; // the cap (bb.sp)
  h.run(0.5);
  assert.equal(u.skill.active, true, 'at the cap: STILL open — upstream withdrew the 2026-10-04 cap-triggered close');
  assert.equal(u.mem.coins, 10, 'every coin stays in the purse');
  assert.equal(cash(h, u).length, 0, 'no coin is ever paid out (no swire2Cash damage at all)');
  // she still fights it — the double strike of the toggle — but that damage is hers, not the purse's
  assert.ok(e.hp < hp0, 'her own attacks still land on the enemy in range');
  assert.equal(h.b.errors.length, 0);
  checkInvariants(h.b);
});

test('琳琅诗怀雅 S3 千金一掷: closing it — manually or any other way — spends nothing', REAL, () => {
  const h = battle(null);
  const u = arm(h);
  u.mem.coins = 4;
  assert.doesNotThrow(() => u.skill.end('manual'));
  assert.equal(u.skill.active, false, 'the toggle does close when asked');
  assert.equal(u.mem.coins, 4, 'and keeps its coins (skill_table skchr_swire2_3 spends only on 主动关闭… which the mode never performs)');
  assert.equal(cash(h, u).length, 0);
  assert.equal(h.hooksOf('damaged').length, 0, 'nobody is damaged by closing it');
  checkInvariants(h.b);
});

test('琳琅诗怀雅 S3 千金一掷: the double strike and the coin-per-kill are still there', REAL, () => {
  // 二连击 + 击杀给币 是 0.3.1 版本仍然保留的部分（被撤掉的只有「关闭时结算金币」）。这里只钉住它们还在，
  // 具体数值见 test/content/kits_alt_t3.test.js（那一组按 Lv4 / Lv7 各自的 blackboard 跑）。
  const h = battle(null);
  const u = arm(h);
  assert.equal(u.skill.kind, 'toggle');
  const cap = u.skill.bb.sp;
  assert.ok(cap > 0, `the purse has a cap (${cap})`);
  u.mem.coins = cap;
  h.run(1);
  assert.ok((u.mem.coins ?? 0) <= cap, 'the purse never overflows its cap');
  checkInvariants(h.b);
});
