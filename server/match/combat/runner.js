// Main-thread adapter for a server-streamed phase owned by one combat worker. Only views/results cross the boundary;
// Match still owns players, watchers, phase transitions and settlement. At most one command is in flight per phase.
import { TICK } from '../../sim/constants.js';
import { INTERVAL_MS, GAME_SPEED, HARD_CAP_SECONDS, snapFrame } from '../fields.js';
import { damageFrame, emptyDamageRows } from '../../sim/damageBoard.js';
import { RealScheduler } from '../scheduler.js';

// Bound each FIFO worker turn, not the active game-time debt. At 2x this covers a 533 ms service cycle.
export const MAX_WORKER_ADVANCE_TICKS = 32;
const TERMINAL_SNAPSHOT_RETRY_MS = 1000;
/** b.ext to one local display replica at most this often (ms; an end or the phase's last reply goes at once). */
export const EXT_MIN_GAP_MS = 100;
/** A boss field whose pool record has grown past this many entries is no longer offered locally (the b.start size). */
export const EXT_START_MAX = 16000;

/** Entries `from`… of a pool record kept flat ([tick, hp, tick, hp, …]: ~16 B an entry) as the wire's [[tick, hp]]. */
const extPairs = (flat, from) => {
  const out = [];
  for (let i = from * 2; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
};

/** Read-only view of the last accepted worker state, not a resumable simulation snapshot. */
export class RemoteBattle {
  constructor(spec) {
    this.fieldId = spec.fieldId;
    this.kind = spec.kind;
    this.time = 0;
    this.tickCount = 0;
    this.killed = 0;
    this.total = 0;
    this.resolved = null; // Unknown until a worker supplies its own scheduled-enemy counter.
    this.finished = false;
    this.errors = [];
    this.progress = null;
    this.left = null;
    this.layerGains = {};
    this._result = null;
    this._meta = null;
    this._snapshot = null;
    this._metaWire = null;
    this._snapshotWire = null;
    this._startUnitStats = null;
    this._damageRows = emptyDamageRows(spec);
    this._damageWire = null;
    this._damageGt = 0;
    this.round = spec.round;
    this.runner = null;
  }
  result() { return this._result; }
  damageRows() {
    if (!this._damageRows && this._damageWire) {
      const { owners } = JSON.parse(this._damageWire);
      this._damageRows = { owners };
    }
    return this._damageRows;
  }
  fieldMeta({ includeUnitStats = false } = {}) {
    const meta = this._meta || (this._metaWire ? JSON.parse(this._metaWire) : null);
    if (!meta || !includeUnitStats || !this._startUnitStats) return meta;
    const listed = new Set((meta.units || []).map(u => u.id));
    return { ...meta, unitStats: this._startUnitStats.filter(u => listed.has(u.id)) };
  }
  snapshot() {
    if (this._snapshot || !this._snapshotWire) return this._snapshot;
    const { t, gt, ...rest } = JSON.parse(this._snapshotWire);
    void t;
    return { ...rest, t: gt };
  }
  forceEnd(reason) { this.runner?.forceField(this.fieldId, reason); }
  update(view) {
    this.time = view.time;
    this.tickCount = view.tickCount;
    this.killed = view.killed;
    this.total = view.total;
    this.resolved = view.resolved ?? null;
    this.finished = !view.live;
    this.errors = view.errors || [];
    this.progress = view.progress;
    this.left = view.left;
    this.layerGains = view.layerGains || {};
    if (view.result) this._result = view.result;
  }
}

export class WorkerFieldRunner {
  constructor(m, fields, { onTick = null, onDone, boss = null }) {
    this.m = m;
    this.fields = fields;
    this.onTick = onTick;
    this.onDone = onDone;
    this.boss = boss;
    this.remote = true;
    this.ticks = 0;
    this.done = false;
    this.stopped = false;
    this.session = null;
    this.interval = null;
    this.unpace = null;
    this.inflight = false;
    this.ready = false;
    this.held = null;
    this.heldForceSnapshots = false;
    this.terminalSnapshots = new Map();
    this.acc = 0;
    this.last = 0;
    this.resync = new Map();
    this.damageResync = new Map();
    this.controls = new Map();
    /** playerId → { fieldId, n, to, at, end }: what that local display replica has of its boss field's pool record */
    this.extSent = new Map();
    for (const f of fields) f.battle.runner = this;
  }

  get time() { return this.ticks * TICK; }
  get active() { return !this.stopped && !this.done && !this.m.disposed && !this.m.ended && this.m.runner === this; }

  start() {
    this.last = this.m.sched.now();
    try {
      this.inflight = true;
      this.session = this.m.combatPool.create({ specs: this.fields.map((f) => f.spec), boss: this.boss,
        wireFrames: true, coalesceFrames: true, damageBoard: true, snapshotHz: this.m.snapshotHz, gameSpeed: this.m.gameSpeed,
        metaOnDemand: true, terminalOnce: true }, {
        onFailure: (e) => this._fail(e),
      });
      this.session.ready.then((out) => this._receive(out, true), (e) => this._fail(e));
      // Real-time phases share the pool's one pacing tick (same INTERVAL_MS cadence): every phase's command of a tick
      // reaches its Worker in one wire turn. Custom/test schedulers keep their own interval.
      if (this.m.sched instanceof RealScheduler && typeof this.m.combatPool.pace === 'function') {
        this.unpace = this.m.combatPool.pace(() => {
          if (!this.active) { this._release(); return; } // a disposed/replaced phase leaves the shared tick by itself
          this.m.guard(() => this._pump());
        });
      } else this.interval = this.m.sched.setInterval(() => this.m.guard(() => this._pump()), INTERVAL_MS);
    } catch (e) { this._fail(e); }
  }

  stop() {
    this.stopped = true;
    this._release();
    this.resync.clear();
    this.damageResync.clear();
    this.controls.clear();
    this.extSent.clear();
    this.held = null;
    this.heldForceSnapshots = false;
    this.terminalSnapshots.clear();
  }

  _release() {
    if (this.interval) { this.m.sched.clearInterval(this.interval); this.interval = null; }
    if (this.unpace) { const unpace = this.unpace; this.unpace = null; unpace(); }
    this.session?.close();
    this.session = null;
  }

  /** A pause holds a pre-pause in-flight reply without applying its frames, effects or settlement. */
  resume() {
    this.last = this.m.sched.now();
    // Intentional pause boundary: discard pre-pause unsent debt as before, never simulate paused wall time.
    this.acc = 0;
    if (this.held && this.active) {
      const out = this.held;
      const forceSnapshots = this.heldForceSnapshots;
      this.held = null;
      this.heldForceSnapshots = false;
      this._receive(out, false, forceSnapshots);
    }
  }

  _pump() {
    if (!this.active) return;
    const now = this.m.sched.now();
    const dt = Math.max(0, now - this.last);
    this.last = now;
    const speed = Number.isFinite(this.m.gameSpeed) && this.m.gameSpeed > 0 ? this.m.gameSpeed : GAME_SPEED;
    // Active time remains owed even while the parent/worker queue is delayed. The phase hard cap bounds this
    // scalar debt; the command budget below bounds work/frames and preserves fair FIFO turns, not elapsed time.
    if (this.ready && !this.m.paused && !this.held) this.acc = Math.min(this.acc + dt / 1000 * speed, Math.max(0, HARD_CAP_SECONDS - this.time));
    if (this.inflight || !this.ready || this.held) return;
    // Controls are bounded by the phase's fields; nobody can enqueue a backlog of step or snapshot commands.
    if (this.controls.size) {
      const [key, command] = this.controls.entries().next().value;
      this.controls.delete(key);
      this._request(command.op, command.payload);
      return;
    }
    if (this.m.paused) return;
    for (const pending of [this.resync, this.damageResync]) for (const [pid, fid] of pending) {
      const ps = this.m.players.get(pid) || this.m.spectators.get(pid);
      if (!ps?.connected || ps.left || this.m.watchers.get(pid) !== fid || this.m._localShows?.(pid, fid)) pending.delete(pid);
    }
    if (this.resync.size || this.damageResync.size) {
      this._request('state', { snapshotFields: [...new Set(this.resync.values())] });
      return;
    }
    const n = Math.min(Math.floor(this.acc / TICK + 1e-9), MAX_WORKER_ADVANCE_TICKS);
    this.acc = Math.max(0, this.acc - n * TICK);
    if (n > 0) {
      const snapshotFields = this.fields.filter((f) => this._watchers(f.fieldId).length).map((f) => f.fieldId);
      const syncFields = this.fields.filter((f) => f.live && this._localViewers(f.fieldId).length).map((f) => f.fieldId);
      this._request('advance', { ticks: n, snapshotFields, metaFields: this._metaFields(snapshotFields), syncFields });
    }
  }

  /**
   * Live fields whose snapshots must also carry field meta. A solo battle can pause, and a paused rejoin/watch is
   * answered from the cached meta/snapshot pair without a Worker turn, so its watched fields keep every pair complete.
   * Elsewhere only a pending rejoin needs one (state replies and finished fields always carry meta).
   */
  _metaFields(snapshotFields) {
    if (this.m.isSolo) return snapshotFields;
    return [...new Set(this.resync.values())];
  }

  _request(op, payload) {
    if (!this.active || this.inflight) return;
    this.inflight = true;
    try {
      this.session.request(op, payload).then((out) => this._receive(out, false, op === 'state'), (e) => this._fail(e));
    } catch (e) { this._fail(e); }
  }

  _receive(out, initial = false, forceSnapshots = false) {
    if (!this.active) return;
    this.inflight = false;
    if (initial) { this.ready = true; this.last = this.m.sched.now(); }
    if (this.m.paused) { this.held = out; this.heldForceSnapshots = forceSnapshots; return; }
    this.m.guard(() => {
      try {
        this._apply(out, forceSnapshots);
        // One reply can admit at most one new bounded command. No timer/microtask spin when there is no debt;
        // the pool's existing FIFO still places this turn after other phases already waiting on the worker.
        if (this.active && !this.m.paused) this._pump();
      } catch (e) { this._fail(e); }
    });
  }

  _apply(out, forceSnapshots = false) {
    for (const [pid, sent] of this.terminalSnapshots) {
      const ps = this.m.players.get(pid) || this.m.spectators.get(pid);
      if (!ps?.connected || ps.left || this.m.watchers.get(pid) !== sent.fieldId) this.terminalSnapshots.delete(pid);
    }
    const before = this.ticks;
    this.ticks = out.ticks;
    for (const view of out.fields) {
      const f = this.fields.find((x) => x.fieldId === view.fieldId);
      if (!f) throw new Error('combat worker returned an unknown field');
      if (f.live !== view.live) this.m.markPublic();
      f.live = view.live;
      f.battle.update(view);
      this.m._syncNormalLayers?.(f, f.battle.layerGains);
    }
    // Local display replicas compare these digests with their own (DESIGN §14 "Local display replicas").
    for (const sync of out.syncs || []) {
      const f = this.fields.find((x) => x.fieldId === sync.fieldId);
      if (!f?.battleId) continue;
      const msg = { t: 'b.sync', battleId: f.battleId, tick: sync.tick, h: sync.h, ...(sync.done ? { done: true } : {}) };
      for (const pid of this._localViewers(f.fieldId)) this.m.sendTo(pid, msg);
    }
    // The boss fields' pool record (engine.js _beforeStep): kept whole for replicas that start later, forwarded to the
    // ones running now — their only input besides the spec (sim/spec.js ReplayBossPool).
    for (const x of out.ext || []) {
      const f = this.fields.find((y) => y.fieldId === x.fieldId);
      if (!f) continue;
      const log = f.extLog || (f.extLog = { flat: [], end: null });
      for (const e of x.hp || []) log.flat.push(e[0], e[1]);
      if (x.end && !log.end) log.end = x.end;
    }
    this._sendExt(!!out.done);
    // Replay ordered deltas once, then reconcile the authoritative totals. The main-thread pool is a HUD/stat mirror;
    // no live Battle has access to it. Threshold tickers still observe each hit in the original order.
    for (const effect of out.effects || []) {
      if (effect.type === 'bossDamage') this.m.bossPool.damage(effect.playerId, effect.amount);
      else if (effect.type === 'lpLoss') this.m._teamLpLoss(effect.amount);
    }
    if (out.boss) {
      this.m.bossPool.hp = out.boss.hp;
      this.m.bossPool.byPlayer = new Map(out.boss.byPlayer);
      this.m.teamLp = out.boss.teamLp;
      this.m.overtimeApplied = out.boss.overtimeApplied;
      this.m._syncTeamLp();
    }
    // This cache is independent of snapshot cadence/coalescing; the next snapshot must not erase a score.
    const damageFields = [];
    for (const frame of out.damageFrames || []) {
      const f = this.fields.find((x) => x.fieldId === frame.fieldId);
      if (!f) throw new Error('combat worker returned unknown damage field');
      f.battle._damageWire = frame.damageWire || null;
      f.battle._damageRows = frame.damageRows || null;
      f.battle._damageGt = frame.gt;
      if (frame.gt === f.battle.time) for (const [pid, fid] of this.damageResync) {
        if (fid === f.fieldId) this.damageResync.delete(pid);
      }
      // Match may consume the absolute rows for its complete round ledger, suppressing field-only sends.
      const consumed = this.m._onDamageRows?.(f, f.battle.damageRows()) === false;
      if (!consumed) damageFields.push(f);
    }
    const latest = new Map((out.frames || []).filter((frame) => frame.snapshotWire || frame.snapshot).map((frame) => [frame.fieldId, frame]));
    for (const frame of out.frames || []) {
      const f = this.fields.find((x) => x.fieldId === frame.fieldId);
      if (!f) continue;
      if (frame.startMetaWire || frame.startMeta) {
        const meta = frame.startMeta || JSON.parse(frame.startMetaWire);
        f.battle._startUnitStats = meta.unitStats;
        for (const pid of this._watchers(f.fieldId)) {
          if (this.resync.get(pid) === f.fieldId) continue;
          if (frame.startMetaWire) this.m.sendEncoded(pid, 'm.field', frame.startMetaWire);
          else this.m.sendTo(pid, meta);
        }
        continue;
      }
      // Catch-up event-only frames retain their original gt/order without replacing a consistent cached view.
      if (frame.snapshotWire || frame.snapshot) {
        f.battle._meta = frame.meta || null;
        f.battle._snapshot = frame.snapshot || null;
        f.battle._metaWire = frame.metaWire || null;
        f.battle._snapshotWire = frame.snapshotWire || null;
      }
      for (const pid of this._watchers(f.fieldId)) {
        if (this.resync.get(pid) === f.fieldId) {
          // Rejoin at the newest consistent tick in this batch, never send a current meta then an older snapshot.
          // A live frame without meta cannot serve it: the next pump asks for state, which always carries one.
          if (latest.get(f.fieldId) === frame && (frame.metaWire || frame.meta)) { this._sendCached(pid, f); this.resync.delete(pid); }
          continue;
        }
        if (frame.snapshotWire || frame.eventsWire) {
          if (frame.eventsWire) this.m.sendEncoded(pid, 'b.ev', frame.eventsWire);
          if (frame.snapshotWire) this._sendSnapshot(pid, f, frame, forceSnapshots || out.done);
        } else {
          if (frame.events?.length) this.m.sendTo(pid, { t: 'b.ev', fieldId: f.fieldId, gt: frame.gt ?? frame.snapshot.t, ev: frame.events });
          if (frame.snapshot) this.m.sendTo(pid, snapFrame(f.fieldId, frame.snapshot));
        }
      }
    }
    // A finished field's unchanged terminal frame is sent by the Worker once; keep offering the cached final view to
    // its watchers on every reply, under the same 1s retry/dedupe and phase-final bypass as a repeated frame.
    for (const f of this.fields) {
      if (f.live || latest.has(f.fieldId) || !f.battle._snapshotWire || !f.battle._metaWire) continue;
      for (const pid of this._watchers(f.fieldId)) {
        if (this.resync.get(pid) === f.fieldId) { this._sendCached(pid, f); this.resync.delete(pid); }
        else this._sendSnapshot(pid, f, { snapshotWire: f.battle._snapshotWire, metaWire: f.battle._metaWire }, forceSnapshots || out.done);
      }
    }
    for (const f of damageFields) for (const pid of this._watchers(f.fieldId)) this._sendDamageCached(pid, f);
    // Batch boundaries need not land exactly on a tick divisible by 30.
    this.publicTick = Math.floor(before / 6) !== Math.floor(this.ticks / 6);
    this.secondTick = Math.floor(before / 30) !== Math.floor(this.ticks / 30);
    if (this.onTick) this.onTick(this);
    if (out.done && this.active) {
      this.done = true;
      this._release();
      this.onDone(this);
    }
  }

  /** Connected viewers streamed this field: not those whose browser runs it as a local display replica. */
  _watchers(fieldId) {
    return this.m.watchersOf(fieldId).filter((pid) => {
      const ps = this.m.players.get(pid) || this.m.spectators.get(pid);
      return ps && ps.connected && !ps.left && !this.m._localShows?.(pid, fieldId);
    });
  }

  /**
   * The boss pool record a local display replica of `f` starts from (b.start `ext`), and from then on that player's
   * b.ext follow it. Null when it is not a boss field of this phase or its record is too long to send (stream it).
   */
  extFor(f, pid) {
    if (!f || (f.kind !== 'boss' && f.kind !== 'hidden') || !this.fields.includes(f) || !this.boss) return null;
    const log = f.extLog || (f.extLog = { flat: [], end: null });
    const n = log.flat.length / 2;
    if (n > EXT_START_MAX) return null;
    this.extSent.set(pid, { fieldId: f.fieldId, n, to: this.ticks, at: this.m.sched.now(), end: !!log.end });
    return { i: 0, to: this.ticks, hp: extPairs(log.flat, 0), ...(log.end ? { end: log.end } : {}) };
  }

  /**
   * b.ext { battleId, i, to, hp, end? } to the local display replicas of boss fields: the record entries from index `i`
   * the replica has not had, complete through tick `to` (sent even without entries: the replica may step up to it).
   */
  _sendExt(force = false) {
    if (!this.extSent.size) return;
    const now = this.m.sched.now();
    for (const f of this.fields) {
      if (f.kind !== 'boss' && f.kind !== 'hidden') continue;
      const log = f.extLog || { flat: [], end: null };
      const n = log.flat.length / 2;
      for (const pid of this._localViewers(f.fieldId)) {
        const s = this.extSent.get(pid);
        if (!s || s.fieldId !== f.fieldId) continue;
        const end = !!log.end && !s.end;
        if (!end && n === s.n && this.ticks === s.to) continue;
        if (!end && !force && now - s.at < EXT_MIN_GAP_MS) continue;
        this.m.sendTo(pid, { t: 'b.ext', battleId: f.battleId, i: s.n, to: this.ticks, hp: extPairs(log.flat, s.n), ...(end ? { end: log.end } : {}) });
        s.n = n;
        s.to = this.ticks;
        s.at = now;
        if (end) s.end = true;
      }
    }
  }

  /** Connected viewers running this field locally: they get its b.sync digests instead of frames. */
  _localViewers(fieldId) {
    return this.m.watchersOf(fieldId).filter((pid) => {
      const ps = this.m.players.get(pid);
      return ps && ps.connected && !ps.left && !!this.m._localShows?.(pid, fieldId);
    });
  }

  _sendSnapshot(pid, f, frame, force = false) {
    if (f.live) {
      this.terminalSnapshots.delete(pid);
      this.m.sendEncoded(pid, 'b.snap', frame.snapshotWire);
      return;
    }
    const now = this.m.sched.now();
    const sent = this.terminalSnapshots.get(pid);
    const elapsed = sent ? now - sent.at : Infinity;
    // Acceptance is not an end-to-end ACK: an ingress may still drop b.snap softly. Retry unchanged
    // terminal baselines while the phase runs; state/resync and phase-final sends always bypass this.
    if (!f.live && !force && sent?.fieldId === f.fieldId && sent.snapshotWire === frame.snapshotWire
      && sent.metaWire === frame.metaWire && elapsed >= 0 && elapsed < TERMINAL_SNAPSHOT_RETRY_MS) return;
    if (this.m.sendEncoded(pid, 'b.snap', frame.snapshotWire) && !f.live) {
      this.terminalSnapshots.set(pid, { fieldId: f.fieldId, snapshotWire: frame.snapshotWire, metaWire: frame.metaWire, at: now });
    }
  }

  _sendDamageCached(pid, f) {
    const b = f.battle;
    if (b._damageWire) this.m.sendEncoded(pid, 'b.damage', b._damageWire);
    else if (b._damageRows) this.m.sendTo(pid, damageFrame(f, b._damageRows));
  }

  _sendCached(pid, f) {
    const b = f.battle;
    if (b._metaWire && b._snapshotWire) {
      this.m.sendEncoded(pid, 'm.field', b._startUnitStats
        ? JSON.stringify(b.fieldMeta({ includeUnitStats: true })) : b._metaWire);
      this._sendSnapshot(pid, f, { snapshotWire: b._snapshotWire, metaWire: b._metaWire }, true);
      this._sendDamageCached(pid, f);
      return true;
    }
    if (!b._meta || !b._snapshot) return false;
    this.m.sendTo(pid, { t: 'm.field', ...b.fieldMeta({ includeUnitStats: true }), fieldId: f.fieldId, kind: f.kind, live: !!f.live });
    this.m.sendTo(pid, snapFrame(f.fieldId, b._snapshot));
    this._sendDamageCached(pid, f);
    return true;
  }

  requestField(pid, fieldId) {
    const f = this.fields.find((x) => x.fieldId === fieldId);
    if (!f || this.stopped || this.m.disposed || this.m.ended) return;
    this.terminalSnapshots.delete(pid);
    // A pending advance may satisfy the snapshot resync but carry a previous 1Hz damage sample.
    // Keep one bounded state request owed independently, even after that snapshot removed the watcher entry.
    if (!this.done) this.damageResync.set(pid, fieldId);
    if (this.done || this.m.paused) {
      if (this._sendCached(pid, f)) return;
    }
    this.resync.set(pid, fieldId);
  }

  forceField(fieldId, reason = 'left') {
    if (!this.active || !this.fields.some((f) => f.fieldId === fieldId)) return;
    this.controls.set(fieldId, { op: 'forceField', payload: { fieldId, reason } });
  }

  forceAll(reason = 'forced') {
    if (!this.active) return;
    this.controls.clear();
    this.controls.set('*', { op: 'forceAll', payload: { reason } });
  }

  resultOf(f) {
    const result = f.battle.result();
    if (!result?.perPlayer) throw new Error(`combat worker result missing: ${f.fieldId}`);
    return result;
  }

  _fail(error) {
    if (!this.active) return;
    this.stop();
    this.m.guard(() => {
      this.m.reportError('combat worker failure', error);
      this.m.tickerText('战斗演算服务异常，本次模拟已中止；请重新开始。');
      // Never invent a winning battle or charge a fabricated timeout. A hidden-stage failure keeps the base victory.
      this.m.finish({ victory: this.m.hiddenReached, hiddenCleared: false, reason: 'error' });
    });
  }
}
