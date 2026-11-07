// test/scheduler-turn-budget.test.js — RealScheduler 的主线程 turn 预算（SP_TURN_BUDGET_MS，docs/history 0.3.4 §37.132）。
//
// libuv 在一个 timers turn（一次 uv__run_timers）里排空所有到期 ≤ 本迭代缓存时刻的定时器：单片有界
// （botSliceMs / headlessSliceMs / 20 ms 战斗 tick），turn 本身没有界。预算闸门在 RealScheduler._wrap：
// 本轮累计派发 ≥ 预算后，同 turn 后续到期回调 setTimeout(1) 顺延（仍走同一包装）；setImmediate（check
// 阶段，恰在两次 timers 排空之间）清零计数，顺延的工作下一轮拿到新预算。
//
// 预算是模块级的（一个 turn 排空所有调度器的定时器），所以这些用例串行跑、每例先重设预算；预算取 5 ms、
// 忙回调 8/12 ms 自旋，避免真实 50 ms 预算把测试拖慢、放大抖动。构造只用两条确定序（探测 Node 26 实测归纳）：
// 同一 duration 的原生定时器在同一条 timer list 里按插入序排空（FIFO）、回调里排队的 setImmediate 在该迭代
// 的 check 阶段执行；**不**依赖跨 duration 的 list 弹出顺序（缓存时刻的粒度会让 3 ms list 在 2 ms list
// 之前获准）。于是：同 list 的「预算消耗者 + 受害者们」保证同 turn 排空——消耗者自旋后受害者必然顺延；
// 跨 turn 的断言用「check 窗口自旋总量 ≤ 预算 + 单片」这个与顺序无关的不变量。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { RealScheduler, _setTurnBudgetForTests } from '../server/match/scheduler.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 忙自旋 ~ms 毫秒：模拟一个有界但吃满预算的切片（bot 布防 / 战斗 tick 的形态），返回实际自旋时长。 */
const busy = (ms) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { /* 自旋 */ }
  return performance.now() - t0;
};

/**
 * check 窗口审计：每到一个 check 阶段（setImmediate 哨兵链）就结算一次窗口——窗口内累计自旋时长超过
 * 「预算 + 单片 + 容差」即为违例（预算生效时，两个 12 ms 自旋不可能落进同一窗口；关闸时 8 个自旋
 * 96 ms 挤进一个窗口，必然违例）。返回 maxWindowSpin。
 */
const auditWindows = (events, budget, maxSlice, slack = 1.5) => {
  let windowSpin = 0;
  let maxWindowSpin = 0;
  for (const e of events) {
    if (e.kind === 'check') {
      if (windowSpin > maxWindowSpin) maxWindowSpin = windowSpin;
      windowSpin = 0;
    } else {
      windowSpin += e.spin;
    }
  }
  if (windowSpin > maxWindowSpin) maxWindowSpin = windowSpin;
  assert.ok(
    maxWindowSpin <= budget + maxSlice + slack,
    `check 窗口自旋总量 ${maxWindowSpin.toFixed(1)}ms 超过 预算${budget}+单片${maxSlice}+容差——预算失效`,
  );
  return maxWindowSpin;
};

test('turn 预算：预算耗尽后同 turn 到期回调被顺延（窗口自旋总量不超预算）', async () => {
  _setTurnBudgetForTests(5);
  const sched = new RealScheduler();
  const tracking = { on: true };
  const events = [];
  const trackCheck = () => setImmediate(() => {
    if (!tracking.on) return;
    events.push({ kind: 'check' });
    trackCheck();
  });
  try {
    trackCheck();
    // 8 个回调同入 1 ms list：首个迭代整条 list 排空——自旋者吃满预算后，其余 7 个在**同一 turn**
    // 被顺延（若预算失效，它们会背靠背内联执行，一个窗口累计 96 ms）。
    for (let i = 0; i < 8; i++) {
      sched.setTimeout(() => {
        events.push({ kind: 'run', spin: busy(12) });
      }, 0);
    }
    await sleep(300);
    const ran = events.filter((e) => e.kind === 'run');
    assert.equal(ran.length, 8); // setImmediate 每轮清零：顺延的全部排空，不饿死
    auditWindows(events, 5, 12); // 每个窗口至多一个 12 ms 自旋
  } finally {
    tracking.on = false;
    sched.dispose();
    _setTurnBudgetForTests(0);
  }
});

test('turn 预算：setImmediate 重置后新一轮正常跑，饱和流不饿死、同 list 顺序保持', async () => {
  _setTurnBudgetForTests(5);
  const sched = new RealScheduler();
  try {
    const ran = [];
    // 6 个回调同入 1 ms list，每个吃满所在轮的新预算：每轮只放行队首一个、其余顺延；
    // 顺延句柄同属 1 ms list，list 内 FIFO 保证重排顺序与原序一致。
    for (let i = 0; i < 6; i++) {
      sched.setTimeout(() => { ran.push(i); busy(8); }, 0);
    }
    await sleep(250);
    assert.deepEqual(ran, [0, 1, 2, 3, 4, 5]);
  } finally {
    sched.dispose();
    _setTurnBudgetForTests(0);
  }
});

test('turn 预算：clearTimeout 取消顺延中的工作，被顺延的回调不再执行', async () => {
  _setTurnBudgetForTests(5);
  const sched = new RealScheduler();
  try {
    let satRuns = 0;
    // 饱和者与 8 个受害者同入 1 ms list（饱和者的句柄先建，list 内 FIFO 保证它先排空）：
    // 每轮饱和者先跑、12 ms 自旋吃满预算 → 同 turn 的受害者整批顺延，且它们的顺延句柄在
    // list 里总排在下一轮重排的饱和者之后——每轮都被再次顺延，绝不获得新预算。
    // 第三轮取消全部受害者：此刻它们的顺延句柄正挂着，验证 clearTimeout 能追上顺延。
    const victims = [];
    const sat = () => {
      satRuns++;
      busy(12);
      if (satRuns === 3) {
        for (const v of victims) sched.clearTimeout(v.h); // 全部处于顺延中
      } else {
        sched.setTimeout(sat, 0);
      }
    };
    const satRec = { ran: false };
    satRec.h = sched.setTimeout(sat, 0);
    victims.push(satRec); // victims[0] 是饱和者自身（从不 ran）
    for (let i = 1; i < 9; i++) {
      const rec = { ran: false };
      rec.h = sched.setTimeout(() => { rec.ran = true; }, 0);
      victims.push(rec);
    }
    await sleep(200);
    assert.equal(satRuns, 3);
    for (const x of victims) assert.equal(x.ran, false, '被取消的顺延回调执行了');
    assert.equal(sched._deferred?.get(victims[1].h) ?? null, null); // 取消后顺延登记已清
  } finally {
    sched.dispose();
    _setTurnBudgetForTests(0);
  }
});

test('turn 预算：dispose 取消顺延中的工作', async () => {
  _setTurnBudgetForTests(5);
  const sched = new RealScheduler();
  try {
    const ran = [];
    sched.setTimeout(() => { ran.push('sat'); busy(12); sched.dispose(); }, 0);
    sched.setTimeout(() => ran.push('victim'), 0); // 同 list 排在饱和者之后 → 本 turn 被顺延，但 dispose 先到
    await sleep(80);
    assert.deepEqual(ran, ['sat']);
  } finally {
    sched.dispose();
    _setTurnBudgetForTests(0);
  }
});

test('turn 预算：SP_TURN_BUDGET_MS=0 是直通路径——同 turn 到期回调不顺延、不分配顺延登记', async () => {
  _setTurnBudgetForTests(0);
  const sched = new RealScheduler();
  try {
    const order = [];
    const at = {};
    const mark = (k) => { at[k] = performance.now(); order.push(k); };
    // 同 list：a 自旋 12 ms 后 b 在**同一 turn** 背靠背执行（开闸时 b 会被顺延，哨兵隔在中间）
    sched.setTimeout(() => {
      mark('a');
      setImmediate(() => mark('imm'));
      busy(12);
      at.aEnd = performance.now(); // a 回调自身的自旋在 mark('a') 与结束之间，不能算进 b 的执行间隔
    }, 0);
    sched.setTimeout(() => mark('b'), 0);
    await sleep(80);
    assert.deepEqual(order, ['a', 'b', 'imm']);
    assert.ok(at.b - at.aEnd < 5, `b 未被顺延（a 结束后 ${at.b - at.aEnd}ms 内执行）`);
    assert.equal(sched._deferred, null); // 关闸连顺延登记表都不分配（零额外句柄）
  } finally {
    sched.dispose();
    _setTurnBudgetForTests(0);
  }
});

test('turn 预算：顺延回调与直连回调语义一致——无参调用、错误仍走 onError 且只报一次', async () => {
  _setTurnBudgetForTests(5);
  const errors = [];
  const sched = new RealScheduler({ onError: (e) => errors.push(e) });
  try {
    const seen = [];
    // 同 list：victim 排在自旋者之后 → 本 turn 被顺延，下一轮带着新预算执行
    sched.setTimeout(() => { seen.push('sat'); busy(12); }, 0);
    sched.setTimeout(function victim(...args) {
      seen.push(`victim:${args.length}`);
      throw new Error('boom');
    }, 0);
    await sleep(120);
    assert.equal(seen[0], 'sat');
    assert.equal(seen[1], 'victim:0'); // 顺延后仍是无参调用（与直连一致）
    assert.equal(errors.length, 1);    // 顺延不吞错、不重复上报
    assert.equal(errors[0].message, 'boom');
  } finally {
    sched.dispose();
    _setTurnBudgetForTests(0);
  }
});

test('turn 预算：interval 的 tick 不在耗尽的 turn 里内联执行；clearInterval 后顺延中的 tick 不执行', async () => {
  _setTurnBudgetForTests(5);
  const sched = new RealScheduler();
  try {
    let ticks = 0;
    let satRuns = 0;
    let checksSinceSat = 0;
    let inlineViolation = false;
    let clearedAt = -1;
    // 不变量：任何 tick 执行时，自上一个饱和者回调以来必已隔过至少一个 check 阶段——
    // 预算耗尽的 turn 里同轮后到的 tick 只能顺延，绝不内联执行（首个饱和者之前除外）。
    const tick = () => {
      if (satRuns > 0 && checksSinceSat === 0) inlineViolation = true;
      ticks++;
    };
    // 自续饱和链（0 ms 重排）：5 轮 × 12 ms 自旋；第五轮改排一个 0 ms 清除者——
    // 它早于同轮顺延句柄到期，下一轮先执行 clearInterval，其后到期的顺延 tick 命中
    // _intervals 存活复查被跳过。
    const sat = () => {
      satRuns++;
      setImmediate(() => { checksSinceSat++; });
      busy(12);
      if (satRuns === 5) sched.setTimeout(() => { clearedAt = ticks; sched.clearInterval(h); }, 0);
      else sched.setTimeout(sat, 0);
    };
    sched.setTimeout(sat, 0);
    const h = sched.setInterval(tick, 5);
    await sleep(250);
    assert.equal(satRuns, 5);
    assert.equal(inlineViolation, false, 'tick 在预算耗尽的 turn 里被内联执行了');
    assert.ok(clearedAt >= 0);
    const frozen = ticks;
    await sleep(80);
    assert.equal(ticks, frozen); // clearInterval 之后（含顺延中的 tick）计数冻结
  } finally {
    sched.dispose();
    _setTurnBudgetForTests(0);
  }
});
