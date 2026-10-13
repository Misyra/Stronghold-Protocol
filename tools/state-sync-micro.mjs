// tools/state-sync-micro.mjs — 服务端状态同步链的**分段归因**微基准:在同一局真实四人比赛上,分别测量每一段的单次成本,
// 以及"构建出来但内容没变"的浪费比例。它回答的是"状态链路里钱花在哪",不测传输、延迟或承载能力。
//
// 被测分段(全部走生产代码,不复制实现):
//   publicView() 构建 → 去重 JSON.stringify → JSON.parse 回对象(差分基线) → diffState → 补丁 JSON.stringify
//   privateView() 构建 / stringify;检查点 captureMatch + encodeMatchCapture(同步路径)
//
// 用法:node --expose-gc tools/state-sync-micro.mjs [--round 6] [--steps 600] [--seed 91] [--json]
//   --round  N  把对局推进到第 N 回合的 PREP 再测量(默认 6,棋盘和手牌才有真实体量)
//   --steps  N  行动节奏模拟的步数(默认 600;每步一次真实操作 + 推进 200ms 虚拟时钟)
//   --seed   N  种子(默认 91)
//
// 不测:Worker 编码、WebSocket 写出、差分缓存命中率、持久化落盘。那些在 tools/state-sync-bench.mjs 里按端到端负载测。
import { performance } from 'node:perf_hooks';
import { makeMatch } from '../test/match/harness.js';
import { botPrepBegin } from '../server/match/bot.js';
import { Match } from '../server/match/Match.js';
import { PlayerState } from '../server/match/PlayerState.js';
import { publicStateJson } from '../server/match/match/messaging.js';
import { captureMatch, encodeMatchCapture } from '../server/match/snapshot.js';
import { diffState, applyStatePatch } from '../shared/stateDelta.js';
import { stateDeltaStats } from '../server/stateTransport.js';
import { bondList, offBondCounts } from '../server/match/bondsMeta.js';
import { boardOrder } from '../server/match/board.js';

const args = process.argv.slice(2);
const arg = (key, fallback) => { const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1]; };
const round = Number(arg('round', 6));
const steps = Number(arg('steps', 600));
const seed = Number(arg('seed', 91));
if (!Number.isInteger(round) || round < 1 || round > 12) throw new Error('invalid --round');
if (!Number.isInteger(steps) || steps < 0 || steps > 100_000) throw new Error('invalid --steps');
if (!Number.isInteger(seed) || seed < 0) throw new Error('invalid --seed');

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** 单段测时:先预热,再交替取 6 组样本取中位数(与 tools/state-pressure-bench.mjs 同一口径)。 */
function timeSegment(fn, { iterations, warmup = 2000, samples = 6 } = {}) {
  for (let i = 0; i < Math.min(warmup, iterations); i++) fn();
  const ms = [], cpuMs = [];
  for (let sample = 0; sample < samples; sample++) {
    globalThis.gc?.();
    const cpu = process.cpuUsage();
    const start = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    const used = process.cpuUsage(cpu);
    ms.push(performance.now() - start);
    cpuMs.push((used.user + used.system) / 1000);
  }
  const per = (list) => +(median(list) / iterations).toFixed(4);
  return { iterations, msPerCall: per(ms), cpuMsPerCall: per(cpuMs) };
}

/** 一局真实四人比赛,推进到目标回合的 PREP,并按 bot 预演给出棋盘(与 tools/bench-state-delta.mjs 的样本生成同法)。 */
function prepareMatch() {
  const h = makeMatch({ humans: 4, seed, fake: true, captureFrames: false, botRehearsal: 0,
    script: () => ({ duration: 2, leaks: {}, bossDps: 1e9 }) });
  h.start();
  for (let r = 1; r <= round; r++) {
    h.toPrep(r);
    for (const ps of h.m.order) botPrepBegin(h.m, ps);
  }
  if (h.m.errorCount) throw new Error(`match errors: ${h.m.errorCount}`);
  if (h.m.phase !== 'PREP') throw new Error(`expected PREP, got ${h.m.phase}`);
  return h;
}

/** 构建期计数包装(仅本工具内,不改生产代码)。 */
const counters = { pubBuilds: 0, pubWasted: 0, pubBuildMs: 0, pubStringifyMs: 0,
  privBuilds: 0, privWasted: 0, privBuildMs: 0, privStringifyMs: 0 };
const lastPubJson = new WeakMap();
const lastPrivJson = new WeakMap();
function installWrappers() {
  const origPublic = Match.prototype.publicView;
  Match.prototype.publicView = function patchedPublicView() {
    const t0 = performance.now();
    const view = origPublic.call(this);
    const t1 = performance.now();
    const json = publicStateJson(view);          // 生产去重基线:同一口径的 stringify
    const t2 = performance.now();
    counters.pubBuilds++;
    counters.pubBuildMs += t1 - t0;
    counters.pubStringifyMs += t2 - t1;
    if (lastPubJson.get(this) === json) counters.pubWasted++;
    lastPubJson.set(this, json);
    return view;
  };
  const origPrivate = PlayerState.prototype.privateView;
  PlayerState.prototype.privateView = function patchedPrivateView() {
    const t0 = performance.now();
    const view = origPrivate.call(this);
    const t1 = performance.now();
    const json = JSON.stringify(view);
    const t2 = performance.now();
    counters.privBuilds++;
    counters.privBuildMs += t1 - t0;
    counters.privStringifyMs += t2 - t1;
    if (lastPrivJson.get(this) === json) counters.privWasted++;
    lastPrivJson.set(this, json);
    return view;
  };
}

/** 可选操作:全部走生产 handle() 入口,返回是否被接受。 */
function act(m, ps, kind) {
  const pid = ps.playerId;
  switch (kind) {
    case 'refresh': return m.handle(pid, { t: 'g.refresh' });
    case 'freeze': return m.handle(pid, { t: 'g.freeze' });
    case 'levelUp': return m.handle(pid, { t: 'g.levelUp' });
    case 'buy': {
      const slot = ps.shop.slots.findIndex((s) => s && !s.sold && !s.frozen && ps.priceOf(s) <= ps.funds);
      return slot < 0 ? { error: 'NO_SLOT' } : m.handle(pid, { t: 'g.buy', slot });
    }
    case 'sell': {
      const i = ps.hand.findIndex(Boolean);
      if (i < 0) return { error: 'NO_PIECE' };
      return m.handle(pid, { t: 'g.sell', uid: ps.hand[i].uid });
    }
    default: return { error: 'UNKNOWN' };
  }
}

/** 真实行动节奏:每步一个操作 + 推进 200ms 虚拟时钟(> DELAYS.PUBLIC_THROTTLE),统计接受/拒绝与构建浪费。 */
function cadence(h, mix) {
  const m = h.m;
  const list = { private: ['refresh', 'freeze'], mixed: ['refresh', 'buy', 'freeze', 'levelUp', 'sell'],
    public: ['levelUp', 'buy', 'sell'] }[mix];
  const accepted = {}, rejected = {};
  const before = { pub: h.bc.filter((x) => x.t === 'm.public').length, priv: h.sent.filter(([, x]) => x.t === 'm.private').length };
  for (let i = 0; i < steps; i++) {
    const ps = m.order[i % m.order.length];
    if (ps.alive && ps.connected) {
      const kind = list[i % list.length];
      const res = act(m, ps, kind);
      if (res && res.ok) accepted[kind] = (accepted[kind] || 0) + 1;
      else rejected[kind] = (rejected[kind] || 0) + 1;
    }
    h.sched.advance(200);   // 让 PUBLIC_THROTTLE 与各类定时器按真实节奏推进
  }
  m.flush(true);
  return { accepted, rejected,
    publicFramesSent: h.bc.filter((x) => x.t === 'm.public').length - before.pub,
    privateFramesSent: h.sent.filter(([, x]) => x.t === 'm.private').length - before.priv };
}

const h = prepareMatch();
try {
  const m = h.m;
  const ps0 = m.order[0];
  const publicBytes = Buffer.byteLength(JSON.stringify(m.publicView()));
  const privateBytes = Buffer.byteLength(JSON.stringify(ps0.privateView()));
  const boards = m.order.map((ps) => ({ playerId: ps.playerId, board: ps.deployCount, hand: ps.hand.filter(Boolean).length,
    bonds: ps.publicBondsView(m.gd).length }));

  // 1) 分段成本:同一份视图反复走每一段
  const count = 2000;
  const pubView = m.publicView();
  const privView = ps0.privateView();
  const pubJson = publicStateJson(pubView);
  const privJson = JSON.stringify(privView);
  const pubParsed = JSON.parse(pubJson);
  // 差分输入:一份真实的前后状态(改一个玩家资金/商店),补丁大小才有意义
  const before = JSON.parse(pubJson);
  const after = JSON.parse(pubJson);
  after.players[0].lp -= 1;
  after.players[1].shopLevel += 1;

  // 1a) 传输段:第二次发送同一频道的状态(基线命中、差分、补丁、整帧回退的构建)。每次用新的 stub 对象,
  // 快照与转换缓存才不会把成本吃掉;基线只提交一次,所以每轮都是一次真实转换。
  const transport = {};
  {
    const { negotiateStateDelta, prepareStateFrame } = await import('../server/stateTransport.js');
    const ws = {};
    negotiateStateDelta(ws, 1);
    const mk = (kind, view) => {
      const encoded = kind === 'm.public' ? publicStateJson(view) : JSON.stringify(view);
      const frame = prepareStateFrame(ws, { t: kind }, encoded);
      return { encoded, frame };
    };
    for (const [kind, makeView] of [
      ['m.public', () => { const v = m.publicView(); v.serverNow = (v.serverNow || 0) + 0; v.players[0].lp -= 1; return v; }],
      ['m.private', () => { const v = ps0.privateView(); v.funds -= 1; return v; }],
    ]) {
      const base = mk(kind, makeView());
      base.frame.commit();                                         // one committed baseline for this channel
      transport[kind === 'm.public' ? 'transportPublicTransition' : 'transportPrivateTransition'] =
        timeSegment(() => { const { frame } = mk(kind, makeView()); if (!frame.data) throw new Error('no frame'); }, { iterations: 500, warmup: 100 });
      transport[kind === 'm.public' ? 'transportPublicFull' : 'transportPrivateFull'] =
        timeSegment(() => { const view = makeView(); const encoded = kind === 'm.public' ? publicStateJson(view) : JSON.stringify(view);
          const fresh = {}; negotiateStateDelta(fresh, 1); prepareStateFrame(fresh, { t: kind }, encoded); }, { iterations: 500, warmup: 100 });
    }
  }

  const segments = {
    publicView: timeSegment(() => m.publicView(), { iterations: count }),
    publicViewWarm: timeSegment(() => m.publicView(), { iterations: count, warmup: 0 }),
    // 真实场景:一次只有私人字段变化的 dirty() 之后重建公共视图(每个玩家的 bond 列缓存被作废)
    publicViewAfterDirty: timeSegment(() => { ps0.dirty(); return m.publicView(); }, { iterations: count }),
    privateView: timeSegment(() => ps0.privateView(), { iterations: count }),
    publicDedupStringify: timeSegment(() => publicStateJson(pubView), { iterations: count }),
    privateStringify: timeSegment(() => JSON.stringify(privView), { iterations: count }),
    parsePublic: timeSegment(() => JSON.parse(pubJson), { iterations: count }),
    parsePrivate: timeSegment(() => JSON.parse(privJson), { iterations: count }),
    diffState: timeSegment(() => diffState(before, after), { iterations: count }),
    applyStatePatch: timeSegment(() => applyStatePatch(pubParsed, diffState(before, after)), { iterations: count }),
    patchStringify: timeSegment(() => JSON.stringify(diffState(before, after)), { iterations: count }),
    ...transport,
    // 优先级 1 去掉的那一步的精确成本:每帧一次整帧文本拼接 + 其 UTF-8 字节数扫描(基线为增量帧也做)
    fullTextBuildPublic: timeSegment(() => Buffer.byteLength(`{"t":"m.state","kind":"m.public","seq":1,"full":${pubJson}}`), { iterations: 500, warmup: 100 }),
    fullTextBuildPrivate: timeSegment(() => Buffer.byteLength(`{"t":"m.state","kind":"m.private","seq":1,"full":${privJson}}`), { iterations: 500, warmup: 100 }),
    checkpointCapture: timeSegment(() => captureMatch(m), { iterations: 500, warmup: 100 }),
    checkpointClone: timeSegment(() => structuredClone(captureMatch(m)), { iterations: 300, warmup: 60 }),
    checkpointEncodeSync: timeSegment(() => encodeMatchCapture(captureMatch(m)), { iterations: 200, warmup: 50 }),
  };

  // 1b) 视图内部归因:m.private 的哪一块贵,m.public 的哪一块贵(都是纯读)
  const breakdown = {
    privateBondsFull: timeSegment(() => bondList(m.gd, ps0.bondsView(), { full: true, off: offBondCounts(m.gd, ps0) }), { iterations: count }),
    privateEffects: timeSegment(() => ps0.effectsView(), { iterations: count }),
    privateNextEnemies: timeSegment(() => m.nextEnemiesFor(ps0), { iterations: count }),
    privateBoardPieces: timeSegment(() => { const out = []; for (const { r, c, piece } of boardOrder(ps0.board)) out.push(ps0.pieceView(piece, [r, c])); return out; }, { iterations: count }),
    privateShopSlots: timeSegment(() => ps0.shop.slots.map((s) => (s ? { kind: s.kind, id: s.id, price: ps0.priceOf(s), basePrice: s.basePrice, sold: !!s.sold, frozen: !!s.frozen } : null)), { iterations: count }),
    privateHand: timeSegment(() => ps0.hand.map((p) => (p ? ps0.pieceView(p) : null)), { iterations: count }),
    publicBondsColumn: timeSegment(() => ps0.publicBondsView(m.gd), { iterations: count }),
    publicStatusColumn: timeSegment(() => m.order.map((ps) => ({ fieldId: m.fieldOf(ps), status: m.statusOf(ps) })), { iterations: count }),
  };

  // 2) 真实节奏下的构建浪费:同一个视图对象被构建了几次,其中几次内容与上一次完全相同
  installWrappers();
  const runs = {};
  for (const mix of ['private', 'mixed', 'public']) {
    counters.pubBuilds = counters.pubWasted = counters.privBuilds = counters.privWasted = 0;
    counters.pubBuildMs = counters.pubStringifyMs = counters.privBuildMs = counters.privStringifyMs = 0;
    const frames = cadence(h, mix);
    runs[mix] = { ...frames,
      publicBuilds: counters.pubBuilds, publicBuildsUnchanged: counters.pubWasted,
      publicBuildMs: +counters.pubBuildMs.toFixed(1), publicBuildMsWasted: +(counters.pubWasted / Math.max(1, counters.pubBuilds) * counters.pubBuildMs).toFixed(1),
      publicDedupStringifyMs: +counters.pubStringifyMs.toFixed(1),
      privateBuilds: counters.privBuilds, privateBuildsUnchanged: counters.privWasted,
      privateBuildMs: +counters.privBuildMs.toFixed(1), privateStringifyMs: +counters.privStringifyMs.toFixed(1),
      matchErrors: m.errorCount };
  }

  // 3) 换一局推进到 COMBAT:战斗期的公共视图带战场进度与队友待扣 LP,规模与 PREP 不同(单独一局,不影响上面的节奏模拟)
  const combat = {};
  let h2 = null;
  try {
    h2 = prepareMatch();
    h2.drive(() => h2.m.phase === 'COMBAT' || h2.ended != null, { ready: true });
    if (h2.m.phase === 'COMBAT') {
      const alive = h2.m.alivePlayers()[0];
      combat.phase = h2.m.phase;
      combat.round = h2.m.round;
      combat.fields = h2.m.fields.map((f) => ({ kind: f.kind, cc: !!f.cc, live: !!f.live }));
      combat.publicBytes = Buffer.byteLength(JSON.stringify(h2.m.publicView()));
      combat.publicView = timeSegment(() => h2.m.publicView(), { iterations: count }).msPerCall;
      if (alive) {
        combat.privateBytes = Buffer.byteLength(JSON.stringify(alive.privateView()));
        combat.privateView = timeSegment(() => alive.privateView(), { iterations: count }).msPerCall;
      }
    } else combat.skipped = `phase ${h2.m.phase}`;
  } catch (e) { combat.skipped = String((e && e.message) || e); }
  finally { h2?.m.dispose(); }

  const result = {
    node: process.version, platform: process.platform, seed, round, steps,
    phase: m.phase, publicBytes, privateBytes, players: boards,
    // 差分账本:每个状态帧被解析了几次(parsedBaselines / frames)、整帧与增量各多少
    stateDelta: { ...stateDeltaStats },
    segments: Object.fromEntries(Object.entries(segments).map(([k, v]) => [k, v.msPerCall])),
    breakdown: Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, v.msPerCall])),
    patchOps: diffState(before, after).length,
    runs,
    combat,
    scope: '单局、单进程、虚拟时钟;分段成本与构建浪费比例,不含传输、Worker 编码、落盘与浏览器渲染',
  };
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`对局:R${m.round} ${m.phase} · 公共状态 ${publicBytes} B · 私人状态 ${privateBytes} B(四人棋盘子数 ${boards.map((b) => b.board).join('/')})`);
    console.log('分段单次成本(ms/次,中位数):');
    for (const [k, v] of Object.entries(result.segments)) console.log(`  ${k.padEnd(22)} ${v}`);
    console.log('视图内部归因(ms/次):');
    for (const [k, v] of Object.entries(result.breakdown)) console.log(`  ${k.padEnd(22)} ${v}`);
    console.log(`战斗期对照:${combat.skipped ? '跳过(' + combat.skipped + ')' : `公共视图 ${combat.publicView} ms / ${combat.publicBytes} B · 私人视图 ${combat.privateView ?? '-'} ms / ${combat.privateBytes ?? '-'} B · 战场 ${JSON.stringify(combat.fields)}`}`);
    console.log('真实行动节奏下的构建浪费:');
    for (const [mix, r] of Object.entries(runs)) {
      const pct = r.publicBuilds ? (100 * r.publicBuildsUnchanged / r.publicBuilds).toFixed(0) : '-';
      console.log(`  ${mix.padEnd(8)} 公共构建 ${r.publicBuilds} 次(其中内容未变 ${r.publicBuildsUnchanged} 次 = ${pct}%),发出 ${r.publicFramesSent} 帧;私人构建 ${r.privateBuilds} 次(未变 ${r.privateBuildsUnchanged}),发出 ${r.privateFramesSent} 帧;引擎错误 ${r.matchErrors}`);
      console.log(`           公共构建耗时 ${r.publicBuildMs} ms(按未变比例折算浪费 ${r.publicBuildMsWasted} ms)· 去重 stringify ${r.publicDedupStringifyMs} ms`);
    }
  }
} finally {
  h.m.dispose();
}
