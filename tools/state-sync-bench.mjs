// tools/state-sync-bench.mjs — one repeatable, fixed-scale measurement of the server-side state-sync chain.
//
// WHAT IT MEASURES (production code paths only, nothing re-implemented):
//   real four-seat rooms, real WebSocket sockets, real PREP matches at --round, and then, per public tick / player
//   action:  Match.flush()  (server/match/match/messaging.js)  →  Match.publicView() / PlayerState.privateView()
//   →  the dedup JSON.stringify  →  net.js send / broadcast  →  stateTransport.prepareStateFrame (per-socket diff
//   against that socket's own baseline, encode)  →  the outbound queue  →  a real WebSocket frame.
//   On the persistence side: Persister checkpoint capture (server/match/snapshot.js captureMatch)  →  the persistence
//   Worker encode  →  store.saveSharded shard / index / runtime writes (server/stateFile.js).
//   Setup (INFO_CHECK → BAND_DRAFT → PREP) runs on the match's own VirtualScheduler exactly like tools/persist-sim.mjs
//   phase A; the measurement window then runs on a real clock, which is mandatory — MatchMessaging._maybeSendPublic
//   throttles on sched.now() and re-arms through sched.setTimeout, so a frozen virtual clock would stop the public
//   state after the first frame.
//
// WHAT IT DOES NOT MEASURE (each one makes the load weaker than production):
//   * one host, loopback only: no TLS, no proxy, no CDN, no cross-network latency or loss;
//   * no browser: the client fleet decodes with the production shared/stateDelta.js StateReceiver and validates, but
//     never renders and never simulates a battle;
//   * no simulation pool (workers: 0), no AI seats (all four seats are human) and no bot rehearsal;
//   * battles are test/match/fakeBattle.js and none runs inside the window (the window is a single PREP);
//   * the action cadence is a synthetic seeded schedule, not real players, and the public tick is one timer for all
//     rooms (clock-only progress ticks, as COMBAT / BATTLE_CHECK produce them);
//   * every room shares one seed, so the rooms are content-identical by construction;
//   * the persisted document is captured in PREP, so it never covers a battle-interrupted round.
//
// Usage:
//   node tools/state-sync-bench.mjs --rooms 4 --sockets 16 --seconds 12 --round 3 --save-ms 2000 --out .cache/x.json
// Options: --rooms --sockets(=rooms*4) --seconds --round --public-hz --action-hz --seed --save-ms --label --out --profile
// Exit code 1 when any verification counter is non-zero (or a room left PREP during the window).
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance, monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, PHASE } from '../shared/constants.js';
import { StateReceiver } from '../shared/stateDelta.js';
import { distribution } from './lib/bench.mjs';

const args = process.argv.slice(2);
const arg = (key, fallback) => { const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1]; };
const has = (key) => args.includes('--' + key);
const serverProcess = has('server');
const int = (key, fallback, min, max) => {
  const raw = arg(key, fallback);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`invalid --${key} ${raw}`);
  return n;
};
const rooms = int('rooms', 4, 1, 64);
const sockets = int('sockets', rooms * 4, 4, 256);
const seconds = int('seconds', 12, 4, 600);
const round = int('round', 5, 1, 20);
const publicHz = int('public-hz', 4, 1, 50);
const actionHz = int('action-hz', 2, 1, 20);
const seed = int('seed', 7, 1, 2 ** 31 - 1);
const saveMsRaw = arg('save-ms', null);
const saveMs = saveMsRaw == null ? null : Number(saveMsRaw);
if (sockets !== rooms * 4) throw new Error('invalid benchmark options: --sockets must be --rooms * 4');
if (saveMs != null && (!Number.isInteger(saveMs) || saveMs < 1000)) throw new Error('invalid --save-ms (>= 1000)');
const outPath = arg('out', null);
const label = arg('label', `state-sync-${rooms}r-${sockets}s-${seconds}s-r${round}`);
const profile = has('profile');
const GC_KINDS = { 1: 'minor', 2: 'major', 4: 'incremental', 8: 'weakcb' };
// The deploy field every seat may place on (server/match/board.js FIELD), scanned in a fixed order: the bench cannot
// know a tile's class (that is PlayerState's deploy map) and every client would ask its own deploy wheel instead.
const TILES = [];
for (let r = 9; r <= 12; r++) for (let c = 2; c <= 10; c++) TILES.push([r, c]);
/** The engine's tile key (server/match/board.js tileKey), spelled locally so both processes can use it. */
const tileKeyOf = (r, c) => `${r},${c}`;
/** Actions the engine always turns into a new private view: an accepted one must reach the wire before its `ok`. */
const STATE_CHANGING = new Set(['g.buy', 'g.sell', 'g.freeze', 'g.move']);
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
/** Deterministic per-client PRNG (mulberry32): the action schedule must not depend on the host's timing. */
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

if (serverProcess) await runServer(); else await runParent();

// ---------------------------------------------------------------------------------------------------
// child: the real server, its real matches, the real persister
// ---------------------------------------------------------------------------------------------------
async function runServer() {
  const { startServer } = await import('../server/index.js');
  const { Match } = await import('../server/match/Match.js');
  const { PlayerState } = await import('../server/match/PlayerState.js');
  const { VirtualScheduler, SuspendableScheduler, RealScheduler } = await import('../server/match/scheduler.js');
  const { FakeBattle } = await import('../test/match/fakeBattle.js');
  const { wireStatsSnapshot } = await import('../server/net.js');
  const { FIELD } = await import('../server/match/board.js');

  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  process.on('uncaughtException', (e) => { console.error('[child] uncaught:', (e && (e.stack || e.message)) || e); process.exit(1); });
  process.on('unhandledRejection', (e) => { console.error('[child] unhandled rejection:', (e && (e.stack || e.message)) || e); });

  // The match recipe of tools/persist-sim.mjs / tools/bench-cooperative.mjs: a virtual clock, test battles, no
  // rehearsal and the legacy server-run combat (no browser reports are needed to walk the rounds).
  FakeBattle.script = () => ({ duration: 2, leaks: {}, bossDps: 1e9 });
  class BenchMatch extends Match {
    constructor(opts) {
      super({ ...opts, scheduler: new VirtualScheduler({ instantCombat: true }), BattleClass: FakeBattle, botRehearsal: 0, clientCombat: false });
    }
  }

  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sp-state-sync-'));
  const srv = await startServer({
    host: '127.0.0.1', port: 0, quiet: true, log: quiet, workers: 0,
    MatchClass: BenchMatch, stateFile: stateDir,
    maxRooms: rooms, maxConnections: sockets + 8,
    // the bench measures the state chain, not the abuse buckets (production values would throttle the fleet itself)
    ratePerSec: 4000, rateBurst: 4000, heavyPerSec: 4000, heavyBurst: 4000, abuseDropsPerSec: 1e9,
    seedFn: () => seed,
    announcementSource: 'file', announcementFile: path.join(stateDir, 'announcement.json'),
    ...(saveMs != null ? { saveMs } : {}),
  });

  // --- bench-local segment counters. Nothing here lives in production source; the prototypes are patched in this
  // process only, after the method containers installed publicView / privateView onto them.
  const views = { publicCalls: 0, publicMs: 0, privateCalls: 0, privateMs: 0 };
  const viewSnap = () => ({ ...views });
  for (const [proto, name, calls, ms] of [[Match.prototype, 'publicView', 'publicCalls', 'publicMs'],
    [PlayerState.prototype, 'privateView', 'privateCalls', 'privateMs']]) {
    const original = proto[name];
    proto[name] = function patched(...rest) {
      const t = performance.now();
      try { return original.apply(this, rest); } finally { views[calls]++; views[ms] += performance.now() - t; }
    };
  }
  const persist = { flushes: 0, flushCalls: 0, flushMs: [], checkpointEncodes: 0, checkpointMs: 0,
    shardWrites: 0, indexWrites: 0, runtimeWrites: 0, writtenBytes: 0 };
  const persistSnap = () => ({ flushes: persist.flushes, flushCalls: persist.flushCalls, flushAt: persist.flushMs.length,
    checkpointEncodes: persist.checkpointEncodes, checkpointMs: persist.checkpointMs, shardWrites: persist.shardWrites,
    indexWrites: persist.indexWrites, runtimeWrites: persist.runtimeWrites, writtenBytes: persist.writtenBytes });
  if (srv.persister) {
    const flush = srv.persister.flush.bind(srv.persister);
    srv.persister.flush = async (reason) => {
      const t = performance.now();
      const ok = await flush(reason);
      persist.flushCalls++;
      persist.flushMs.push(performance.now() - t);
      if (ok) persist.flushes++;
      return ok;
    };
    const encodeRoom = srv.persister.encodeRoom.bind(srv.persister);
    srv.persister.encodeRoom = async (code, match) => {
      const t = performance.now();
      try { return await encodeRoom(code, match); } finally { persist.checkpointEncodes++; persist.checkpointMs += performance.now() - t; }
    };
  }
  if (srv.store) {
    const writeAtomic = srv.store.writeAtomic.bind(srv.store);
    srv.store.writeAtomic = async (file, content) => {
      const name = path.basename(String(file));
      if (name === 'index.json') persist.indexWrites++;
      else if (name === 'runtime.json') persist.runtimeWrites++;
      else if (String(file).includes(`${path.sep}matches${path.sep}`)) persist.shardWrites++;
      persist.writtenBytes += Buffer.byteLength(content);
      return writeAtomic(file, content);
    };
  }
  // Full / patch classification of the frames that actually reach a socket (the state transport keeps the logical
  // m.public / m.private type in wireStats, which cannot tell them apart). A delta frame carries `base` between its
  // seq and its patch, the full frame does not.
  const frames = { full: 0, patch: 0 };
  const WIRE_STATE = /^\{"t":"m\.state","kind":"m\.[a-z]+","seq":\d+,"(?:base":\d+,")?(full|patch)":/;
  srv.wss.on('connection', (ws) => {
    const send = ws.send.bind(ws);
    ws.send = (data, ...rest) => {
      if (collect && typeof data === 'string') {
        const m = WIRE_STATE.exec(data);
        if (m) frames[m[1]]++;
      }
      return send(data, ...rest);
    };
  });

  let collect = false, tickTimers = [], running = false;
  const drifted = new Set();
  const tickMs = [];
  let loop = null, gcObserver = null, gc = null, windowWallStart = 0, cpuStart = null, memBefore = null, wireBefore = null;
  let viewBefore = null, persistBefore = null, frameBefore = null, windowStartAt = 0;
  let endTimer = null, windowStats = null;
  const round3 = (n) => (Number.isFinite(n) ? +n.toFixed(3) : n);
  const stat = (fn) => { try { const v = fn(); return Number.isFinite(v) ? round3(v / 1e6) : null; } catch { return null; } };

  /**
   * Close the measurement window on the child's own clock and record everything it produced. Idempotent: the window
   * timer and a `finish` that arrives first both land here, and only the first one counts.
   */
  const stopWindow = () => {
    if (!running || windowStats) return;
    running = false;
    collect = false;
    if (endTimer) { clearTimeout(endTimer); endTimer = null; }
    for (const timer of tickTimers) clearTimeout(timer);
    tickTimers = [];
    const wallMs = performance.now() - windowWallStart;
    const threadEnd = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : null;
    const processCpu = process.cpuUsage(cpuStart.process);
    const memAfter = process.memoryUsage();
    const wireAfter = wireStatsSnapshot();
    const viewAfter = viewSnap();
    const persistAfter = persistSnap();
    const frameAfter = { ...frames };
    // Read the delay histogram before disabling it: an empty recorder cannot answer for its percentiles.
    const eventLoopDelayMs = { mean: stat(() => loop.mean), p50: stat(() => loop.percentile(50)),
      p99: stat(() => loop.percentile(99)), max: stat(() => loop.max) };
    loop?.disable();
    gcObserver?.disconnect();
    const threadMs = threadEnd && cpuStart.thread
      ? (threadEnd.user + threadEnd.system - cpuStart.thread.user - cpuStart.thread.system) / 1000 : 0;
    const processMs = (processCpu.user + processCpu.system) / 1000;
    const byType = {};
    for (const [kind, after] of Object.entries(wireAfter.byType)) {
      const before = wireBefore.byType[kind] || { frames: 0, bytes: 0 };
      byType[kind] = { frames: after.frames - before.frames, bytes: after.bytes - before.bytes };
    }
    const bytesOf = (kind) => (byType[kind] ? byType[kind].bytes : 0);
    const publicFrames = byType['m.public'] ? byType['m.public'].frames : 0;
    const privateFrames = byType['m.private'] ? byType['m.private'].frames : 0;
    windowStats = {
      wallMs: round3(wallMs),
      mainThreadCpuMs: round3(threadMs),
      mainThreadCpuSource: typeof process.threadCpuUsage === 'function' ? 'process.threadCpuUsage' : 'unavailable',
      processCpuMs: round3(processMs),
      averageCorePercent: round3(wallMs > 0 ? threadMs / wallMs * 100 : 0),
      processAverageCorePercent: round3(wallMs > 0 ? processMs / wallMs * 100 : 0),
      eventLoopDelayMs,
      gc: { collections: gc.collections, totalPauseMs: round3(gc.totalPauseMs), maxPauseMs: round3(gc.maxPauseMs), byKind: gc.byKind },
      heapUsedBeforeMiB: round3(memBefore.heapUsed / 1048576), heapUsedAfterMiB: round3(memAfter.heapUsed / 1048576), rssAfterMiB: round3(memAfter.rss / 1048576),
      viewBuilds: { publicCalls: viewAfter.publicCalls - viewBefore.publicCalls, publicMs: round3(viewAfter.publicMs - viewBefore.publicMs),
        privateCalls: viewAfter.privateCalls - viewBefore.privateCalls, privateMs: round3(viewAfter.privateMs - viewBefore.privateMs) },
      sent: { publicFrames, privateFrames, stateFrames: publicFrames + privateFrames,
        fullFrames: frameAfter.full - frameBefore.full, patchFrames: frameAfter.patch - frameBefore.patch,
        publicBytes: bytesOf('m.public'), privateBytes: bytesOf('m.private') },
      tickMs: { ...distribution(tickMs), ticks: tickMs.length },
      persist: { flushes: persist.flushes - persistBefore.flushes, flushCalls: persist.flushCalls - persistBefore.flushCalls,
        flushMs: { ...pick(distribution(persist.flushMs.slice(persistBefore.flushAt, persistAfter.flushAt)), ['p50', 'max']) },
        checkpointEncodes: persist.checkpointEncodes - persistBefore.checkpointEncodes,
        checkpointMs: round3(persist.checkpointMs - persistBefore.checkpointMs),
        shardWrites: persist.shardWrites - persistBefore.shardWrites,
        indexWrites: persist.indexWrites - persistBefore.indexWrites,
        runtimeWrites: persist.runtimeWrites - persistBefore.runtimeWrites,
        writtenBytes: persist.writtenBytes - persistBefore.writtenBytes },
      wireStats: { byType, frames: wireAfter.frames - wireBefore.frames, bytes: wireAfter.bytes - wireBefore.bytes },
    };
  };

  const matchOf = (room) => room.match && !room.match.disposed && !room.match.ended ? room.match : null;
  const pendingFrames = () => {
    let n = 0;
    const net = srv.network;
    for (const q of net._outbound.values()) n += q.size;
    for (const q of net._blockedOutbound.values()) n += q.size;
    for (const conn of net.conns.values()) if ((conn.ws?.bufferedAmount || 0) > 0) n++;
    return n;
  };
  /** One public tick for every room: the clock-only markPublic of a COMBAT / BATTLE_CHECK progress tick, through the
   *  guarded production entry point (Match.guard → flush → _maybeSendPublic), never by hand-building a view. */
  const tick = () => {
    if (!running) return;
    const t0 = performance.now();
    for (const room of srv.lobby.rooms.values()) {
      const m = matchOf(room);
      if (!m) continue;
      if (m.phase !== PHASE.PREP) drifted.add(room.code);
      try { m.guard(() => m.markPublic()); } catch (e) { m.reportError('benchTick', e); }
    }
    tickMs.push(performance.now() - t0);
  };

  const handler = async (msg) => {
    try {
      if (!msg || typeof msg !== 'object') return;
      if (msg.advance) {
        // Drive the virtual clock: PREP of round >= msg.advance.round (the predicate cannot be satisfied by an earlier
        // round's PREP, which is what makes a repeated advance safe).
        const out = [];
        for (const room of srv.lobby.rooms.values()) {
          const m = matchOf(room);
          if (!m) { out.push({ code: room.code, missing: true }); continue; }
          if (typeof m.sched.runUntil !== 'function') { out.push({ code: room.code, error: 'not a virtual clock' }); continue; }
          try {
            const want = msg.advance.round;
            const ok = m.sched.runUntil(() => m.ended || m.disposed || (m.phase === PHASE.PREP && m.round >= want), { maxSteps: 500_000 });
            out.push({ code: room.code, ok, phase: m.phase, round: m.round, errors: m.errorCount });
          } catch (e) {
            out.push({ code: room.code, error: String((e && e.message) || e).slice(0, 200) });
          }
        }
        process.send({ advanced: true, out });
        return;
      }
      if (msg.tiles) {
        // Deploy legality, read from the engine (PlayerState._legal — a bench-only read like botPrepBegin / m._timers):
        // the published m.private carries no deploy map, and a blind probe asks for tiles a stage may simply not have
        // (a ranged operator needs 高台), which is what left the boards empty on some stages.
        const out = {};
        for (const room of srv.lobby.rooms.values()) {
          const m = matchOf(room);
          if (!m) continue;
          const seats = {};
          for (const ps of m.order) {
            const tiles = {};
            for (const piece of ps.hand) {
              if (!piece || piece.kind !== 'chess' || piece.uid == null) continue;
              const loc = ps.find(piece.uid);
              if (!loc || loc.area !== 'hand') continue;
              const free = [];
              for (let r = FIELD.r0; r <= FIELD.r1 && free.length < 6; r++) {
                for (let c = FIELD.c0; c <= FIELD.c1 && free.length < 6; c++) {
                  if (ps.board.has(tileKeyOf(r, c))) continue;
                  try { if (ps._legal(loc.piece, r, c)) free.push([r, c]); } catch { /* an exotic piece: skip the tile */ }
                }
              }
              if (free.length) tiles[piece.uid] = free;
            }
            seats[ps.playerId] = tiles;
          }
          out[room.code] = seats;
        }
        process.send({ tiles: out });
        return;
      }
      if (msg.measure) {
        const report = [];
        for (const room of srv.lobby.rooms.values()) {
          const m = matchOf(room);
          if (!m) { report.push({ code: room.code, missing: true }); continue; }
          // Freeze the setup into the measurement shape: drop the virtual clock's pending work (the phase deadline
          // included), then install a real clock. Sound because none of the phase drivers reads m.deadline (only the
          // timer does, and it is cancelled) and setDeadline is neutralised before a future phase could arm one.
          m.cancel(m._phaseTimer);
          m._phaseTimer = null;
          m.cancel(m._turnTimer);
          m._turnTimer = null;
          for (const h of [...m._timers]) m.cancel(h);
          m._timers.clear();
          m._pubTimer = null; // stale handle of the discarded clock: the throttle is never consulted on the real one
          const old = m.sched;
          old.dispose();
          if (old.base && typeof old.base.dispose === 'function') old.base.dispose();
          m.sched = new SuspendableScheduler(new RealScheduler({ now: Date.now, onError: (e) => m.reportError('timer', e) }), { ownsBase: true });
          m.setDeadline = () => {};
          if (m.phase !== PHASE.PREP) drifted.add(room.code);
          report.push({ code: room.code, phase: m.phase, round: m.round, errors: m.errorCount,
            board: m.order.map((ps) => ({ playerId: ps.playerId, board: ps.board.size, hand: ps.hand.filter(Boolean).length, funds: ps.funds })) });
        }
        const rooms_ = [...srv.lobby.rooms.values()];
        if (rooms_.length !== rooms) throw new Error(`expected ${rooms} rooms, the lobby holds ${rooms_.length}`);
        const missing = report.filter((r) => r.missing || r.phase !== PHASE.PREP);
        if (missing.length) throw new Error(`rooms not frozen in PREP: ${JSON.stringify(missing)}`);
        windowStartAt = Date.now() + 250;
        const period = 1000 / publicHz;
        const count = Math.floor((seconds * 1000) / period);
        cpuStart = { thread: typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : null, process: process.cpuUsage() };
        memBefore = process.memoryUsage();
        wireBefore = wireStatsSnapshot();
        viewBefore = viewSnap();
        persistBefore = persistSnap();
        frameBefore = { ...frames };
        windowWallStart = performance.now();
        loop = monitorEventLoopDelay({ resolution: 10 });
        gc = { collections: 0, totalPauseMs: 0, maxPauseMs: 0, byKind: {} };
        gcObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const kind = typeof entry.detail?.kind === 'string' ? entry.detail.kind : GC_KINDS[entry.detail?.kind] || 'unknown';
            const bucket = (gc.byKind[kind] ||= { collections: 0, totalPauseMs: 0, maxPauseMs: 0 });
            const ms = entry.duration;
            gc.collections++;
            gc.totalPauseMs += ms;
            if (ms > gc.maxPauseMs) gc.maxPauseMs = ms;
            bucket.collections++;
            bucket.totalPauseMs += ms;
            if (ms > bucket.maxPauseMs) bucket.maxPauseMs = ms;
          }
        });
        gcObserver.observe({ entryTypes: ['gc'] });
        loop.enable();
        loop.reset();
        collect = true;
        running = true;
        for (let i = 0; i < count; i++) tickTimers.push(setTimeout(tick, Math.max(0, windowStartAt + i * period - Date.now())));
        // The window closes on the child's own clock, exactly --seconds after its start: the parent's message timing
        // (and its in-flight actions) must not stretch or shrink what is measured.
        endTimer = setTimeout(stopWindow, Math.max(0, windowStartAt + seconds * 1000 - Date.now()));
        process.send({ measured: true, startAt: windowStartAt, saveMs: srv.persister ? srv.persister.saveMs : null, rooms: report });
        return;
      }
      if (msg.finish) {
        stopWindow();
        // The final quiet flush: through the guarded production entry point, and with the public frame forced so the
        // dedup baseline and the last frame every client received are the same string by construction.
        for (const room of srv.lobby.rooms.values()) {
          const m = matchOf(room);
          if (!m) continue;
          if (m.phase !== PHASE.PREP) drifted.add(room.code);
          try {
            m.guard(() => {
              m.markPublic();
              for (const ps of m.order) if (!ps.isBot && !ps.left) m.markPrivate(ps);
              m.flush(true);
            });
          } catch (e) { m.reportError('benchFinishFlush', e); }
        }
        // Let the outbound queue and the sockets drain before the baselines are read: everything counted here must
        // have reached the wire, or a client's last state would be older than the baseline it is compared against.
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && (pendingFrames() > 0 || srv.network.bufferedBytes().total > 0)) await delay(20);
        const pending = pendingFrames();
        const baselines = [];
        let matchErrors = 0;
        for (const room of srv.lobby.rooms.values()) {
          const m = matchOf(room);
          if (!m) { baselines.push({ code: room.code, missing: true }); continue; }
          matchErrors += m.errorCount;
          baselines.push({
            code: room.code, phase: m.phase, round: m.round, errors: m.errorCount,
            publicJson: typeof m._lastPubJson === 'string' ? m._lastPubJson : null,
            players: m.order.map((ps) => {
              return { playerId: ps.playerId, isBot: !!ps.isBot, board: ps.board.size, hand: ps.hand.filter(Boolean).length,
                privateJson: typeof ps._lastPriv === 'string' ? ps._lastPriv : null };
            }),
          });
        }
        process.send({ finished: true,
          baselines, matchErrors, pendingFrames: pending,
          phaseDrift: drifted.size, driftCodes: [...drifted],
          window: windowStats });
        return;
      }
      if (msg.close) {
        stopWindow();
        if (srv.persister) await srv.persister.stop();
        await srv.close();
        await fsp.rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
        process.disconnect();
      }
    } catch (e) {
      process.send({ error: String((e && e.stack) || e) });
    }
  };
  process.on('message', (msg) => { void handler(msg); });
  process.send({ port: srv.port, stateDir });
}

function pick(dist, keys) {
  const out = {};
  for (const key of keys) out[key] = dist ? dist[key] : null;
  return out;
}

// ---------------------------------------------------------------------------------------------------
// parent: the client fleet, the setup drive, the verification
// ---------------------------------------------------------------------------------------------------
async function runParent() {
  // startServer() always initializes the nickname moderation, which needs a lexicon key. Like the rest of the suite
  // (package.json "test" preloads test/helpers/test-setup.js), install the test key when this deployment has none;
  // with a real SP_MODERATION_KEY / SP_MODERATION_KEY_FILE / .state/moderation.key the fixture leaves it alone.
  await import('../test/helpers/moderation-fixture.js');
  const profileDir = profile ? path.join('.cache', 'state-sync-profile') : null;
  if (profileDir) fs.mkdirSync(profileDir, { recursive: true });
  const child = fork(fileURLToPath(import.meta.url), [...args, '--server'], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: { ...process.env, UV_THREADPOOL_SIZE: '4' },
    ...(profileDir ? { execArgv: ['--cpu-prof', '--cpu-prof-dir', profileDir] } : {}),
  });
  const clients = [];
  let collect = false, running = false;
  let privateLeaks = 0, privateOwnershipViolations = 0, orderErrors = 0;
  let decodeResyncs = 0, decodeIncomplete = 0, unparseable = 0;
  let setupTilesTried = 0, setupPlaceFailures = 0, setupRejections = 0, readyFailures = 0;
  /** Pieces each seat tries to field per setup round (see prepSeat: the views it measures scale with the board). */
  const placeTarget = 3;
  let lastStateAt = Date.now();
  const actionErrors = {};
  const setupStarted = performance.now();
  const wait = (predicate, timeout = 180_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(new Error('child timeout')); }, timeout);
    const receive = (m) => {
      if (m && m.error) { clearTimeout(timer); child.off('message', receive); reject(new Error(m.error)); return; }
      if (predicate(m)) { clearTimeout(timer); child.off('message', receive); resolve(m); }
    };
    child.on('message', receive);
  });
  const command = (message, predicate) => { const result = wait(predicate); child.send(message); return result; };
  const stateOf = (code) => clients.filter((c) => c.code === code);

  try {
    const { port } = await wait((m) => m.port);
    const connect = async (index) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const rx = new StateReceiver();
      const pending = new Map();
      let rid = 0;
      const client = {
        index, ws, rx, pending, id: null, code: null, seat: null,
        lastPublic: null, lastPrivate: null,
        stateFrames: 0, fullFrames: 0, patchFrames: 0,
        sent: 0, ok: 0, rejected: 0, skipped: 0, cursor: 0, placed: null,
        rng: mulberry32((seed + index * 7919) >>> 0),
        actionOrder: null,
        request(msg) {
          return new Promise((resolve, reject) => {
            const id = ++rid;
            const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, 15_000);
            pending.set(id, { resolve, reject, timer, expectsState: STATE_CHANGING.has(msg.t), sawState: false });
            ws.send(JSON.stringify({ ...msg, rid: id }));
          });
        },
      };
      const order = ['refresh', 'toggle', 'buy', 'freeze', 'toggle', 'sell'];
      // seeded, deterministic per client
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(client.rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      client.actionOrder = order;
      clients.push(client);
      ws.on('error', () => {});
      ws.on('message', (data) => {
        let wire;
        try { wire = JSON.parse(data.toString()); } catch { unparseable++; return; }
        let msg = wire;
        if (wire.t === 'm.state') {
          lastStateAt = Date.now();
          if (collect) client.stateFrames++;
          for (const p of pending.values()) if (p.expectsState) p.sawState = true;
          const decoded = rx.receive(wire);
          if (decoded.resync) decodeResyncs++;
          else if (!decoded.message) decodeIncomplete++;
          if (!decoded.message) return;
          msg = decoded.message;
          if (collect) { if (wire.patch) client.patchFrames++; else client.fullFrames++; }
        }
        if (msg.t === 'welcome') client.id = msg.playerId;
        if (msg.t === 'room.state') { client.code = msg.code; client.seat = (msg.seats || []).findIndex((s) => s && s.playerId === client.id); }
        if (msg.t === 'm.public') client.lastPublic = msg;
        if (msg.t === 'm.private') {
          // Wire-level leak check: a full frame names its owner, and a patch may never replace one either.
          if (wire.t === 'm.state' && wire.full && wire.full.playerId !== client.id) privateLeaks++;
          if (wire.t === 'm.state' && Array.isArray(wire.patch)) {
            for (const op of wire.patch) if (Array.isArray(op[0]) && op[0].length === 1 && op[0][0] === 'playerId' && op.length === 2 && op[1] !== client.id) privateLeaks++;
          }
          if (msg.playerId !== client.id) privateOwnershipViolations++;
          client.lastPrivate = msg;
        }
        const p = pending.get(msg.rid);
        if (p) {
          pending.delete(msg.rid);
          clearTimeout(p.timer);
          if (msg.t === 'error') p.reject(Object.assign(new Error(msg.code), { code: msg.code }));
          else {
            if (p.expectsState && !p.sawState) orderErrors++;
            p.resolve(msg);
          }
        }
      });
      ws.on('close', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('closed')); } pending.clear(); });
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      await client.request({ t: 'hello', name: `sync-${index}`, version: PROTOCOL_VERSION, stateDelta: 1 });
      return client;
    };

    for (let i = 0; i < sockets; i += 32) {
      await Promise.all(Array.from({ length: Math.min(32, sockets - i) }, (_, j) => connect(i + j)));
    }
    const withState = async (predicate, what, timeout = 30_000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await delay(20);
      }
      throw new Error(`timeout waiting for ${what}`);
    };

    // --- lobby: real four-human rooms, then the match-level briefing
    for (let g = 0; g < rooms; g++) {
      const group = clients.slice(g * 4, g * 4 + 4);
      await group[0].request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
      await withState(() => group[0].code, `room ${g} to be created`);
      for (const c of group.slice(1)) await c.request({ t: 'room.join', code: group[0].code });
      await withState(() => stateOf(group[0].code).length === 4 && group.every((c) => c.seat >= 0), `room ${g} seats`);
      for (const c of group) await c.request({ t: 'room.ready', ready: true });
      await group[0].request({ t: 'room.start' });
    }
    await withState(() => clients.every((c) => c.lastPublic), 'the first m.public of every room');
    for (const c of clients) await c.request({ t: 'g.infoReady', setupRevision: c.lastPublic.setupRevision || 0 });
    const advance = (round_) => command({ advance: { round: round_ } }, (m) => m.advanced);

    const prepSeat = async (c, { ready, buys }) => {
      const priv = c.lastPrivate;
      if (!priv) throw new Error('no m.private to act from');
      if (priv.personalChoice) await c.request({ t: 'g.choice', idx: 0 }).catch((e) => { setupRejections++; countError(e, 'g.choice'); });
      await fillHand(c, buys);
      // Place a few pieces, not just one: m.public's boardCount and the players' bond columns scale with the board, so a
      // bench on empty boards would understate the views it measures. The tracked `c.placed` stays the last success —
      // the action mix toggles that one piece between the board and the hand.
      await refreshTiles();
      for (let i = 0; i < placeTarget; i++) if (!await placeBoard(c)) break;
      if (ready && !c.lastPrivate.ready) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await c.request({ t: 'g.ready', ready: true }); break; }
          catch (e) {
            setupRejections++;
            countError(e, 'g.ready');
            if (c.lastPrivate.personalChoice) await c.request({ t: 'g.choice', idx: 0 }).catch(() => {});
            if (e.code !== 'TEMP_NOT_EMPTY') break;
            await delay(20);
          }
        }
        // A seat that still cannot ready is not fatal: the co-op prep is timed, so the deadline readies it and the
        // clock keeps carrying the room forward. Recorded, never hidden.
        if (!c.lastPrivate.ready) readyFailures++;
      }
    };
    const countError = (e, action) => { const code = `${action || '?'}:${e.code || 'OTHER'}`; actionErrors[code] = (actionErrors[code] || 0) + 1; };

    // Place one hand chess through the real g.move. The tile comes from the engine's own deploy legality (`tiles` IPC,
    // refreshed after every purchase); the blind probe below stays as the fallback for a piece the map cannot name
    // (one gained by an effect after the refresh). Tiles outermost, pieces innermost: a seat whose hand is all ranged
    // (some stages have no 高台 in the field) burns one probe per piece instead of 36.
    async function refreshTiles() {
      const payload = (await command({ tiles: true }, (m) => m.tiles)).tiles || {};
      for (const c of clients) c.tiles = (payload[c.code] && payload[c.code][c.id]) || {};
    }

    async function placeBoard(c) {
      const priv = c.lastPrivate;
      const pieces = (priv.hand || []).filter((p) => p && p.kind === 'chess');
      c.used = c.used || new Set();
      for (const piece of pieces) {
        for (const [row, col] of (c.tiles && c.tiles[piece.uid]) || []) {
          if (c.used.has(tileKeyOf(row, col))) continue;
          setupTilesTried++;
          try {
            await c.request({ t: 'g.move', uid: piece.uid, to: { area: 'board', row, col } });
            c.placed = { uid: piece.uid, row, col };
            c.used.add(tileKeyOf(row, col));
            return true;
          } catch (e) { setupRejections++; countError(e, 'g.move'); }
        }
      }
      const offset = ((c.seat >= 0 ? c.seat : 0) * 5) % TILES.length;
      for (let k = 0; k < TILES.length; k++) {
        const [row, col] = TILES[(offset + k) % TILES.length];
        if (c.used.has(tileKeyOf(row, col))) continue;
        for (const piece of pieces) {
          setupTilesTried++;
          try {
            await c.request({ t: 'g.move', uid: piece.uid, to: { area: 'board', row, col } });
            c.placed = { uid: piece.uid, row, col };
            c.used.add(tileKeyOf(row, col));
            return true;
          } catch (e) { setupRejections++; countError(e, 'g.move'); }
        }
      }
      setupPlaceFailures++;
      return false;
    }
    /** Buy up to `max` affordable chess pieces, so a seat always has something to field and a hand worth syncing. */
    async function fillHand(c, max) {
      let bought = 0;
      while (bought < max) {
        const priv = c.lastPrivate;
        const hand = (priv && priv.hand) || [];
        if (!hand.includes(null)) break;
        const slots = (priv.shop && priv.shop.slots) || [];
        const i = slots.findIndex((s) => s && s.kind === 'chess' && !s.sold && s.price <= priv.funds);
        if (i < 0) break;
        try { await c.request({ t: 'g.buy', slot: i }); bought++; }
        catch (e) { setupRejections++; countError(e, 'g.buy'); break; }
      }
      return bought;
    }
    /** A seat that could not field a piece keeps buying: the placement needs one melee operator at least. */
    async function ensureBoard(c) {
      for (let i = 0; i < 6 && !c.placed; i++) {
        if (!await fillHand(c, 2)) break;
        if (await placeBoard(c)) return true;
      }
      return !!c.placed;
    }

    // --- drive the rounds: every seat buys and deploys, then all four ready for the next round
    for (let r = 1; r <= round; r++) {
      const advanced = await advance(r);
      const bad = advanced.out.filter((o) => o.error || o.missing);
      if (bad.length) throw new Error(`advance to round ${r} failed: ${JSON.stringify(bad)}`);
      await withState(() => clients.every((c) => c.lastPrivate && c.lastPublic.round >= r), `round ${r} PREP state`);
      await delay(50);
      const doReady = r < round;
      for (let g = 0; g < rooms; g++) for (const c of clients.slice(g * 4, g * 4 + 4)) await prepSeat(c, { ready: doReady, buys: r === 1 ? 6 : 3 });
      if (!doReady) {
        // The window wants a populated board on every seat; give the ones that fell short a bounded retry.
        for (const c of clients) if (!c.placed) await ensureBoard(c);
        break;
      }
      // No wait for the ready flags here: a seat that could not ready is readied by the co-op prep deadline, which
      // the next advance runs; the round-scoped predicate below can never be satisfied by this round's PREP.
      await delay(50);
    }
    const setupMs = performance.now() - setupStarted;

    // --- freeze + measure. Collecting starts at the freeze (the counters below describe the window only).
    const measured = await command({ measure: true }, (m) => m.measured);
    collect = true;
    const startAt = measured.startAt;
    const until = startAt + seconds * 1000;
    const period = 1000 / actionHz;

    const planAction = (c) => {
      const priv = c.lastPrivate;
      if (!priv) return null;
      const build = {
        refresh: () => (priv.shop && (priv.shop.freeRefreshes > 0 || priv.funds >= priv.shop.refreshPrice)) ? { t: 'g.refresh' } : null,
        freeze: () => (priv.shop ? { t: 'g.freeze' } : null),
        buy: () => {
          const slots = (priv.shop && priv.shop.slots) || [];
          if (!(priv.hand || []).includes(null)) return null;
          const i = slots.findIndex((s) => s && s.kind === 'chess' && !s.sold && s.price <= priv.funds);
          return i < 0 ? null : { t: 'g.buy', slot: i };
        },
        sell: () => {
          const piece = (priv.hand || []).find((p) => p && p.kind === 'chess' && (!c.placed || p.uid !== c.placed.uid) && !(p.items || []).length);
          return piece ? { t: 'g.sell', uid: piece.uid } : null;
        },
        // the board ↔ hand toggle: the only synthetic action that changes the PUBLIC view every time (boardCount)
        toggle: () => {
          if (!c.placed) return null;
          const onBoard = (priv.board || []).some((p) => p && p.uid === c.placed.uid);
          if (onBoard) {
            const idx = (priv.hand || []).indexOf(null);
            return idx < 0 ? null : { t: 'g.move', uid: c.placed.uid, to: { area: 'hand', idx } };
          }
          if (priv.deployCount >= priv.deployCap) return null;
          return { t: 'g.move', uid: c.placed.uid, to: { area: 'board', row: c.placed.row, col: c.placed.col } };
        },
      };
      for (let k = 0; k < c.actionOrder.length; k++) {
        const kind = c.actionOrder[(c.cursor + k) % c.actionOrder.length];
        const action = build[kind] && build[kind]();
        if (action) { c.cursor = (c.cursor + k + 1) % c.actionOrder.length; return action; }
      }
      return null;
    };
    const actLoop = async (c) => {
      await staggerUntil(startAt + (c.index / sockets) * period);
      while (running) {
        try {
          const action = planAction(c);
          if (!action) c.skipped++;
          else {
            c.sent++;
            try { await c.request(action); c.ok++; }
            catch (e) {
              c.rejected++;
              countError(e, action.t);
              // The engine withdrew or blocked the recorded tile (a terrain change / a full board): re-probe it like a
              // client's deploy wheel would, instead of hammering a tile that no longer accepts the piece.
              if (action.t === 'g.move' && e.code === 'BAD_TILE' && c.placed) {
                const keep = c.placed;
                c.placed = null;
                if (!await placeBoard(c)) c.placed = keep;
              }
            }
          }
        } catch { /* a dead socket ends the loop below */ }
        if (!running) break;
        await staggerUntil(Date.now() + period);
      }
    };
    /** Sleep until an instant, but give up promptly once the window closes (the child keeps ticking until then). */
    const staggerUntil = async (at) => {
      while (running && Date.now() < at) await delay(Math.min(25, at - Date.now()));
    };
    const remaining = Math.max(0, startAt - Date.now());
    await delay(remaining);
    running = true;
    const loops = clients.map((c) => actLoop(c).catch(() => {}));
    await delay(Math.max(0, until - Date.now()));
    running = false;
    await Promise.allSettled(loops);

    // --- finish: the child stops its ticks, does the final quiet flush, drains and reports its dedup baselines.
    // The parent stops counting here: the final flush's frames belong to neither side's window (their content is what
    // the baselines are compared against, so they must arrive, but they are not part of the measurement).
    collect = false;
    const result = await command({ finish: true }, (m) => m.finished);
    const stateSent = result.window.sent.stateFrames;
    const receivedAt = () => clients.reduce((n, c) => n + c.stateFrames, 0);
    const drainDeadline = Date.now() + 10_000;
    while (Date.now() < drainDeadline) {
      if (receivedAt() >= stateSent && Date.now() - lastStateAt > 250) break;
      await delay(25);
    }

    // --- verification
    const baselineByCode = new Map(result.baselines.map((b) => [b.code, b]));
    let baselineMismatches = 0, publicDigestMismatches = 0;
    const roomsSeen = new Map();
    const actions = { sent: 0, ok: 0, rejected: 0, skipped: 0 };
    for (const c of clients) {
      actions.sent += c.sent;
      actions.ok += c.ok;
      actions.rejected += c.rejected;
      actions.skipped += c.skipped;
      const baseline = baselineByCode.get(c.code);
      if (!baseline || baseline.missing) { baselineMismatches += 2; continue; }
      const seat = baseline.players.find((p) => p.playerId === c.id);
      const gotPublic = c.lastPublic ? { ...c.lastPublic } : null;
      if (gotPublic) delete gotPublic.serverNow;
      const wantPublic = baseline.publicJson == null ? null : JSON.parse(baseline.publicJson);
      if (!gotPublic || !wantPublic || JSON.stringify(canonical(gotPublic)) !== JSON.stringify(canonical(wantPublic))) baselineMismatches++;
      const wantPrivate = seat && seat.privateJson != null ? JSON.parse(seat.privateJson) : null;
      if (!c.lastPrivate || !wantPrivate || JSON.stringify(canonical(c.lastPrivate)) !== JSON.stringify(canonical(wantPrivate))) baselineMismatches++;
      if (gotPublic) {
        const list = roomsSeen.get(c.code) || [];
        list.push(digest(gotPublic));
        roomsSeen.set(c.code, list);
      }
    }
    for (const list of roomsSeen.values()) if (list.length !== 4 || new Set(list).size !== 1) publicDigestMismatches++;
    // The load model requires a populated board on every seat when the window opens (checked on the freeze report).
    const emptyBoards = measured.rooms.reduce((n, room) => n + (room.board || []).filter((seat) => seat.board < 1).length, 0);
    const verification = {
      privateOwnershipViolations, privateLeaks, baselineMismatches, publicDigestMismatches,
      decodeFailures: decodeResyncs + decodeIncomplete + unparseable, orderErrors,
      phaseDrift: result.phaseDrift, matchErrors: result.matchErrors, pendingFrames: result.pendingFrames,
      emptyBoards,
    };
    const failed = Object.entries(verification).filter(([, v]) => v !== 0);
    const report = {
      label, node: process.version, platform: `${process.platform}-${process.arch}`,
      scale: { rooms, sockets, seconds, publicHz, actionHz, round, saveMs: measured.saveMs },
      setupMs: +setupMs.toFixed(1),
      passed: failed.length === 0,
      window: { ...result.window, actions },
      verification,
      accounting: {
        stateFramesSent: result.window.sent.stateFrames,
        stateFramesReceived: receivedAt(),
        fullPatchSplit: result.window.sent.fullFrames + result.window.sent.patchFrames === result.window.sent.stateFrames,
        decodeResyncs, decodeIncomplete, unparseable,
        driftedRooms: result.driftCodes,
      },
      setup: { tilesTried: setupTilesTried, placeFailures: setupPlaceFailures, rejections: setupRejections, readyFailures, actionErrors,
        // The load shape the window opened with (the board count each seat was required to have), plus where the
        // toggle left each board at the end (a seat that ends on an empty board simply withdrew its last piece).
        boards: measured.rooms.filter((room) => !room.missing).map((room) => ({ code: room.code, round: room.round,
          seats: (room.board || []).map((seat) => ({ board: seat.board, hand: seat.hand, funds: seat.funds })) })),
        finalBoards: result.baselines.filter((b) => !b.missing).map((b) => ({ code: b.code, round: b.round, seats: b.players.map((p) => p.board) })) },
    };
    if (failed.length) process.exitCode = 1;
    const json = JSON.stringify(report, null, 2);
    if (outPath) {
      fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
      fs.writeFileSync(outPath, json + '\n');
    }
    console.log(json);
    printSummary(report, failed);
    if (profileDir) {
      const profiles = fs.readdirSync(profileDir).filter((f) => f.endsWith('.cpuprofile'));
      if (profiles.length) console.log(`cpuprofile: ${path.join(profileDir, profiles[profiles.length - 1])}`);
    }
  } finally {
    running = false;
    for (const c of clients) c.ws.terminate();
    if (child.connected) child.send({ close: true });
    const timer = setTimeout(() => child.kill(), 20_000);
    await new Promise((resolve) => { child.once('exit', resolve); if (child.exitCode !== null) resolve(); });
    clearTimeout(timer);
  }
}

function printSummary(report, failed) {
  const w = report.window;
  const pct = (v) => (v == null ? 'n/a' : v.toFixed(2));
  console.log('');
  console.log(`状态同步链路基准 · ${report.label}`);
  console.log(`  规模: ${report.scale.rooms} 个四人房间 / ${report.scale.sockets} 个真实连接 / ${report.scale.seconds} 秒`
    + ` / 公共 ${report.scale.publicHz} Hz / 每客户端操作 ${report.scale.actionHz} Hz / 第 ${report.scale.round} 回合 PREP / 存档间隔 ${report.scale.saveMs} ms`);
  console.log(`  准备: ${report.setupMs} ms(虚拟时钟推进,真实 WebSocket 建连与操作)`);
  console.log(`  窗口: ${w.wallMs} ms 墙钟 · 主线程 CPU ${w.mainThreadCpuMs} ms(${pct(w.averageCorePercent)}% 单核)· 进程 CPU ${w.processCpuMs} ms`);
  console.log(`  事件循环延迟: 均值 ${pct(w.eventLoopDelayMs.mean)} ms · P50 ${pct(w.eventLoopDelayMs.p50)} · P99 ${pct(w.eventLoopDelayMs.p99)} · 最大 ${pct(w.eventLoopDelayMs.max)} ms`);
  console.log(`  GC: ${w.gc.collections} 次 · 总停顿 ${w.gc.totalPauseMs} ms · 最长 ${w.gc.maxPauseMs} ms;堆 ${w.heapUsedBeforeMiB} → ${w.heapUsedAfterMiB} MiB,RSS ${w.rssAfterMiB} MiB`);
  console.log(`  视图构建: 公共 ${w.viewBuilds.publicCalls} 次 / ${w.viewBuilds.publicMs} ms · 私人 ${w.viewBuilds.privateCalls} 次 / ${w.viewBuilds.privateMs} ms`);
  console.log(`  发送: 公共 ${w.sent.publicFrames} 帧 · 私人 ${w.sent.privateFrames} 帧 · 全量 ${w.sent.fullFrames} 帧 · 增量 ${w.sent.patchFrames} 帧`);
  console.log(`  每 tick 链路耗时: P50 ${w.tickMs.p50} ms · P95 ${w.tickMs.p95} ms · 最大 ${w.tickMs.max} ms(${w.tickMs.ticks} 个 tick)`);
  console.log(`  持久化: ${w.persist.flushes} 次 flush(${w.persist.flushCalls} 次调用,${w.persist.flushMs.p50}/${w.persist.flushMs.max} ms)· `
    + `检查点编码 ${w.persist.checkpointEncodes} 次 / ${w.persist.checkpointMs} ms · 分片 ${w.persist.shardWrites} · 索引 ${w.persist.indexWrites} · runtime ${w.persist.runtimeWrites} · ${w.persist.writtenBytes} 字节`);
  console.log(`  操作: 发送 ${w.actions.sent} · 成功 ${w.actions.ok} · 拒绝 ${w.actions.rejected} · 跳过 ${w.actions.skipped}`);
  console.log(`  核账: 发送 ${report.accounting.stateFramesSent} 状态帧 / 收到 ${report.accounting.stateFramesReceived} · 全量+增量拆分一致 ${report.accounting.fullPatchSplit}`);
  console.log(`  校验: 私人越权 ${report.verification.privateOwnershipViolations} · 私人泄漏 ${report.verification.privateLeaks} · 基线不符 ${report.verification.baselineMismatches}`
    + ` · 公共摘要不符 ${report.verification.publicDigestMismatches} · 解码失败 ${report.verification.decodeFailures} · 顺序错误 ${report.verification.orderErrors}`
    + ` · 相位漂移 ${report.verification.phaseDrift} · 引擎错误 ${report.verification.matchErrors} · 残留帧 ${report.verification.pendingFrames} · 空棋盘 ${report.verification.emptyBoards}`);
  if (w.actions.sent && w.actions.rejected / w.actions.sent > 0.25) {
    console.log(`  注意: 拒绝率 ${(100 * w.actions.rejected / w.actions.sent).toFixed(1)}%,操作节奏比生产更激进/更呆板,不要把帧数当成真人行为。`);
  }
  if (report.setup.placeFailures) {
    console.log(`  注意: ${report.setup.placeFailures} 次部署探针没有找到合法地块(远程干员需要高台,部分关卡部署区没有);${report.setup.tilesTried} 次尝试。`);
  }
  if (process.platform === 'win32') {
    console.log('  注意: Windows 定时器粒度约 15.6 ms,monitorEventLoopDelay({resolution:10}) 的均值/中位数含这一底噪,看 P99/最大值与波动。');
  }
  if (!w.persist.flushes || !w.persist.checkpointEncodes) {
    console.log('  注意: 本次窗口没有完整走完一次存档;默认存档间隔 10 秒时请延长 --seconds,或用 --save-ms 缩短。');
  }
  console.log(`  ${failed.length ? `失败: ${failed.map(([k, v]) => `${k}=${v}`).join(', ')}` : '全部校验通过。'}`);
  console.log(`  未覆盖: 单机回环、无 TLS/代理/CDN、无渲染、无模拟池、无 AI,Battle 用测试替身,窗口内是单个 PREP,操作节奏为合成调度。`);
}
