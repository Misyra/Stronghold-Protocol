// 分享界面的状态机（docs/design/portal-agent-wss.md §12.5）。
//
// 这组测试盯的是「两个计时器不许混成一个」与「只有 registered:true 才算收录」：
//   冷却 60 秒约束的是**点按**，登记有效期 10 分钟说的是**中央那条登记能活多久**。刷新页面、重新进房间、
//   或者看到一次失败，都不该改变登记的剩余时间；反过来，登记到期也不该让按钮在冷却里多锁一会儿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialShare, shareAfterStatus, shareAfterSubmit, shareTiming, shareView,
  SHARE_COOLDOWN_MS, SHARE_POLL_TRIES, SHARE_TTL_MS } from '../../public/js/ui/roomShare.js';

const NOW = 1_800_000_000_000;
const enabled = () => ({ ...initialShare({ enabled: true, mode: 'agent', available: true }) });

test('未配置就隐藏；配置了但链路不可用是「暂不可用 + 重试」，不是隐藏', () => {
  assert.equal(shareView(initialShare(), { serverNow: NOW }).visible, false);
  const off = shareView({ ...initialShare(), enabled: true, available: false }, { serverNow: NOW });
  assert.equal(off.visible, true);
  assert.equal(off.kind, 'unavailable');
  assert.equal(off.disabled, true);
  assert.equal(off.action, 'retry');
});

test('提交：只有 registered 才算收录，202 进待确认并保留 opId', () => {
  const registered = shareAfterSubmit({ data: { registered: true, opId: 'op-1', remainingMs: 600_000 }, previous: enabled(), serverNow: NOW });
  assert.equal(registered.state, 'registered');
  assert.equal(registered.expiresAt, NOW + 600_000);
  assert.equal(registered.cooldownUntil, NOW + SHARE_COOLDOWN_MS);

  const pending = shareAfterSubmit({ data: { status: 'pending', opId: 'op-2' }, previous: enabled(), serverNow: NOW });
  assert.equal(pending.state, 'pending');
  assert.equal(pending.opId, 'op-2');
  assert.equal(shareView(pending, { serverNow: NOW }).action, 'query');

  // 被拒：回到可提交，但冷却照旧消耗（冷却约束点按，与结果无关）。
  const rejected = shareAfterSubmit({ data: { status: 'rejected', error: '联机站暂不可用，请稍后重试' }, previous: enabled(), serverNow: NOW });
  assert.equal(rejected.state, 'idle');
  assert.equal(rejected.error, '联机站暂不可用，请稍后重试');
  assert.equal(shareView(rejected, { serverNow: NOW }).kind, 'cooldown');
  // 一个没有业务状态的回执（比如反过来是 HTML）不能被当成成功。
  const broken = shareAfterSubmit({ data: null, previous: enabled(), serverNow: NOW });
  assert.equal(broken.state, 'idle');
});

test('冷却与有效期分开走：冷却结束不改变登记，登记到期也不延长冷却', () => {
  const state = shareAfterSubmit({ data: { registered: true, remainingMs: 600_000 }, previous: enabled(), serverNow: NOW });
  // 冷却刚过（61 秒）：仍然是已登记，剩余 9 分钟 —— 点按的间隔跟登记的寿命无关。
  const afterCooldown = shareTiming(state, NOW + 61_000);
  assert.equal(afterCooldown.cooldownMs, 0);
  assert.equal(afterCooldown.expired, false);
  assert.equal(afterCooldown.remainingMin, 9);
  assert.equal(shareView(state, { serverNow: NOW + 61_000 }).kind, 'registered');
  // 十分钟到期：界面变成「已过期，可重新提交」，而且此时冷却早就没了。
  assert.equal(shareView(state, { serverNow: NOW + SHARE_TTL_MS }).kind, 'expired');
  assert.equal(shareView(state, { serverNow: NOW + SHARE_TTL_MS }).disabled, false);
  // 离线或房间满员时不许再按。
  assert.equal(shareView(state, { serverNow: NOW + SHARE_TTL_MS, online: false }).disabled, true);
  assert.equal(shareView(state, { serverNow: NOW + SHARE_TTL_MS, canSubmit: false }).disabled, true);
});

test('回执里没有 remainingMs 时按中央的十分钟显示（legacy 路径拿不到 expiresAt）', () => {
  const legacy = shareAfterSubmit({ data: { registered: true }, previous: enabled(), serverNow: NOW });
  assert.equal(legacy.expiresAt, NOW + SHARE_TTL_MS);
  assert.equal(shareTiming(legacy, NOW).remainingMin, 10);
});

test('查询：registered 刷新剩余时间，ended/absent 回到可提交，unknown 什么都不改', () => {
  const pending = shareAfterSubmit({ data: { status: 'pending', opId: 'op-2' }, previous: enabled(), serverNow: NOW });
  const found = shareAfterStatus({ state: 'registered', remainingMs: 300_000 }, { previous: pending, serverNow: NOW });
  assert.equal(found.state, 'registered');
  assert.equal(found.expiresAt, NOW + 300_000);
  assert.equal(shareTiming(found, NOW).remainingMin, 5);

  for (const [state, gone] of [['ended', 'ended'], ['absent', 'absent']]) {
    const gone1 = shareAfterStatus({ state }, { previous: pending, serverNow: NOW });
    assert.equal(gone1.state, 'idle');
    assert.equal(gone1.gone, gone);
    assert.equal(gone1.opId, null);
    assert.equal(shareView(gone1, { serverNow: NOW }).kind, 'cooldown', '上次点按的冷却还在');
  }
  // unknown（查询失败）不能被当成「没登记」：那会让房主以为要重新提交。
  const unknown = shareAfterStatus({ state: 'unknown' }, { previous: pending, serverNow: NOW });
  assert.equal(unknown.state, 'pending');
  assert.equal(shareView(unknown, { serverNow: NOW }).action, 'query');
});

test('提交中不许重复点，待确认给查询', () => {
  const submitting = shareView({ ...enabled(), state: 'submitting' }, { serverNow: NOW });
  assert.equal(submitting.kind, 'submitting');
  assert.equal(submitting.disabled, true);
  assert.equal(shareView({ ...enabled(), state: 'pending' }, { serverNow: NOW }).disabled, true);
  // 自动查询的次数上限是个有界的数（约 48 秒），不会无限轮询。
  assert.ok(SHARE_POLL_TRIES >= 4 && SHARE_POLL_TRIES <= 16);
});
