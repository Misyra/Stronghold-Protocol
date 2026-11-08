// server/match/frameEconomy.js — T4 frame economy switch (SP_FRAME_ECONOMY).
//
// 对每 tick 广播帧做合并/裁剪（可搬回清单 T4）:开关打开时,server-run 战斗流的出向帧走三条经济路径
// (server/match/fields.js 的 FieldRunner):
//   F1  同一 emit 的 b.snap / b.ev 只 stringify 一次,字节随 encoded 通道扇出给全部 watchers(此前每个
//       watcher 各 encode 一遍);
//   F2  快照内容与上一帧逐字节一致(除行尾 gt)时跳过该 b.snap —— 客户端已持有这份状态,事件帧照发;
//   F3  快照节奏 3 tick → 6 tick(2× 速度下 20 Hz → 10 Hz):客户端 render/interp.js 的插值缓冲按到达
//       间隔自适应,协议帧形状不变。
// 关闭(默认)时三条路径全部不生效:发射节奏、wire 字节、encoded 通道与改动前逐字节一致。
// 开关在 import 时读一次 env,测试用 _setFrameEconomyForTests 切换(与 SP_PACER_SKIP_BUDGET_MS 同法)。

const truthy = (v) => v === '1' || v === 'true' || v === 'on';

/** @type {boolean} live binding:读它就是一次模块级 let 读,关闭时零额外开销可言(比函数调用便宜)。 */
export let FRAME_ECONOMY_ON = truthy(String(process.env.SP_FRAME_ECONOMY ?? '').toLowerCase());

/** 开启时的快照节奏(tick/字段;3 = legacy 的 SNAPSHOT_EVERY)。 */
export const SNAP_EVERY_ECONOMY = 6;

/** 测试钩子:null = 回落 env 值。 */
export function _setFrameEconomyForTests(v) {
  FRAME_ECONOMY_ON = v == null
    ? truthy(String(process.env.SP_FRAME_ECONOMY ?? '').toLowerCase())
    : truthy(String(v).toLowerCase());
}
