// 房间分享的本机状态（docs/design/portal-agent-wss.md §45.1、§45.5）。
//
// 这里只有**纯数据与纯函数**：房间页把那六个反馈（隐藏 / 暂不可用 / 提交中 / 待确认 / 已登记 / 冷却）
// 渲染出来，而「什么时候该显示哪一个」全部在这里判定，于是它可以被单独断言，不用去跑一个浏览器。
//
// 两件最容易混起来的事被刻意分开：
//   冷却（60 秒）—— 同一个房间的**点按频率**，是本地防重发的限制；
//   有效期（10 分钟）—— 中央那条登记的**生存时间**，只有中央说了算（expiresAt）。
// 一个布尔计时器同时表示这两件事，就会出现「刷新页面后还剩几秒」和「登记还能活多久」互相覆盖的旧毛病。

/** 同一房间两次提交之间的最短间隔。 */
export const SHARE_COOLDOWN_MS = 60_000;
/** 中央登记的默认长度（§45.2 第 4 步）。legacy 路径拿不到 expiresAt 时用它显示剩余时间。 */
export const SHARE_TTL_MS = 600_000;
/** 结果待确认时的查询节奏与次数上限（约 48 秒）。之后交给房主手动查询。 */
export const SHARE_POLL_MS = 6_000;
export const SHARE_POLL_TRIES = 8;

/**
 * 初始状态。`enabled`/`available` 来自公开探测 `GET /api/portal-room`。
 * @param {{ enabled?: boolean, mode?: string, available?: boolean }} capability
 */
export function initialShare({ enabled = false, mode = 'off', available = false } = {}) {
  return { enabled, mode, available, state: 'idle', opId: null, expiresAt: null, error: null, cooldownUntil: 0 };
}

/** 回执里的有效期 → 本机时刻。用 remainingMs（服务端算的）而不是 expiresAt，免得玩家机器的时钟参与计算。 */
function expiryFrom(data, serverNow) {
  const remaining = Number.isFinite(data?.remainingMs) && data.remainingMs >= 0 ? data.remainingMs : SHARE_TTL_MS;
  return serverNow + remaining;
}

/** 提交后的状态迁移。**只有 registered:true 才算收录**（§45.1）；202/待确认保留 opId 去查询。 */
export function shareAfterSubmit({ data, previous, serverNow }) {
  // 成功、被拒、未知都消耗冷却：冷却约束的是「点按」，不是「结果」。
  const cooldownUntil = serverNow + SHARE_COOLDOWN_MS;
  if (data?.status === 'pending') return { ...previous, state: 'pending', opId: data.opId ?? previous.opId ?? null, expiresAt: null, error: null, cooldownUntil, gone: null };
  if (data?.registered === true) return { ...previous, state: 'registered', opId: data.opId ?? null, expiresAt: expiryFrom(data, serverNow), error: null, cooldownUntil, gone: null };
  return { ...previous, state: 'idle', expiresAt: null, error: data?.error ?? null, cooldownUntil, gone: null };
}

/**
 * 登记结果查询（`GET /api/portal-room/status`）后的状态迁移。
 * `ended`/`absent` 都是「确定没有这条登记」：前者曾登记但现在没了，后者从来没查到 —— 两个都回到可提交，
 * 由界面文案区分。`unknown` 什么都不改：查询失败不能当成「没登记」。
 */
export function shareAfterStatus(data, { previous, serverNow }) {
  if (data?.state === 'registered') return { ...previous, state: 'registered', expiresAt: expiryFrom(data, serverNow), error: null, gone: null };
  if (data?.state === 'ended' || data?.state === 'absent') return { ...previous, state: 'idle', opId: null, expiresAt: null, error: null, gone: data.state };
  return { ...previous, error: null };
}

/** 两个独立的计时：登记的剩余时间与冷却的剩余时间。 */
export function shareTiming(state, serverNow) {
  const remainingMs = state.state === 'registered' && Number.isFinite(state.expiresAt)
    ? Math.max(0, state.expiresAt - serverNow) : null;
  const cooldownMs = Math.max(0, (state.cooldownUntil ?? 0) - serverNow);
  return { remainingMs, remainingMin: remainingMs === null ? null : Math.ceil(remainingMs / 60_000),
    expired: remainingMs === 0, cooldownMs, cooldownSec: Math.ceil(cooldownMs / 1000) };
}

/** Local UI affordance only; authorization and relay configuration still belong to the server. */
export function isLocalShareHost(hostname = '') {
  const host = String(hostname).toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '[::1]') return true;
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * 界面要显示的那一个分支。
 * @param {object} state initialShare() 的形状（state.state 为 'submitting' 时是提交中）
 * @param {{ serverNow: number, online?: boolean, canSubmit?: boolean, hostname?: string }} context
 * @returns {{ visible: boolean, kind: string, disabled?: boolean, action?: 'retry'|'query' } & ReturnType<typeof shareTiming>}
 */
export function shareView(state, { serverNow, online = true, canSubmit = true, hostname = '' }) {
  const timing = shareTiming(state, serverNow);
  if (!state.enabled) return isLocalShareHost(hostname)
    ? { visible: true, kind: 'unconfigured', disabled: true, action: 'retry', ...timing }
    : { visible: false, kind: 'hidden', ...timing };
  // 配置了但链路不可用：按钮还在，但按不动，并提供「重试」重新探测（不是隐藏 —— 隐藏会让房主以为
  // 本站根本没有分享功能）。
  if (!state.available) return { visible: true, kind: 'unavailable', disabled: true, action: 'retry', ...timing };
  if (state.state === 'submitting') return { visible: true, kind: 'submitting', disabled: true, ...timing };
  if (state.state === 'pending') return { visible: true, kind: 'pending', disabled: true, action: 'query', ...timing };
  if (timing.remainingMs > 0) return { visible: true, kind: 'registered', disabled: true, ...timing };
  if (timing.expired) return { visible: true, kind: 'expired', disabled: !online || !canSubmit || timing.cooldownMs > 0, ...timing };
  if (timing.cooldownMs > 0) return { visible: true, kind: 'cooldown', disabled: true, ...timing };
  return { visible: true, kind: 'idle', disabled: !online || !canSubmit, ...timing };
}
