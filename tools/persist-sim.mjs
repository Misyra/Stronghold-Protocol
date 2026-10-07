// tools/persist-sim.mjs — local simulation for the persistence pipeline (docs/operations/PERSISTENCE.md).
//
// Phase A "multi-user hard kill": boots a real server in a child process, connects real WebSocket clients (four in a
// co-op room, one solo), drives the matches into a checkpointable PREP with purchases, flushes, SIGKILLs the child,
// boots a fresh one on the same state directory and reconnects every client with its token. Everything — identities,
// seats, room, match, round, economy — must come back.
//
// Phase B "scale": boots one server in-process, opens N rooms with running matches, and measures the flush pipeline:
// event-loop lag, flush duration, shard writes on an unchanged follow-up flush (the dirty check), the synchronous
// encode cost it replaces, the bytes on disk, and a full restart that must restore every room.
//
// Usage: node tools/persist-sim.mjs [--rooms 250] [--skip-multi] [--skip-scale]

import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const SKIP_MULTI = args.includes('--skip-multi');
const SKIP_SCALE = args.includes('--skip-scale');
const roomsIdx = args.indexOf('--rooms');
const ROOMS = roomsIdx >= 0 && Number.isFinite(Number(args[roomsIdx + 1])) ? Number(args[roomsIdx + 1]) : 250;

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

async function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------------------------------
// Phase A — multi-user hard kill
// ---------------------------------------------------------------------------------------------------

const CHILD_SOURCE = `
import { pathToFileURL } from 'node:url';
const { startServer } = await import(pathToFileURL(process.env.SP_SIM_ROOT + '/server/index.js'));
const { Match } = await import(pathToFileURL(process.env.SP_SIM_ROOT + '/server/match/Match.js'));
const { VirtualScheduler } = await import(pathToFileURL(process.env.SP_SIM_ROOT + '/server/match/scheduler.js'));
const { FakeBattle } = await import(pathToFileURL(process.env.SP_SIM_ROOT + '/test/match/fakeBattle.js'));
class TestMatch extends Match {
  constructor(opts) {
    super({ ...opts, scheduler: new VirtualScheduler({ instantCombat: true }), BattleClass: FakeBattle, botRehearsal: 0, clientCombat: false });
  }
}
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
process.on('uncaughtException', (e) => { console.error('[child] uncaught:', (e && (e.stack || e.message)) || e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('[child] unhandled rejection:', (e && (e.stack || e.message)) || e); });
const srv = await startServer({ port: 0, host: '127.0.0.1', workers: 0, log: quiet, stateFile: process.env.SP_SIM_STATE, MatchClass: TestMatch });
process.on('message', async (msg) => {
  if (msg === 'flush') {
    const ok = await srv.persister.flush('test');
    process.send({ flushed: ok });
  } else if (msg === 'inspect') {
    const rooms = [...srv.lobby.rooms.values()].map((r) => ({
      code: r.code, mode: r.mode, inMatch: !!r.match, round: r.match ? r.match.round : null, phase: r.match ? r.match.phase : null,
      errors: r.match ? r.match.errorCount : 0,
      players: r.match ? r.match.order.map((ps) => ({
        id: ps.playerId, funds: ps.funds, alive: ps.alive,
        hand: ps.hand ? [...ps.hand].filter(Boolean).length : 0,
        board: ps.board ? ps.board.size : 0,
        shop: ps.shop ? ps.shop.slots.findIndex((s) => s && s.kind === 'chess' && !s.sold) : -1,
      })) : [],
    }));
    process.send({ rooms, sessions: srv.registry.size });
  } else if (msg && msg.type === 'advance') {
    // The matches run on a virtual clock: the parent drives it, exactly like the unit-test harness does.
    const out = [];
    for (const room of srv.lobby.rooms.values()) {
      const m = room.match;
      if (!m || m.ended || m.disposed) continue;
      try {
        const pred = msg.to === 'round2'
          ? () => m.ended || m.round >= 2
          : () => m.phase === 'PREP' || m.ended;
        const ok = m.sched.runUntil(pred, { maxSteps: 50_000 });
        out.push({ code: room.code, ok, phase: m.phase, round: m.round });
      } catch (e) {
        out.push({ code: room.code, error: String((e && e.message) || e).slice(0, 140) });
      }
    }
    process.send({ advanced: true, out });
  }
});
process.send({ port: srv.port });
`;

async function phaseMultiUser() {
  console.log('\n=== A · 多用户硬杀恢复(4 人同盟房 + 1 个单人房,真实 WebSocket 客户端)===');
  const stateDir = await tmpDir('sp-sim-state-');
  const childFile = path.join(await tmpDir('sp-sim-child-'), 'child.mjs');
  await fs.writeFile(childFile, CHILD_SOURCE);
  const children = [];
  const boot = async () => {
    const child = fork(childFile, [], {
      env: { ...process.env, SP_SIM_ROOT: ROOT, SP_SIM_STATE: stateDir },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    child.on('exit', (code, signal) => console.log(`  [child ${child.pid} exited code=${code} signal=${signal}]`));
    children.push(child);
    const [hello] = await once(child, 'message');
    return { child, port: hello.port };
  };
  const killAll = async () => {
    for (const c of children) {
      if (c.exitCode === null && c.signalCode === null) {
        const exited = once(c, 'exit');
        c.kill('SIGKILL');
        await exited;
      }
    }
  };

  try {
    const { TestClient } = await import(pathToFileURL(path.join(ROOT, 'test/helpers/wsClient.js')));
    const first = await boot();

    // four humans in a co-op room, one solo
    const coop = [];
    for (let i = 0; i < 4; i++) {
      const c = await TestClient.connect(`ws://127.0.0.1:${first.port}/ws`);
      const w = await c.hello(`sim-coop-${i}`);
      c.id = w.playerId; c.token = w.token;
      coop.push(c);
    }
    const created = await coop[0].request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    if (created.t !== 'ok') throw new Error(`room.create: ${JSON.stringify(created)}`);
    const code = (await coop[0].waitFor('room.state')).code;
    for (let i = 1; i < 4; i++) await coop[i].request({ t: 'room.join', code });
    await coop[0].waitFor('room.state', (s) => s.seats.filter(Boolean).length === 4);
    for (const c of coop) await c.request({ t: 'room.ready', ready: true });
    if ((await coop[0].request({ t: 'room.start' })).t !== 'ok') throw new Error('room.start failed');

    const solo = await TestClient.connect(`ws://127.0.0.1:${first.port}/ws`);
    const sw = await solo.hello('sim-solo');
    solo.id = sw.playerId; solo.token = sw.token;
    await solo.request({ t: 'room.create', mode: 'solo', difficulty: 'HARD' });
    const soloCode = (await solo.waitFor('room.state')).code;
    await solo.request({ t: 'room.start' });

    const inspect = (child = first.child) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('inspect timeout')), 5000);
      once(child, 'message').then(([msg]) => { clearTimeout(timer); resolve(msg); });
      child.send('inspect');
    });
    const advance = (child, to) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('advance timeout')), 20_000);
      once(child, 'message').then(([msg]) => {
        clearTimeout(timer);
        if (msg.out && msg.out.some((o) => o.error)) reject(new Error(`advance: ${JSON.stringify(msg.out)}`));
        else resolve(msg);
      });
      child.send({ type: 'advance', to });
    });
    const until = async (pred, what, child = first.child, tries = 150) => {
      for (let i = 0; i < tries; i++) {
        const snap = await inspect(child);
        if (pred(snap)) return snap;
        await new Promise((r) => setTimeout(r, 50));
      }
      const last = await inspect(child);
      throw new Error(`timed out waiting for ${what}; rooms now: ${JSON.stringify(last.rooms.map((r) => ({ code: r.code, mode: r.mode, phase: r.phase, round: r.round, players: r.players.length })))}`);
    };

    // confirm the match info like real players, then let the engine's clocks run toward the first prep;
    // while a room sits in the band draft its humans pick (out-of-turn picks error harmlessly)
    for (const c of [...coop, solo]) await c.request({ t: 'g.infoReady' });
    await advance(first.child, 'prep');
    let before = null;
    for (let i = 0; i < 100; i++) {
      before = await inspect();
      if (before.rooms.every((r) => r.phase === 'PREP')) break;
      for (const room of before.rooms) {
        if (room.phase !== 'BAND_DRAFT') continue;
        const members = room.mode === 'solo' ? [solo] : coop.filter((c) => room.players.some((p) => p.id === c.id));
        for (const c of members) await c.request({ t: 'g.band', bandId: 'band_bldsk' }).catch(() => {});
      }
      await advance(first.child, 'prep');
    }
    if (!before.rooms.every((r) => r.phase === 'PREP')) {
      throw new Error(`timed out waiting for PREP; rooms now: ${JSON.stringify(before.rooms.map((r) => ({ code: r.code, phase: r.phase, round: r.round })))}`);
    }
    // a real purchase in the prep: the shard must change, not just the clocks
    let bought = 0;
    for (const room of before.rooms) {
      const client = room.mode === 'solo' ? solo : coop.find((c) => room.players.some((p) => p.id === c.id));
      const me = room.players.find((p) => p.id === client.id);
      if (me && me.shop >= 0) {
        const res = await client.request({ t: 'g.buy', slot: me.shop });
        if (res.t === 'ok') bought++;
      }
    }
    const snapBefore = await inspect();
    const fundsBefore = Object.fromEntries(snapBefore.rooms.flatMap((r) => r.players.map((p) => [p.id, p.funds])));
    console.log(`  开局: ${snapBefore.rooms.length} 个房间(${snapBefore.rooms.map((r) => r.mode).join(' + ')}),全部进入 PREP,完成 ${bought} 笔购买`);

    const flushed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('flush timeout')), 10_000);
      once(first.child, 'message').then(([msg]) => { clearTimeout(timer); resolve(msg); });
      first.child.send('flush');
    });
    if (!flushed.flushed) throw new Error('the flush did not land');
    const shardCodes = (await fs.readdir(path.join(stateDir, 'matches'))).sort();
    const runtimeDoc = JSON.parse(await fs.readFile(path.join(stateDir, 'runtime.json'), 'utf8'));
    console.log(`  落盘: index.json + runtime.json + ${shardCodes.length} 个分片(${shardCodes.join(', ')}),时钟信封 ${Object.keys(runtimeDoc.clocks).length} 项`);

    // hard kill, no goodbye
    await killAll();

    const second = await boot();
    const back = [];
    for (const c of coop) back.push(await TestClient.connect(`ws://127.0.0.1:${second.port}/ws`));
    const soloBack = await TestClient.connect(`ws://127.0.0.1:${second.port}/ws`);
    const ids = [];
    for (let i = 0; i < coop.length; i++) {
      const w = await back[i].hello(`sim-coop-${i}`, coop[i].token);
      ids.push(w.playerId === coop[i].id);
    }
    const soloId = (await soloBack.hello('sim-solo', solo.token)).playerId === solo.id;
    if (!ids.every(Boolean) || !soloId) throw new Error('a token did not resolve to its player id after the restart');
    const roomBack = await back[0].waitFor('room.state');
    if (roomBack.code !== code || !roomBack.inMatch) throw new Error('the co-op room did not come back in its match');
    await back[0].waitFor('m.public', (p) => p.phase === 'PREP');

    const after = await inspect(second.child);
    const fundsAfter = Object.fromEntries(after.rooms.flatMap((r) => r.players.map((p) => [p.id, p.funds])));
    const sameFunds = Object.keys(fundsBefore).every((id) => fundsBefore[id] === fundsAfter[id]);
    const sameShape = after.rooms.length === snapBefore.rooms.length
      && after.rooms.every((r) => r.inMatch && r.errors === 0);
    console.log(`  重启后: ${after.sessions} 个会话、${after.rooms.length} 个房间、${after.rooms.filter((r) => r.inMatch).length} 个对局恢复`);
    console.log(`  校验: 身份 ${ids.filter(Boolean).length + (soloId ? 1 : 0)}/5 一致 · 资金 ${sameFunds ? '完全一致' : '不一致!'} · 对局形态 ${sameShape ? '一致(0 错误)' : '不一致!'}`);
    if (!sameFunds || !sameShape) throw new Error('the restored state does not match the pre-kill state');

    // the restored matches keep playing: everyone readies, the interrupted round is fought again, round 2 begins
    for (const c of [...back, soloBack]) await c.request({ t: 'g.ready', ready: true }).catch(() => {});
    await advance(second.child, 'round2');
    const played = await until(
      (snap) => snap.rooms.every((r) => r.round >= 2 || !r.inMatch),
      'the restored matches advancing to round 2',
      second.child,
    );
    const playedErrors = played.rooms.reduce((sum, r) => sum + r.errors, 0);
    console.log(`  续玩: 恢复的对局推进到第 2 回合(${played.rooms.map((r) => `${r.code}:R${r.round}${r.inMatch ? '' : '(已结束)'}`).join(', ')}),累计 ${playedErrors} 个引擎错误`);
    if (playedErrors > 0) throw new Error('the restored matches produced engine errors');
    for (const c of [...back, soloBack]) await c.close().catch(() => {});
    for (const c of [...coop, solo]) await c.close().catch(() => {});
    await killAll();
    console.log('  ✓ 多用户硬杀恢复通过');
  } finally {
    await killAll();
    await fs.rm(path.dirname(childFile), { recursive: true, force: true }).catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------
// Phase B — scale
// ---------------------------------------------------------------------------------------------------

async function phaseScale(rooms) {
  console.log(`\n=== B · 规模基准(${rooms} 个房间,分片存储 + 持久化 Worker)===`);
  const { startServer } = await import(pathToFileURL(path.join(ROOT, 'server/index.js')));
  const { Match } = await import(pathToFileURL(path.join(ROOT, 'server/match/Match.js')));
  const { VirtualScheduler } = await import(pathToFileURL(path.join(ROOT, 'server/match/scheduler.js')));
  const { FakeBattle } = await import(pathToFileURL(path.join(ROOT, 'test/match/fakeBattle.js')));
  const { snapshotMatch } = await import(pathToFileURL(path.join(ROOT, 'server/match/snapshot.js')));
  class TestMatch extends Match {
    constructor(opts) {
      super({ ...opts, scheduler: new VirtualScheduler({ instantCombat: true }), BattleClass: FakeBattle, botRehearsal: 0, clientCombat: false });
    }
  }

  const stateDir = await tmpDir('sp-sim-scale-');
  let srv;
  try {
    srv = await startServer({ port: 0, quiet: true, log: quiet, stateFile: stateDir, MatchClass: TestMatch, workers: 0 });
    // Measure completed rounds, not requests deferred by the live checkpoint/interval throttle.
    srv.persister.stop();
    const { registry, lobby } = srv;
    let writtenBytes = 0;
    const writeAtomic = srv.store.writeAtomic.bind(srv.store);
    srv.store.writeAtomic = async (file, content) => {
      await writeAtomic(file, content);
      writtenBytes += Buffer.byteLength(content);
    };
    const t0 = performance.now();
    for (let i = 0; i < rooms; i++) {
      const s = registry.create(`sim-${i}`);
      if (!lobby.create(s, { mode: 'solo', difficulty: 'NORMAL' }).ok) throw new Error(`room ${i} failed`);
      const room = lobby.getRoom(s.roomCode);
      const res = lobby.startMatchWith(room, `sim-${i}`, null);
      if (res && res.error) throw new Error(`match ${i} failed: ${JSON.stringify(res)}`);
    }
    console.log(`  开局 ${rooms} 房: ${Math.round(performance.now() - t0)} ms(虚拟时钟,全部停在可检查点的 INFO_CHECK)`);

    // event-loop lag probe: a 5 ms interval measures how far behind the loop falls
    let maxLag = 0;
    let last = performance.now();
    const probe = setInterval(() => {
      const t = performance.now();
      maxLag = Math.max(maxLag, t - last - 5);
      last = t;
    }, 5);
    probe.unref?.();

    const timeFlush = async (label) => {
      maxLag = 0;
      const before = srv.store.shardWrites;
      const beforeIndex = srv.store.indexWrites;
      const beforeRuntime = srv.store.runtimeWrites;
      const beforeBytes = writtenBytes;
      const t = performance.now();
      const ok = await srv.persister.flush('test');
      if (!ok) throw new Error(`${label}: flush failed`);
      const ms = performance.now() - t;
      return { label, ok, ms, maxLag, shardWrites: srv.store.shardWrites - before,
        indexWrites: srv.store.indexWrites - beforeIndex, runtimeWrites: srv.store.runtimeWrites - beforeRuntime,
        writtenBytes: writtenBytes - beforeBytes };
    };

    const cold = await timeFlush('cold (first flush)');
    const warm = await timeFlush('warm (no changes)');
    const warm2 = await timeFlush('warm (no changes)');
    if (warm.shardWrites || warm2.shardWrites || warm.indexWrites || warm2.indexWrites) throw new Error('unchanged matches rewrote shards/index');
    const syncStart = performance.now();
    let syncBytes = 0;
    for (const room of lobby.rooms.values()) {
      if (!room.match) continue;
      const doc = snapshotMatch(room.match);
      if (doc) syncBytes += JSON.stringify(doc).length;
    }
    const syncMs = performance.now() - syncStart;
    clearInterval(probe);

    let files = 0;
    let bytes = 0;
    const walk = async (d) => {
      for (const entry of await fs.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) await walk(p);
        else { files++; bytes += (await fs.stat(p)).size; }
      }
    };
    await walk(stateDir);
    const { layout, revision, ...legacyIndex } = JSON.parse(await fs.readFile(path.join(stateDir, 'index.json'), 'utf8'));
    const runtime = JSON.parse(await fs.readFile(path.join(stateDir, 'runtime.json'), 'utf8'));
    const legacyClocks = Object.fromEntries(Object.entries(runtime.clocks).map(([code, { revision, ...clocks }]) => [code, clocks]));
    const previousIndexBytes = Buffer.byteLength(JSON.stringify({ ...legacyIndex, clocks: legacyClocks, matches: {} }));

    console.log(`  冷启动 flush:  ${cold.ms.toFixed(0)} ms · 事件循环最大停顿 ${cold.maxLag.toFixed(1)} ms · 分片写入 ${cold.shardWrites}`);
    console.log(`  稳态 flush ×2: ${warm.ms.toFixed(0)} / ${warm2.ms.toFixed(0)} ms · 最大停顿 ${warm.maxLag.toFixed(1)} / ${warm2.maxLag.toFixed(1)} ms · 分片写入 ${warm.shardWrites} / ${warm2.shardWrites}(脏检测生效≈0)`);
    console.log(`  稳态落盘: index ${warm.indexWrites}/${warm2.indexWrites} 次 · runtime ${warm.runtimeWrites}/${warm2.runtimeWrites} 次 · 写入 ${(warm.writtenBytes / 1024).toFixed(1)}/${(warm2.writtenBytes / 1024).toFixed(1)} KB`);
    console.log(`  同等数据旧 index: ${(previousIndexBytes / 1024).toFixed(1)} KB/轮 · 本次稳态写入字节减少 ${(100 * (1 - warm2.writtenBytes / previousIndexBytes)).toFixed(1)}%`);
    console.log(`  对照:旧路径同步编码 ${rooms} 房 ${syncMs.toFixed(0)} ms(单次,阻塞主线程;新路径同一工作在 Worker 线程)`);
    console.log(`  磁盘: ${files} 个文件,共 ${(bytes / 1024).toFixed(0)} KB(旧单文件布局每 tick 重写全部 ${(syncBytes / 1024).toFixed(0)} KB)`);

    // graceful restart: everything must come back
    await srv.close();
    srv = await startServer({ port: 0, quiet: true, log: quiet, stateFile: stateDir, MatchClass: TestMatch, workers: 0 });
    const restored = [...srv.lobby.rooms.values()].filter((r) => r.match).length;
    const restoredSessions = srv.registry.size;
    console.log(`  重启恢复: ${restoredSessions} 会话 / ${restored} 对局(期望 ${rooms}/${rooms})`);
    if (restored !== rooms || restoredSessions !== rooms) throw new Error('the scaled state did not fully restore');
    console.log('  ✓ 规模基准通过');
  } finally {
    await srv?.close().catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------

const only = [];
if (!SKIP_MULTI) only.push(phaseMultiUser());
if (!SKIP_SCALE) only.push(phaseScale(ROOMS === true ? 250 : ROOMS));
Promise.all(only).then(
  () => { console.log('\n全部通过。'); process.exit(0); },
  (e) => { console.error('\n失败:', e); process.exit(1); },
);
