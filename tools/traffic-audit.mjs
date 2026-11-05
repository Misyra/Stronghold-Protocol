// tools/traffic-audit.mjs — 对局 WS 流量审计:一局真实对局(生产 client-combat 路径)逐消息类统计条数与未压缩
// 应用层字节数(permessage-deflate 之前的 JSON 文本),供流量优化 A/B 与现状量化表使用。
//
//   node tools/traffic-audit.mjs [--seats 2] [--bots 2] [--spectators 1] [--seed 7] [--rounds N] [--json]
//     --seats  人类席位数(带 SimClient,按整备期轮转发 buy/move/refresh 意图,贴近 loadgen 的负载形态)
//     --bots   AI 席位数
//     --spectators 观战席位数
//     --rounds 只统计到第 N 回合(默认整局)
//
// 口径:广播按在线成员扇出计(服务器每成员一份);m.public/m.private 另行过一遍 stateTransport 的差分通道,
// 给出「全量帧字节 / 差分帧字节」两行。b.snap/b.ev 只在 legacy server-run 模式出现,这里默认不测。
import { makeMatch } from '../test/match/harness.js';
import { negotiateStateDelta, prepareStateFrame } from '../server/stateTransport.js';

const args = process.argv.slice(2);
const arg = (key, fallback) => { const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1]; };
const humans = Number(arg('seats', 2));
const bots = Number(arg('bots', 2));
const spectators = Number(arg('spectators', 1));
const seed = Number(arg('seed', 7));
const maxRound = arg('rounds', null) ? Number(arg('rounds', 0)) : null;
const asJson = args.includes('--json');
if (!Number.isInteger(humans) || humans < 1) throw new Error('invalid --seats');
if (!Number.isInteger(bots) || bots < 0) throw new Error('invalid --bots');
if (!Number.isInteger(spectators) || spectators < 0) throw new Error('invalid --spectators');

const bytesOf = (msg) => Buffer.byteLength(JSON.stringify(msg));
const PREP_ROTATION = ['g.buy', 'g.move', 'g.refresh', 'g.levelUp', 'g.freeze'];

const h = makeMatch({
  mode: 'coop', difficulty: 'NORMAL', seed, clientCombat: true,
  seats: [
    ...Array.from({ length: humans }, (_, i) => ({ seat: i, playerId: `p_${i}`, name: `P${i}`, isBot: false, connected: true })),
    ...Array.from({ length: bots }, (_, i) => ({ seat: humans + i, playerId: `ai_${i}`, name: `AI${i}`, isBot: true, connected: true })),
  ],
  spectators: spectators ? Array.from({ length: spectators }, (_, i) => `s_${i}`) : undefined,
  hostId: 'p_0',
});

// ---- capture: every unicast per recipient + every broadcast per online member -------------------------------
const m = h.m;
const onlineMembers = () => [...m.players.values(), ...m.spectators.values()].filter((ps) => !ps.isBot && !ps.left && ps.connected);
const rows = new Map(); // t -> { count, bytes, max }
const note = (t, bytes) => {
  const r = rows.get(t) || { count: 0, bytes: 0, max: 0 };
  r.count++; r.bytes += bytes; r.max = Math.max(r.max, bytes);
  rows.set(t, r);
};
h.onSend.push((pid, msg) => note(msg.t, bytesOf(msg)));
h.onBroadcast.push((msg) => { const n = onlineMembers().length || 1; for (let i = 0; i < n; i++) note(msg.t, bytesOf(msg)); });

// ---- a seeded prep rotation for each human seat (loadgen's shape: buy → move → refresh → levelUp → freeze) ---
let lcg = seed >>> 0 || 1;
const rnd = (n) => (lcg = (lcg * 1664525 + 1013904223) >>> 0) % n;
let actedRound = -1;
const act = () => {
  if (m.phase !== 'PREP' || m.round === actedRound) return false;
  const ps = m.players.get(`p_${rnd(humans)}`);
  if (!ps || !ps.alive || ps.isBot || ps.ready) return false;
  actedRound = m.round;
  const handIdx = ps.hand.findIndex((p) => p);
  if (handIdx >= 0) {
    m.handle(ps.playerId, { t: 'g.move', uid: ps.hand[handIdx].uid, to: { area: 'board', row: 2 + rnd(3), col: rnd(9) } });
  } else if (ps.funds >= 60) {
    const slot = ps.shop.slots.findIndex((s) => s && !s.sold && s.price <= ps.funds);
    if (slot >= 0) m.handle(ps.playerId, { t: 'g.buy', slot });
  }
  if (rnd(3) === 0) m.handle(ps.playerId, { t: 'g.refresh' });
  if (rnd(6) === 0) m.handle(ps.playerId, { t: 'g.levelUp' });
  if (rnd(8) === 0) m.handle(ps.playerId, { t: 'g.freeze' });
  m.flushSoon();
  return true;
};

h.start();
const started = h.sched.now();
h.drive(() => h.ended != null || (maxRound != null && m.round > maxRound), { maxSteps: 6e6 });
// keep timers flush-dead so pending views go out
h.sched.advance(500);
m.flush(true);
const matchMs = h.sched.now() - started;
if (!rows.size) throw new Error('the match produced no traffic');

// ---- the delta transport over the same captured views ---------------------------------------------------------
const pubViews = h.bc.filter((x) => x.t === 'm.public');
const privViews = h.sent.filter(([, x]) => x.t === 'm.private').map(([, x]) => x);
const deltaOf = (views, conns) => {
  const sockets = Array.from({ length: conns }, () => ({}));
  for (const ws of sockets) negotiateStateDelta(ws, 1);
  let full = 0, delta = 0, bytes = 0;
  for (const view of views) {
    const key = { t: view.t };
    const encoded = JSON.stringify(view);
    for (const ws of sockets) {
      const frame = prepareStateFrame(ws, key, encoded);
      const n = Buffer.byteLength(frame.data);
      bytes += n;
      if (frame.data.includes('"patch":')) delta++; else full++;
      frame.commit();
    }
  }
  return { frames: views.length * conns, bytes, full, delta, whole: Buffer.byteLength(views.map((v) => JSON.stringify(v)).join('')) * conns };
};
const pubDelta = deltaOf(pubViews, Math.max(1, humans + spectators));
const privDelta = deltaOf(privViews, humans);

// ---- report ----------------------------------------------------------------------------------------------------
const total = [...rows.values()].reduce((s, r) => s + r.bytes, 0);
const frames = [...rows.values()].reduce((s, r) => s + r.count, 0);
const result = {
  seats: humans, bots, spectators, seed, ended: h.ended != null, roundsPlayed: m.round, matchMinutes: +(matchMs / 60000).toFixed(2),
  totalBytes: total, totalFrames: frames,
  perMemberPerMinuteKB: +((total / Math.max(1, humans + spectators)) / (matchMs / 60000) / 1024).toFixed(1),
  types: [...rows.entries()].map(([t, r]) => ({
    t, count: r.count, bytes: r.bytes, avg: Math.round(r.bytes / r.count), max: r.max,
    pctOfBytes: +((100 * r.bytes) / total).toFixed(1),
    perMin: +((r.count / (matchMs / 60000)).toFixed(1)),
  })).sort((a, b) => b.bytes - a.bytes),
  deltaTransport: {
    'm.public': { views: pubViews.length, conns: Math.max(1, humans + spectators), ...pubDelta,
      savedPct: pubDelta.whole ? +(100 * (1 - pubDelta.bytes / pubDelta.whole)).toFixed(1) : 0 },
    'm.private': { views: privViews.length, conns: humans, ...privDelta,
      savedPct: privDelta.whole ? +(100 * (1 - privDelta.bytes / privDelta.whole)).toFixed(1) : 0 },
  },
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`traffic audit — ${humans}P+${bots}AI+${spectators}spec coop, seed ${seed}, ${result.roundsPlayed} rounds, ${result.matchMinutes} match-min (virtual), ended=${result.ended}`);
  console.log(`total ${result.totalBytes} bytes application-layer JSON (pre-deflate), ${frames} frames after fanout\n`);
  console.log('  t'.padEnd(16) + 'count'.padStart(8) + 'bytes'.padStart(11) + 'avg'.padStart(9) + 'max'.padStart(10) + '%bytes'.padStart(8) + '/min'.padStart(8));
  for (const r of result.types) {
    console.log(r.t.padEnd(16) + String(r.count).padStart(8) + String(r.bytes).padStart(11)
      + String(r.avg).padStart(9) + String(r.max).padStart(10) + (r.pctOfBytes + '%').padStart(8) + String(r.perMin).padStart(8));
  }
  for (const [k, d] of Object.entries(result.deltaTransport)) {
    console.log(`\n${k} delta transport: ${d.views} views × ${d.conns} conns → ${d.bytes} bytes (whole ${d.whole}, saved ${d.savedPct}%, full ${d.full} / delta ${d.delta})`);
  }
}
