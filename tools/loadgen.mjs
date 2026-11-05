#!/usr/bin/env node
// tools/loadgen.mjs — end-to-end load test of the real server (node server/index.js + ws): N seeded ws clients play
// M rooms (the host starts the match) and storm the 整备期 (PREP) with g.* intents, while the tool samples the
// server's /healthz?traffic=1 (RSS, state-delta and WebSocket counters, room counts) and its `[loop]` stdout lines
// (SP_LOOP_SAMPLE=1). Everything an optimization A/B needs: msg/s in and out, error replies by code, RSS, the
// server main thread's event-loop p50/p95/p99, and the state-delta full/delta split.
//
// Usage:
//   node tools/loadgen.mjs [--clients 12] [--rooms 4] [--rate 20] [--duration 60] [--warmup 10]
//                          [--mode auto] [--difficulty NORMAL] [--seed 1]
//                          [--port P] [--workers 4] [--sample-ms 1000] [--loop-window-ms 5000]
//                          [--json F] [--quiet] [--verbose]
//   --clients N      ws clients to connect (default 12)
//   --rooms M        rooms the clients spread over, round-robin; the first client of a room is its host and starts
//                    the match (default 4; 12/4 = 3 clients per room, the empty 4th seat is an AI bot like a real
//                    room)
//   --rate R         g.* intents per second per client while the match phase is PREP (default 20). The server's
//                    per-socket token bucket is 40 msg/s including the draft answers — keep R ≤ 30, or ERR.RATE
//                    error replies and eventually a 1008 close become part of the measurement
//   --duration S     measurement window in seconds after --warmup (default 60)
//   --warmup S       seconds between "all matches started" and the start of sampling (default 10; the opening
//                    phases — INFO_CHECK ack, strategy-draft pick, 机变 pick, BATTLE_CHECK — usually land inside
//                    it; keep warmup ≥ loop-window so the counted [loop] windows are measured ones)
//   --mode m         room mode: coop | solo | auto (default auto — a one-client room plays solo, the others coop)
//   --difficulty d   room difficulty: FUNNY | NORMAL | HARD | ABYSS (default NORMAL)
//   --rehearsal-answer-ms D  seed clients answer a b.rehearsal task D ms after the frame (default 0 = never answer,
//                    the pre-observation behaviour: the delegated rehearsal times out and the server's pool takes it).
//                    This is the measurement base for every rehearsal-window A/B: the room host answers with its seeded
//                    pick of the candidates it was sent, like the page's Worker does, and drops a task it was told to
//                    cancel (b.rehearsalCancel) without answering. Implies --rehearsal-bot
//   --rehearsal-bot  the host adds one AI seat per coop room before the start (room.addBot): without a bot seat a room
//                    has nothing to delegate, so every rehearsal measurement needs one. Summary keys `clients.rehearsal`
//                    (frames, spec bytes, cancels, answers, per-PREP→COMBAT rotation) and `server.rehearsal` (the
//                    healthz `rehearsal` counters' delta over the window) are the A/B's columns
//   --seed S         seed of every client's LCG: same seed + same load ⇒ the same action sequence (default 1).
//                    The server's own match seeds stay random (lobby seedFn), so bot decisions differ a little
//                    per run — expect order-of-magnitude stability, not identical bytes
//   --port P         port of the child server (default: a free port; pin it to rule the port out as a variance
//                    source — a pinned port needs the previous run's server gone)
//   --workers N      SP_WORKERS of the child server (default 4, the server default; 0 = simulation pool off)
//   --sample-ms MS   /healthz?traffic=1 poll interval during the measurement (default 1000)
//   --loop-window-ms MS  SP_LOOP_WINDOW_MS of the child server (default 5000: one [loop] p50/p95/p99 window)
//   --json F         write the summary JSON to F ('-' = stdout)
//   --quiet          progress lines off (the JSON still goes where --json says)
//   --verbose        echo the child server's stdout lines
//
// Reproducing a run (small variance) — same machine, back to back, nothing else running:
//   node tools/loadgen.mjs --clients 12 --rooms 4 --rate 20 --duration 60 --warmup 10 --seed 1 --port 3999 --json out.json
// Fixed: the client actions (seeded LCG, rotation buy → sell → move → refresh → ready), the load shape (N/M/R),
// the warmup (the same opening phases before sampling starts) and the port. Left to the server: its random match
// seeds (bot preps and battles are the dominant noise on loop p95 and RSS), GC timing, the OS. Battles delegated to
// a client are never reported (b.start is counted, no b.result is ever sent) — the server's deadline takes every
// field over and runs it itself.
//
// Measured over [warmup end, warmup end + duration]:
//   per client: frames/bytes received and sent, sends per message type, error replies by code, b.start count;
//   server: RSS / ELU / loop p95 (healthz performance cache), stateDelta frames full-vs-delta, the WebSocket traffic
//   counters, room/match/human counts, healthz fetch latency; stdout: every [loop] window in the measurement window.
// The g.ready of the rotation always sends `ready: false` (a legal no-op): the seat never readies, so the prep runs
// to its deadline and the storm keeps hitting the validation + broadcast path instead of leaving PREP.

import { spawn } from 'node:child_process';
import net from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, MATCHMAKING_VERSION, GEO } from '../shared/constants.js';
import { PLAYER_CAPACITY_VERSION } from '../shared/playerCapacity.js';
import { STATE_DELTA_VERSION, StateReceiver } from '../shared/stateDelta.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- args ------------------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  opt[k] = v;
}
const num = (v, d) => (v != null && v !== true && Number.isFinite(Number(v)) ? Number(v) : d);
const O = {
  clients: Math.max(1, Math.floor(num(opt.clients, 12))),
  rooms: Math.max(1, Math.floor(num(opt.rooms, 4))),
  rate: num(opt.rate, 20),
  duration: num(opt.duration, 60),
  warmup: num(opt.warmup, 10),
  mode: ['coop', 'solo', 'auto'].includes(opt.mode) ? opt.mode : 'auto',
  difficulty: ['FUNNY', 'NORMAL', 'HARD', 'ABYSS'].includes(opt.difficulty) ? opt.difficulty : 'NORMAL',
  seed: Math.floor(num(opt.seed, 1)),
  port: opt.port != null && opt.port !== true ? Math.floor(num(opt.port, 0)) : 0,
  workers: Math.max(0, Math.floor(num(opt.workers, 4))),
  sampleMs: Math.max(200, Math.floor(num(opt['sample-ms'], 1000))),
  loopWindowMs: Math.max(100, Math.floor(num(opt['loop-window-ms'], 5000))),
  rehearsalAnswerMs: Math.max(0, Math.floor(num(opt['rehearsal-answer-ms'], 0))),
  rehearsalBot: opt['rehearsal-bot'] === true || (opt['rehearsal-answer-ms'] != null && opt['rehearsal-answer-ms'] !== true),
  json: opt.json === true ? null : opt.json,
  quiet: opt.quiet === true,
  verbose: opt.verbose === true,
};
if (O.rate >= 38) console.warn(`[loadgen] warning: --rate ${O.rate} exceeds the server's 40 msg/s token bucket (draft answers included); expect ERR.RATE drops and 1008 closes`);
const note = (msg) => { if (!O.quiet) console.log(msg); };

/** Seeded 32-bit LCG (tools code): the client actions' whole determinism. */
function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return {
    next() { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 2 ** 32; },
    int(n) { return Math.min(n - 1, Math.floor(this.next() * n)); },
    pick(list) { return list[this.int(list.length)]; },
  };
}

// ---- child server ----------------------------------------------------------------------------------------------
// Env the child must NOT inherit: dev-shell exports that would skew or break the run (an external bot strategy, an
// access gate, a Redis/Valkey state store, shrunk caps, test mode, another loop-sample config, another port).
const CHILD_ENV_DENY = ['PORT', 'HOST', 'SP_WORKERS', 'SP_LOOP_SAMPLE', 'SP_LOOP_WINDOW_MS', 'SP_STATE_FILE',
  'SP_BOT_REHEARSAL', 'SP_BOT_REHEARSAL_ANSWER_MS', 'SP_BOT_REHEARSAL_COLD_ANSWER_MS',
  'SP_BOT_STRATEGY', 'SP_BOT_STRATEGY_SEATS', 'SP_GATE_PASSWORD', 'SP_GATE_SECRET',
  'SP_REDIS_URL', 'REDIS_URL', 'SP_VALKEY_URL', 'SP_PERSIST_BACKEND', 'SP_MATCH_HOST', 'SP_TEST_MODE',
  'SP_MAX_ROOMS', 'SP_MAX_ROOMS_PER_ADDR', 'SP_MAX_MATCHES_PER_ADDR', 'SP_MAX_CONNECTIONS',
  'SP_MAX_CONNECTIONS_PER_ADDR', 'SP_MAX_ONLINE', 'SP_VERSIONS', 'SP_VERSION_DEFAULT', 'SP_ROOM_CREATE_BURST',
  'SP_ROOM_CREATE_REFILL_MS', 'SP_MATCH_START_BURST', 'SP_MATCH_START_REFILL_MS'];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** Start `node server/index.js` as a child and wait for /healthz (60 s budget). */
async function startServerChild(port) {
  const env = { ...process.env };
  for (const k of CHILD_ENV_DENY) delete env[k];
  Object.assign(env, {
    PORT: String(port), HOST: '127.0.0.1',
    SP_LOOP_SAMPLE: '1', SP_LOOP_WINDOW_MS: String(O.loopWindowMs),
    SP_WORKERS: String(O.workers),
    SP_STATE_FILE: 'off', // memory-only persistence: no checkpoint writes in the measurement window
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  const capture = (buf) => {
    for (const line of String(buf).split('\n')) {
      if (!line.trim()) continue;
      lines.push({ t: Date.now(), text: line });
      if (lines.length > 8000) lines.splice(0, lines.length - 8000);
      if (O.verbose) console.log(`[server] ${line}`);
    }
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode != null) throw new Error(`server exited (${child.exitCode}) during boot:\n${lines.slice(-40).map((l) => l.text).join('\n')}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > 60000) throw new Error(`server did not become healthy in 60 s:\n${lines.slice(-40).map((l) => l.text).join('\n')}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return { child, lines, bootMs: Date.now() - t0 };
}

/** SIGTERM the child (its own graceful shutdown), SIGKILL after 5 s. */
function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode != null) { resolve(); return; }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    try { child.kill('SIGTERM'); } catch { clearTimeout(t); resolve(); }
  });
}

/** The strategy ids (data/bands.json) a coop or solo draft may pick, or [] (the deadline then picks for the seat). */
function bandsFor(mode) {
  let raw = null;
  try { raw = JSON.parse(readFileSync(path.join(ROOT, 'data', 'bands.json'), 'utf8')); } catch { return []; }
  const want = mode === 'solo' ? 'SINGLE' : 'MULTI';
  return Object.keys(raw).filter((id) => {
    const b = raw[id];
    return b && (!Array.isArray(b.modeTypeList) || b.modeTypeList.includes(want));
  }).sort();
}

// ---- one client -------------------------------------------------------------------------------------------------
const STORM = ['g.buy', 'g.sell', 'g.move', 'g.refresh', 'g.ready'];
const REPLY_TYPES = new Set(['ok', 'error', 'welcome', 'pong']);
/** Rows/cols a g.move may target: the own deployable region (shared/constants.js GEO.FIELD). */
const MOVE_ROW_N = GEO.FIELD.r1 - GEO.FIELD.r0 + 1;
const MOVE_COL_N = GEO.FIELD.c1 - GEO.FIELD.c0 + 1;

class LoadClient {
  /** @param {number} idx @param {number} port @param {string} band @param {number} rate */
  constructor(idx, port, band, rate) {
    this.idx = idx;
    this.name = `load-${idx}`;
    this.url = `ws://127.0.0.1:${port}/ws`;
    this.band = band;
    this.rate = rate;
    this.rng = lcg(O.seed * 7919 + idx);
    this.ws = null;
    this.playerId = null;
    this.token = null;
    this.roomCode = null;
    this.inMatch = false;
    this.failed = null;
    this.closed = null; // { code, reason }
    this.pending = new Map(); // rid → { resolve, timer }
    this.receiver = new StateReceiver(); // the m.public delta transport, exactly like a browser
    this.nextRid = 1;
    // live view of the match
    this.phase = null;
    this.round = 0;
    this.private = null;
    this.chessUids = [];
    this.anyUids = [];
    // opening answers, each once per match
    this.infoReadySent = false;
    this.bandSent = false;
    this.spPickRound = 0;
    // delegated rehearsal answers (--rehearsal-answer-ms D, 0 = the historical silent host): taskId → the pending
    // reply timer, dropped again on b.rehearsalCancel like the page drops its task
    this.rehearsalAnswerMs = O.rehearsalAnswerMs;
    this.rehearsalTimers = new Map();
    /** wall-clock ms of each PREP phase this client saw until the room reached COMBAT (the A/B's room-rotation metric) */
    this.prepToCombat = [];
    this.prepStartedAt = null;
    // counters (snapshotted at the measurement window's start)
    this.recv = { n: 0, bytes: 0, rehearsalBytes: 0 };
    this.recvByType = {};
    this.sent = { n: 0, bytes: 0 };
    this.sentByType = {};
    this.errorsByCode = {};
    this.bStart = 0;
    this.stormSent = 0;
    this.stormSkipped = 0;
    this.rotation = 0;
    this.stormTimer = null;
    this.gone = false;
  }

  connect(timeout = 10000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const timer = setTimeout(() => { ws.terminate(); reject(new Error(`connect timeout ${this.url}`)); }, timeout);
      ws.once('open', () => { clearTimeout(timer); this.ws = ws; this.bind(); resolve(this); });
      ws.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }

  bind() {
    this.ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      this.recv.n++;
      this.recv.bytes += buf.length;
      let msg;
      try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
      this.onFrame(msg, buf.length);
    });
    this.ws.on('close', (code, reason) => { this.gone = true; this.closed = { code, reason: reason.toString() }; });
    this.ws.on('error', () => { /* surfaces as close */ });
  }

  onFrame(msg, bytes = 0) {
    if (REPLY_TYPES.has(msg.t) && msg.rid != null && this.pending.has(msg.rid)) {
      const p = this.pending.get(msg.rid);
      this.pending.delete(msg.rid);
      clearTimeout(p.timer);
      p.resolve(msg);
      return;
    }
    switch (msg.t) {
      case 'm.state': {
        this.recvByType.m_state = (this.recvByType.m_state || 0) + 1;
        const { message, resync } = this.receiver.receive(msg);
        if (resync) this.send({ t: 'state.resync' });
        if (message) this.onPublic(message);
        return;
      }
      case 'm.public':
        this.recvByType['m.public'] = (this.recvByType['m.public'] || 0) + 1;
        this.onPublic(msg);
        return;
      case 'm.private':
        this.recvByType['m.private'] = (this.recvByType['m.private'] || 0) + 1;
        this.onPrivate(msg);
        return;
      case 'room.state':
        this.recvByType['room.state'] = (this.recvByType['room.state'] || 0) + 1;
        if (msg.code) this.roomCode = msg.code;
        if (msg.inMatch) this.inMatch = true;
        return;
      case 'b.start':
        this.recvByType['b.start'] = (this.recvByType['b.start'] || 0) + 1;
        this.bStart++;
        return;
      case 'b.rehearsal':
        this.recvByType['b.rehearsal'] = (this.recvByType['b.rehearsal'] || 0) + 1;
        this.recv.rehearsalBytes += bytes;
        this.answerRehearsal(msg);
        return;
      case 'b.rehearsalCancel':
        this.recvByType['b.rehearsalCancel'] = (this.recvByType['b.rehearsalCancel'] || 0) + 1;
        // the server released the task (timeout / host change / prep end): the page stops the Worker, we stop the reply
        clearTimeout(this.rehearsalTimers.get(msg.taskId));
        this.rehearsalTimers.delete(msg.taskId);
        return;
      case 'error': {
        this.recvByType.error = (this.recvByType.error || 0) + 1;
        const code = msg.code || '?';
        this.errorsByCode[code] = (this.errorsByCode[code] || 0) + 1;
        return;
      }
      default:
        this.recvByType[msg.t] = (this.recvByType[msg.t] || 0) + 1;
        return;
    }
  }

  /**
   * One delegated rehearsal task the room host (this client) may answer: after --rehearsal-answer-ms, send the seeded
   * pick of the candidates it was sent — the shape the page's Worker answers, only late. The server takes the pick as
   * it is; a task the server already released is dropped above and never answered.
   * @param {{ taskId: string, specs?: any[] }} msg
   */
  answerRehearsal(msg) {
    if (this.rehearsalAnswerMs <= 0 || this.gone) return;
    if (this.rehearsalTimers.has(msg.taskId)) return; // a resend of the same task: the first answer stands
    const specs = Array.isArray(msg.specs) ? msg.specs.length : 0;
    if (specs < 1) return;
    const choice = this.rng.int(specs);
    const timer = setTimeout(() => {
      this.rehearsalTimers.delete(msg.taskId);
      if (!this.gone) this.send({ t: 'b.rehearsalResult', taskId: msg.taskId, choice });
    }, this.rehearsalAnswerMs);
    this.rehearsalTimers.set(msg.taskId, timer);
  }

  /** The public view (plain or delta-reconstructed): the phase and the two drafts' own turns. */
  onPublic(v) {
    if (v.phase && v.phase !== this.phase) {
      // the room-rotation metric: wall-clock ms from a PREP's start until the room reaches COMBAT
      if (v.phase === 'PREP') this.prepStartedAt = Date.now();
      else if (v.phase === 'COMBAT' && this.prepStartedAt != null) {
        this.prepToCombat.push(Date.now() - this.prepStartedAt);
        this.prepStartedAt = null;
      }
      this.phase = v.phase;
    }
    if (Number.isInteger(v.round)) this.round = v.round;
    // 机变 draft: pick the first available card on our turn (a refused pick lets the turn deadline advance)
    const sp = v.sp;
    if (sp && sp.turn === this.playerId && this.spPickRound !== this.round) {
      const taken = sp.taken || {};
      const card = (sp.cards || []).find((c) => c && taken[c.idx] == null && !c.soldOut);
      if (card) {
        this.spPickRound = this.round;
        this.send({ t: 'g.choice', idx: card.idx });
      }
    }
    // strategy draft: pick our band on our turn (duplicates are allowed by default)
    const draft = v.draft;
    if (this.phase === 'BAND_DRAFT' && draft && draft.turn === this.playerId && !this.bandSent && this.band) {
      this.bandSent = true;
      this.send({ t: 'g.band', bandId: this.band });
    }
    // briefing: confirm at once (the phase advances when every human is infoReady)
    if (this.phase === 'INFO_CHECK' && !this.infoReadySent) {
      this.infoReadySent = true;
      this.send({ t: 'g.infoReady' });
    }
  }

  /** The player's own private view: the uids the storm targets (chess for sell, any piece for move). */
  onPrivate(msg) {
    this.private = msg;
    const chess = [];
    const any = [];
    const add = (x) => { if (x && Number.isInteger(x.uid)) { any.push(x.uid); if (x.kind === 'chess') chess.push(x.uid); } };
    for (const x of msg.hand || []) add(x);
    for (const x of msg.temp || []) add(x);
    for (const x of msg.board || []) add(x);
    this.chessUids = chess;
    this.anyUids = any;
  }

  /** Send one message with a fresh rid; counts the bytes. @returns {number} the rid used */
  send(msg) {
    if (this.gone || !this.ws || this.ws.readyState !== WebSocket.OPEN) return -1;
    const rid = this.nextRid++;
    const text = JSON.stringify({ ...msg, rid });
    this.sent.n++;
    this.sent.bytes += Buffer.byteLength(text);
    this.sentByType[msg.t] = (this.sentByType[msg.t] || 0) + 1;
    this.ws.send(text);
    return rid;
  }

  /** Send and await the direct reply (ok / error / welcome with that rid). */
  request(msg, timeout = 8000) {
    const rid = this.send(msg);
    if (rid < 0) return Promise.resolve({ t: 'error', code: 'CLOSED' });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error(`${this.name}: timeout waiting for the reply of ${msg.t}`));
      }, timeout);
      this.pending.set(rid, { resolve, timer });
    });
  }

  hello() {
    return this.request({
      t: 'hello', name: this.name, version: PROTOCOL_VERSION, delta: STATE_DELTA_VERSION,
      matchmakingVersion: MATCHMAKING_VERSION, playerCapacityVersion: PLAYER_CAPACITY_VERSION,
    }).then((reply) => {
      if (reply.t !== 'welcome') throw new Error(`${this.name}: hello failed: ${JSON.stringify(reply).slice(0, 200)}`);
      this.playerId = reply.playerId;
      this.token = reply.token;
      return reply;
    });
  }

  /**
   * One storm tick: the rotation's next intent, only while the phase is PREP. Every send counts — a refused intent
   * (no funds, bad target) is exactly the validation path being measured.
   */
  stormTick() {
    if (this.gone) return;
    if (this.phase !== 'PREP') { this.stormSkipped++; return; }
    const kind = STORM[this.rotation++ % STORM.length];
    let msg = null;
    if (kind === 'g.buy') {
      // the shop slots this client's own view offers: three quarters of the buys target an unsold affordable slot
      // (they succeed and pay the real broadcast path), the rest hit a random slot of the shop's length
      const shop = this.private?.shop?.slots || [];
      const funds = this.private?.funds ?? 0;
      const affordable = [];
      for (let i = 0; i < shop.length && i < 16; i++) {
        const s = shop[i];
        if (s && !s.sold && Number.isFinite(s.price) && s.price <= funds) affordable.push(i);
      }
      const slot = affordable.length && this.rng.next() < 0.75 ? this.rng.pick(affordable) : this.rng.int(Math.max(1, Math.min(16, shop.length)));
      msg = { t: kind, slot };
    } else if (kind === 'g.refresh') msg = { t: kind };
    else if (kind === 'g.ready') msg = { t: kind, ready: false };
    else if (kind === 'g.sell') msg = { t: kind, uid: this.chessUids.length ? this.rng.pick(this.chessUids) : 1 };
    else if (kind === 'g.move') {
      msg = {
        t: kind, uid: this.anyUids.length ? this.rng.pick(this.anyUids) : 1,
        to: { area: 'board', row: GEO.FIELD.r0 + this.rng.int(MOVE_ROW_N), col: GEO.FIELD.c0 + this.rng.int(MOVE_COL_N) },
        dir: 'RIGHT',
      };
    }
    if (msg) { this.send(msg); this.stormSent++; }
  }

  startStorm() {
    if (this.stormTimer || this.rate <= 0) return;
    this.stormTimer = setInterval(() => this.stormTick(), Math.max(26, 1000 / this.rate));
  }

  stopStorm() {
    if (this.stormTimer) { clearInterval(this.stormTimer); this.stormTimer = null; }
  }

  close() {
    this.stopStorm();
    for (const t of this.rehearsalTimers.values()) clearTimeout(t);
    this.rehearsalTimers.clear();
    if (!this.ws || this.gone) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, 1000);
      this.ws.once('close', () => { clearTimeout(t); resolve(); });
      try { this.ws.close(); } catch { clearTimeout(t); resolve(); }
    });
  }
}

// ---- orchestration & measurement helpers ------------------------------------------------------------------------
async function until(fn, what, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const asReply = (p) => p.catch((e) => ({ t: 'error', code: String(e.message || e) }));

/**
 * One room: the host creates it, the joiners join, everyone readies, the host starts. Resolves with the room code
 * once every member's room.state said inMatch.
 * @param {LoadClient[]} members @param {string} mode
 */
async function setupRoom(members, mode) {
  const [host, ...joiners] = members;
  host.request({ t: 'room.create', mode, difficulty: O.difficulty })
    .then((r) => { if (r.t === 'error') host.failed = `room.create: ${r.code}`; })
    .catch((e) => { host.failed = String(e.message || e); });
  const code = await until(() => host.roomCode, `host ${host.name} did not receive a room.state`, 15000);
  for (const c of joiners) {
    const r = await asReply(c.request({ t: 'room.join', code }));
    if (r.t === 'error') throw new Error(`${c.name}: room.join ${code} → ${r.code}`);
  }
  // the rehearsal measurement needs an AI teammate: a delegated rehearsal is one bot prep's offer, and a room's bots
  // are seats the HOST adds (room.addBot) — empty seats never fill themselves. Implied by --rehearsal-answer-ms.
  if (O.rehearsalBot && mode === 'coop') {
    const r = await asReply(host.request({ t: 'room.addBot' }));
    if (r.t === 'error') throw new Error(`host ${host.name}: room.addBot → ${r.code}`);
  }
  for (const c of members) {
    const r = await asReply(c.request({ t: 'room.ready', ready: true }));
    if (r.t === 'error') throw new Error(`${c.name}: room.ready → ${r.code}`);
  }
  const r = await asReply(host.request({ t: 'room.start' }));
  if (r.t === 'error') throw new Error(`room.start → ${r.code}`);
  await until(() => members.every((c) => c.inMatch || c.failed), 'the match to start for every member', 30000);
  const failed = members.filter((c) => c.failed);
  if (failed.length) throw new Error(`members failed: ${failed.map((c) => `${c.name}: ${c.failed}`).join('; ')}`);
  return code;
}

/** Per-client counters (a deep-enough copy to snapshot). */
const snapOf = (c) => ({ recvN: c.recv.n, recvBytes: c.recv.bytes, recvRehearsalBytes: c.recv.rehearsalBytes, recvByType: { ...c.recvByType },
  sentN: c.sent.n, sentBytes: c.sent.bytes, sentByType: { ...c.sentByType },
  stormSent: c.stormSent, bStart: c.bStart, errors: { ...c.errorsByCode } });
const diffCounters = (a, b) => ({
  recvN: b.recvN - a.recvN, recvBytes: b.recvBytes - a.recvBytes,
  recvRehearsalBytes: b.recvRehearsalBytes - a.recvRehearsalBytes,
  recvByType: Object.fromEntries(Object.keys(b.recvByType).map((k) => [k, b.recvByType[k] - (a.recvByType[k] || 0)])),
  sentN: b.sentN - a.sentN, sentBytes: b.sentBytes - a.sentBytes,
  sentByType: Object.fromEntries(Object.keys(b.sentByType).map((k) => [k, b.sentByType[k] - (a.sentByType[k] || 0)])),
  stormSent: b.stormSent - a.stormSent, bStart: b.bStart - a.bStart,
  errors: Object.fromEntries(Object.keys(b.errors).map((k) => [k, b.errors[k] - (a.errors[k] || 0)])),
});

async function healthz(port) {
  const t0 = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz?traffic=1`, { signal: AbortSignal.timeout(3000) });
    const body = await res.json();
    return { ok: res.ok, ms: Date.now() - t0, body };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e.message || e) };
  }
}

/** Aggregate the `[loop]` stdout lines captured between `from` and `to` (the sampler's own p50/p95/p99 per window). */
function loopStats(lines, from, to) {
  const re = /\[loop\] p50=([\d.]+)ms p95=([\d.]+)ms p99=([\d.]+)ms max=([\d.]+)ms samples=(\d+) cpu=(\d+)% mem=(\d+)MB rooms=(\d+) matches=(\d+) humans=(\d+)/;
  const windows = [];
  for (const l of lines) {
    if (l.t < from || l.t > to) continue;
    const m = re.exec(l.text);
    if (m) windows.push({ p50: Number(m[1]), p95: Number(m[2]), p99: Number(m[3]), max: Number(m[4]),
      samples: Number(m[5]), cpu: Number(m[6]), mem: Number(m[7]), rooms: Number(m[8]), matches: Number(m[9]),
      humans: Number(m[10]), at: l.t });
  }
  const agg = (f) => {
    const vs = windows.map(f).filter((x) => Number.isFinite(x));
    if (!vs.length) return null;
    return { mean: Math.round((vs.reduce((a, b) => a + b, 0) / vs.length) * 10) / 10, max: Math.max(...vs) };
  };
  return { windows, p50: agg((w) => w.p50), p95: agg((w) => w.p95), p99: agg((w) => w.p99),
    max: agg((w) => w.max), cpu: agg((w) => w.cpu), mem: agg((w) => w.mem) };
}

const mb = (bytes) => (bytes == null ? null : bytes / (1024 * 1024));
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : x);
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);

// ---- main -------------------------------------------------------------------------------------------------------
await main();

async function main() {
  const summary = { meta: {}, boot: {}, clients: {}, server: {}, loop: null, problems: [] };
  let server = null;
  const clients = [];
  try {
    const port = O.port > 0 ? O.port : await freePort();
    server = await startServerChild(port);
    const startedAt = Date.now();
    summary.meta = { ...O, port, startedAt: new Date(startedAt).toISOString(), node: process.version, serverPid: server.child.pid };
    summary.boot = { ms: server.bootMs };
    note(`server up on 127.0.0.1:${port} (boot ${server.bootMs} ms)`);

    // rooms: sizes as even as possible (12 / 4 → 3 per room); a one-client room plays solo
    const sizes = Array.from({ length: O.rooms }, (_, i) => Math.floor(O.clients / O.rooms) + (i < O.clients % O.rooms ? 1 : 0)).filter((n) => n > 0);
    let next = 0;
    const rooms = [];
    for (let r = 0; r < sizes.length; r++) {
      const members = [];
      for (let i = 0; i < sizes[r]; i++) members.push(new LoadClient(next++, port, '', O.rate));
      const mode = O.mode === 'auto' ? (members.length > 1 ? 'coop' : 'solo') : O.mode;
      rooms.push({ members, mode });
      clients.push(...members);
    }
    const bands = {};
    for (const room of rooms) {
      if (!(room.mode in bands)) bands[room.mode] = bandsFor(room.mode);
      const list = bands[room.mode];
      room.members.forEach((c, i) => { if (list.length) c.band = list[i % list.length]; });
    }
    note(`connecting ${clients.length} clients into ${rooms.length} room(s): ${sizes.join(', ')} (${rooms.map((r) => r.mode).join(', ')})`);
    const connectResults = await Promise.allSettled(clients.map((c) => c.connect()));
    for (let i = 0; i < connectResults.length; i++) {
      if (connectResults[i].status === 'rejected') {
        clients[i].failed = `connect: ${connectResults[i].reason?.message}`;
        summary.problems.push(clients[i].failed);
      }
    }
    const alive = clients.filter((c) => !c.failed);
    await Promise.allSettled(alive.map((c) => c.hello().catch((e) => { c.failed = String(e.message || e); })));
    const said = alive.filter((c) => !c.failed);
    if (!said.length) throw new Error('no client survived hello');
    note(`${said.length}/${clients.length} clients said hello`);

    for (const room of rooms) {
      const members = room.members.filter((c) => !c.failed);
      if (!members.length) continue;
      try {
        const code = await setupRoom(members, room.mode);
        note(`room ${code} (${room.mode}×${members.length}) started`);
      } catch (e) {
        summary.problems.push(`room setup failed: ${e.message}`);
        for (const c of members) if (!c.failed) c.failed = 'room setup failed';
      }
    }
    const started = clients.filter((c) => c.inMatch);
    if (!started.length) throw new Error('no room reached its match');
    summary.phases = { matchesStarted: started.length, clientsInMatch: started.length, setupMs: Date.now() - startedAt };

    // warmup: the opening phases run out; the storm is already armed (it only fires in PREP)
    await new Promise((r) => setTimeout(r, O.warmup * 1000));
    for (const c of started) c.startStorm();
    for (const c of started) c.prepToCombat = []; // the room-rotation metric is the measurement window's own
    const measureStart = Date.now();
    const measureEnd = measureStart + O.duration * 1000;
    const snaps = new Map(started.map((c) => [c, snapOf(c)]));
    const hz0 = await healthz(port);
    note(`measuring ${O.duration} s (warmup ${O.warmup} s done; healthz ${hz0.ms} ms)…`);

    // the sampler: /healthz?traffic=1 every sample-ms
    const samples = [];
    const sampler = setInterval(() => {
      healthz(port).then((hz) => {
        if (!hz.ok || !hz.body) { samples.push({ t: Date.now(), error: hz.error || 'unhealthy' }); return; }
        const b = hz.body;
        samples.push({
          t: Date.now(), ms: hz.ms,
          rss: b.performance?.process?.rssBytes ?? null,
          elu: b.performance?.mainThread?.eventLoopUtilization ?? null,
          loopP95: b.performance?.mainThread?.eventLoopDelayMs?.p95 ?? null,
          rooms: b.rooms ?? null, matches: b.matches ?? null, humans: b.humans ?? null, sockets: b.sockets ?? null,
          stateDelta: b.stateDelta ? { ...b.stateDelta } : null,
          ws: b.traffic?.ws ? { ...b.traffic.ws } : null,
        });
      });
    }, O.sampleMs);

    while (Date.now() < measureEnd) await new Promise((r) => setTimeout(r, Math.min(500, measureEnd - Date.now())));
    clearInterval(sampler);
    for (const c of started) c.stopStorm();
    const hz1 = await healthz(port);
    const measureMs = Date.now() - measureStart;

    // client aggregates over the window
    const deltas = started.map((c) => ({ idx: c.idx, name: c.name, ...diffCounters(snaps.get(c), snapOf(c)) }));
    const sum = (f) => deltas.reduce((a, d) => a + f(d), 0);
    const closedMidRun = started.filter((c) => c.gone);
    if (closedMidRun.length) summary.problems.push(`${closedMidRun.length} sockets closed mid-run: ${closedMidRun.map((c) => `${c.name}:${c.closed?.code}`).join(', ')}`);
    const errs = {};
    for (const d of deltas) for (const [k, v] of Object.entries(d.errors)) if (v > 0) errs[k] = (errs[k] || 0) + v;
    const sentByType = {};
    const recvByType = {};
    for (const d of deltas) {
      for (const [k, v] of Object.entries(d.sentByType)) sentByType[k] = (sentByType[k] || 0) + v;
      for (const [k, v] of Object.entries(d.recvByType)) recvByType[k] = (recvByType[k] || 0) + v;
    }
    summary.clients = {
      measured: started.length,
      durationS: Math.round(measureMs / 100) / 10,
      inMsgs: sum((d) => d.recvN), inBytes: sum((d) => d.recvBytes), inMsgPerSec: r1(sum((d) => d.recvN) / (measureMs / 1000)),
      outMsgs: sum((d) => d.sentN), outBytes: sum((d) => d.sentBytes), outMsgPerSec: r1(sum((d) => d.sentN) / (measureMs / 1000)),
      inBytesPerSec: r1(sum((d) => d.recvBytes) / (measureMs / 1000)), outBytesPerSec: r1(sum((d) => d.sentBytes) / (measureMs / 1000)),
      stormIntents: sum((d) => d.stormSent),
      errorReplies: errs,
      bStart: sum((d) => d.bStart),
      rehearsal: {
        // the b.rehearsal spec frames the room hosts received, and every PREP→COMBAT rotation they saw
        framesRecv: (recvByType['b.rehearsal'] || 0),
        specBytes: sum((d) => d.recvRehearsalBytes),
        cancelsRecv: (recvByType['b.rehearsalCancel'] || 0),
        answersSent: (sentByType['b.rehearsalResult'] || 0),
        prepToCombat: (() => {
          const vs = started.flatMap((c) => c.prepToCombat).sort((a, b) => a - b);
          if (!vs.length) return null;
          return { n: vs.length, min: vs[0], p50: vs[Math.floor((vs.length - 1) / 2)],
            avg: Math.round(vs.reduce((a, b) => a + b, 0) / vs.length), max: vs[vs.length - 1] };
        })(),
      },
      sentByType,
      recvByType,
      perClient: deltas,
    };

    // server aggregates over the samples inside the window
    const inWindow = samples.filter((s) => s.t >= measureStart && s.t <= measureEnd + 500 && !s.error);
    const agg = (f, round) => {
      const vs = inWindow.map(f).filter((x) => Number.isFinite(x));
      if (!vs.length) return null;
      return { min: round(Math.min(...vs)), avg: round(vs.reduce((a, b) => a + b, 0) / vs.length), max: round(Math.max(...vs)) };
    };
    const sd0 = hz0.body?.stateDelta || null;
    const sd1 = hz1.body?.stateDelta || null;
    const rh0 = hz0.body?.rehearsal || null;
    const rh1 = hz1.body?.rehearsal || null;
    const ws0 = hz0.body?.traffic?.ws || null;
    const ws1 = hz1.body?.traffic?.ws || null;
    const deltaOf = (a, b, k) => (a && b && Number.isFinite(a[k]) && Number.isFinite(b[k]) ? b[k] - a[k] : null);
    summary.server = {
      healthzMs: agg((s) => s.ms, Math.round),
      rssMB: agg((s) => mb(s.rss), (x) => r1(x)),
      elu: agg((s) => s.elu, (x) => r3(x)),
      loopP95HealthzMs: agg((s) => s.loopP95, (x) => r1(x)),
      rooms: agg((s) => s.rooms, Math.round), matches: agg((s) => s.matches, Math.round), humans: agg((s) => s.humans, Math.round),
      sockets: agg((s) => s.sockets, Math.round),
      samples: inWindow.length,
      stateDelta: sd0 && sd1 ? {
        frames: deltaOf(sd0, sd1, 'frames'), fullFrames: deltaOf(sd0, sd1, 'fullFrames'), deltaFrames: deltaOf(sd0, sd1, 'deltaFrames'),
        parsedBaselines: deltaOf(sd0, sd1, 'parsedBaselines'),
      } : null,
      // the delegated-rehearsal counters (healthz `rehearsal`) over the window: what timed out into the pool and what
      // the pool could not take — the A/B pair of the host answer window (server/index.js, lobby.rehearsalStats)
      rehearsal: rh0 && rh1 ? {
        delegated: deltaOf(rh0, rh1, 'delegated'), answered: deltaOf(rh0, rh1, 'answered'),
        takeovers: deltaOf(rh0, rh1, 'takeovers'), pooled: deltaOf(rh0, rh1, 'pooled'),
        accepted: deltaOf(rh0, rh1, 'accepted'), fallbacks: deltaOf(rh0, rh1, 'fallbacks'),
      } : null,
      wsTraffic: ws0 && ws1 ? {
        wireOut: deltaOf(ws0, ws1, 'wireOut'), wireIn: deltaOf(ws0, ws1, 'wireIn'),
        payloadOut: deltaOf(ws0, ws1, 'payloadOut'), payloadIn: deltaOf(ws0, ws1, 'payloadIn'),
        messagesOut: deltaOf(ws0, ws1, 'messagesOut'), messagesIn: deltaOf(ws0, ws1, 'messagesIn'),
      } : null,
    };
    summary.loop = loopStats(server.lines, measureStart, measureEnd + 1000);

    note(`done: in ${summary.clients.inMsgPerSec} msg/s, out ${summary.clients.outMsgPerSec} msg/s, RSS avg ${summary.server.rssMB ? r1(summary.server.rssMB.avg) : '?'} MB, loop p95 max ${summary.loop.p95 ? summary.loop.p95.max : '?'} ms, error replies ${JSON.stringify(errs)}`);
  } catch (e) {
    summary.problems.push(`fatal: ${e.message}`);
    console.error(`[loadgen] FATAL: ${e.message}`);
  } finally {
    await Promise.allSettled(clients.map((c) => c.close()));
    if (server) {
      await stopServer(server.child);
      summary.server.exit = { code: server.child.exitCode, signal: server.child.signalCode };
    }
    if (summary.problems.length) note(`problems: ${summary.problems.join(' | ')}`);
    if (O.json === '-') console.log(JSON.stringify(summary));
    else if (typeof O.json === 'string') {
      writeFileSync(O.json, JSON.stringify(summary, null, 2));
      note(`JSON written to ${O.json}`);
    }
    process.exitCode = summary.problems.some((p) => p.startsWith('fatal')) ? 1 : 0;
  }
}
