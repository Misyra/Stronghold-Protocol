// test/match/frame-economy.test.js — SP_FRAME_ECONOMY(server/match/frameEconomy.js)的三条出向帧经济路径,
// 直接钉在 FieldRunner(server/match/fields.js)上:
//   F3  发射节奏:开启时每 6 tick 一次(2× 速度下 20 Hz → 10 Hz),关闭时每 3 tick(SNAPSHOT_EVERY,现状);
//   F1  同一 emit 只 stringify 一次:b.snap / b.ev 以 encoded 通道扇出给全部 watchers,且字节必须等于
//       encode(msg)(lobby.js matchSend 原样复用);关闭时不携带 encoded(下游逐份 encode,与现状一致);
//   F2  无变化跳帧:直播字段快照内容(除行尾 gt)与上一帧逐字节一致时不再重发;终局帧(字段结束)永远发送。
// FakeBattle 的 snapshot 除 t 外恒定,正好把「无变化」推到极限:60 tick 的对局开启时只应有首帧 + 终局两帧
// b.snap,而内容变化的对照战斗仍是 10 帧(节奏减半、不跳帧)。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FieldRunner } from '../../server/match/fields.js';
import { FakeBattle } from './fakeBattle.js';
import { _setFrameEconomyForTests } from '../../server/match/frameEconomy.js';

const TICKS_2S = 60; // duration 2 游戏秒 = 60 tick

/** 一个最小的 Match 面:watchersOf 给出观众,sendTo 记下 (pid, msg, encoded)。 */
function rig(watchers) {
  const sent = [];
  const errors = [];
  const m = {
    watchersOf: () => watchers,
    sendTo: (pid, msg, encoded) => { sent.push([pid, msg, encoded ?? null]); return true; },
    reportError: (label, e) => errors.push(`${label}: ${e && e.message}`),
    markPublic: () => {},
  };
  return { sent, errors, m };
}

/** 按 script 起一个 FakeBattle 字段并手摇 `ticks` 次 _tick,返回捕获的帧。 */
function runTicks({ watchers, script, ticks, battleClass = FakeBattle }) {
  FakeBattle.reset();
  FakeBattle.script = script;
  const { sent, errors, m } = rig(watchers);
  const battle = new battleClass({ kind: 'normal', fieldId: 'f1', players: [{ playerId: 'p_0' }], timeLimit: 0, spawns: [] });
  const f = { fieldId: 'f1', kind: 'normal', players: ['p_0'], battle, live: true };
  const runner = new FieldRunner(m, [f], { onDone() {} });
  for (let i = 0; i < ticks && !battle.finished; i++) runner._tick();
  FakeBattle.reset();
  return { sent, errors, battle };
}

const of = (sent, t) => sent.filter(([, msg]) => msg.t === t);
const plan = () => ({ duration: 2, leaks: {} });

/** 内容每 emit 都变的对照战斗:dp = tickCount,快照永不与前帧相同。 */
class ChangingBattle extends FakeBattle {
  snapshot() { const s = super.snapshot(); s.dp = this.tickCount; return s; }
}

test('SP_FRAME_ECONOMY 关闭(默认):每 3 tick 一帧 b.snap + b.ev,不携带 encoded(现状逐字节)', () => {
  _setFrameEconomyForTests(false);
  try {
    const { sent, errors } = runTicks({ watchers: ['p_0'], script: plan, ticks: TICKS_2S });
    assert.deepEqual(errors, []);
    const snaps = of(sent, 'b.snap'), evs = of(sent, 'b.ev');
    assert.equal(snaps.length, 20, `60 tick 应有 20 帧 b.snap,实得 ${snaps.length}`);
    assert.equal(evs.length, 20, `60 tick 应有 20 帧 b.ev,实得 ${evs.length}`);
    for (const [, , encoded] of sent) assert.equal(encoded, null, '关闭时不携带 encoded');
    assert.equal(snaps[0][1].gt, 0.1, '首个发射点在第 3 tick(gt 0.1)');
  } finally { _setFrameEconomyForTests(null); }
});

test('SP_FRAME_ECONOMY 开启:节奏 6 tick;无变化快照跳发,只余首帧与终局帧;终局帧永远发送', () => {
  _setFrameEconomyForTests(true);
  try {
    const { sent, errors } = runTicks({ watchers: ['p_0'], script: plan, ticks: TICKS_2S });
    assert.deepEqual(errors, []);
    const snaps = of(sent, 'b.snap'), evs = of(sent, 'b.ev');
    assert.equal(evs.length, 10, `节奏减半:10 帧 b.ev,实得 ${evs.length}`);
    assert.equal(snaps.length, 2, `无变化跳帧:只剩首帧 + 终局帧 2 帧 b.snap,实得 ${snaps.length}`);
    assert.equal(snaps[0][1].gt, 0.2, '首个发射点在第 6 tick(gt 0.2)');
    // 两帧内容(除 gt)逐字节一致 —— 中间被跳过的正是这些帧
    const prefix = (json) => json.slice(0, json.lastIndexOf(',"gt":'));
    const a = JSON.stringify(snaps[0][1]), b = JSON.stringify(snaps[1][1]);
    assert.notEqual(snaps[0][1].gt, snaps[1][1].gt, '两帧 gt 不同(终局帧)');
    assert.equal(prefix(a), prefix(b), '首帧与终局帧内容一致(中间帧全部跳过)');
  } finally { _setFrameEconomyForTests(null); }
});

test('SP_FRAME_ECONOMY 开启:内容变化的字段不跳帧,仍是节奏减半的 10 帧 b.snap', () => {
  _setFrameEconomyForTests(true);
  try {
    const { sent } = runTicks({ watchers: ['p_0'], script: plan, ticks: TICKS_2S, battleClass: ChangingBattle });
    const snaps = of(sent, 'b.snap');
    assert.equal(snaps.length, 10, `节奏 6 tick、内容每帧都变:10 帧 b.snap,实得 ${snaps.length}`);
    assert.ok(snaps.every(([, msg]) => Number.isFinite(msg.gt)), '每帧都带 gt');
  } finally { _setFrameEconomyForTests(null); }
});

test('SP_FRAME_ECONOMY 开启:同一 emit 对多个 watcher 只 stringify 一次,encoded 通道扇出同一份字节', () => {
  _setFrameEconomyForTests(true);
  try {
    const { sent } = runTicks({ watchers: ['p_0', 's_0'], script: plan, ticks: 12 });
    const snaps = of(sent, 'b.snap');
    assert.equal(snaps.length, 2, 'p_0 与 s_0 各一帧(12 tick 一个发射点)');
    assert.equal(snaps[0][0], 'p_0');
    assert.equal(snaps[1][0], 's_0');
    assert.ok(snaps[0][2] && snaps[1][2], '开启时 b.snap 携带 encoded');
    assert.equal(snaps[0][2], JSON.stringify(snaps[0][1]), 'encoded === encode(msg)');
    assert.equal(snaps[0][2], snaps[1][2], '两个 watcher 共享同一份字节(stringify 一次)');
    const evs = of(sent, 'b.ev');
    assert.ok(evs.length >= 2 && evs[0][2] === JSON.stringify(evs[0][1]), 'b.ev 同样携带自己的 encoded');
  } finally { _setFrameEconomyForTests(null); }
});

test('SP_FRAME_ECONOMY 开关:_setFrameEconomyForTests(null) 回落 env 值(未设 = 关)', () => {
  _setFrameEconomyForTests('1');
  const { sent } = runTicks({ watchers: ['p_0'], script: plan, ticks: 12 });
  assert.equal(of(sent, 'b.snap').length, 1, '钩子置 1 后走经济路径(12 tick 一个发射点,内容无变化不重发)');
  _setFrameEconomyForTests(null); // 回落 env:本套件进程未设 SP_FRAME_ECONOMY → 关
  const { sent: off } = runTicks({ watchers: ['p_0'], script: plan, ticks: 12 });
  assert.equal(of(off, 'b.snap').length, 4, '回落 env 后回到现状节奏(3 tick,4 帧)');
});
