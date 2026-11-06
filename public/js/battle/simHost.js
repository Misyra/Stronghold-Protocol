// C4 simulation hosts (DESIGN §32.11). The clock belongs to runner.js. Only the vanilla host has a Battle on the page.
import { loadBrowserSim, checkOperatorTraitRuntime } from './simLoader.js';
import { unitStatsEntry } from '../../../shared/protocol.js';

/** [ASSUMED] 2 s per control RPC, including construction and forceEnd (both can execute plugin hooks). */
export const WORKER_TIMEOUT_MS = 2000;
/**
 * [ASSUMED] A step's deadline grows past the control budget with its slice — the worker accepts up to 600-tick
 * catch-up slices (simWorkerRuntime.js), and a healthy heavy plugin set may legibly need more than the flat 2 s
 * for one of them. 240 ticks fit the base budget.
 */
export const WORKER_STEP_TICKS_PER_TIMEOUT = 240;
/** [ASSUMED] Trusted engine/module/data cold load can take longer; plugin code runs in a separate 2 s install RPC. */
export const WORKER_LOAD_TIMEOUT_MS = 15000;
/**
 * Rollback switch for the lean step packet (simWorkerRuntime.js metaFingerprint): `SP_STEP_PACKET=full` puts the
 * complete field meta / owner ops back into every step packet, like before the lean packet. Read on the page side
 * only — the Worker has no process.env — and sent to the worker with the load RPC (`globalThis.__SP_STEP_PACKET__`
 * lets a page or a dev console force it where no env exists).
 */
export const stepPacketFull = () => String(globalThis.__SP_STEP_PACKET__ ?? globalThis.process?.env?.SP_STEP_PACKET ?? '')
  .trim().toLowerCase() === 'full';
const failure = (code, message) => Object.assign(new Error(message), { code });

export class InPageSimHost {
  constructor({ loadSim = loadBrowserSim } = {}) { this.loadSim = loadSim; this.remote = false; this.battle = null; }
  async load(cs = null, content = null) {
    this.sim = await this.loadSim(content ? { ...content, cs } : undefined);
    return this;
  }
  start(spec, opts = {}) {
    this.spec = spec;
    this.battle = this.sim.spec.createBattleFromSpec(spec, this.sim.ds, { resourceNumbers: true, ...opts });
    this.meter = this.sim.spec.attachLpMeter(this.battle);
    return this;
  }
  step(n, { slice = 0 } = {}) {
    const b = this.battle;
    const slices = [];
    let ticks = 0;
    for (; ticks < n && !b.finished; ticks++) {
      b.step();
      if (slice && (ticks + 1) % slice === 0 && ticks + 1 < n) {
        const ev = b.drainEvents() || [];
        if (ev.length) slices.push({ gt: Number(b.time) || 0, ev });
      }
    }
    // Lazy reads keep the vanilla runner's snapshot/event timing unchanged.
    return { get snap() { return b.snapshot(); }, get ev() { return b.drainEvents() || []; }, state: b, ticks, slices };
  }
  progress() { return this.sim.spec.battleProgress(this.battle); }
  uniteLeft() { return this.sim.spec.uniteLeft(this.battle); }
  compactResult(options) {
    const s = this.sim.spec;
    const r = s.compactResult(this.battle.result());
    return typeof s.fitResult === 'function' ? s.fitResult(r, options) : r;
  }
  unitStats(id) {
    const u = this.battle?.unitById?.(id);
    return u ? unitStatsEntry(u, u._s || null) : null;
  }
  ownerOps(pid) {
    return (this.battle?.allyUnits || []).filter(u => u?.kind === 'op' && u.ownerId === pid && typeof u.defId === 'string').map(u => ({
      kind: 'op', ownerId: pid, defId: u.defId,
      ...(u.items?.length ? { items: [...u.items] } : {}),
      ...(u.def?.standInFor ? { standInFor: u.def.standInFor } : {}),
      ...(u.def?.diyFor && u.def.loadout?.diy ? { diy: { ...u.def.loadout.diy } } : {}),
    }));
  }
  syncPool(hp, acked) { this.battle?.sharedBoss?.sync?.(hp, acked); }
  forceEnd(reason) { this.battle?.forceEnd(reason); }
  stop() { this.battle = null; }
}

/** Wire state only: no engine import or engine object, including in the dev introspection hooks. */
export class WorkerSimHost {
  constructor({ workerFactory = () => new Worker(new URL('./simWorker.js', import.meta.url), { type: 'module' }),
    timeoutMs = WORKER_TIMEOUT_MS, loadTimeoutMs = WORKER_LOAD_TIMEOUT_MS, onFailure = () => {}, contentFor = null,
    stepPacketFull = false } = {}) {
    this.contentFor = contentFor;
    this.remote = true;
    this.timeoutMs = timeoutMs;
    this.loadTimeoutMs = loadTimeoutMs;
    this.onFailure = onFailure;
    // SP_STEP_PACKET=full (runner.js passes stepPacketFull()): every step packet carries meta/ops again.
    this.stepPacketFull = stepPacketFull === true;
    this.worker = workerFactory();
    this.pending = new Map();
    this.seq = 0;
    this.stopped = false;
    this.events = [];
    this.statsCache = new Map();
    this.statsPending = new Set();
    // The last field meta / owner ops the worker sent: step packets attach them only on a unit-identity change
    // (simWorkerRuntime.js metaFingerprint), so they live here between packets; fieldMeta()/ownerOps() read them.
    this.meta = undefined;
    this.ops = undefined;
    this.battle = {
      snapshot: () => this.packet?.snap,
      drainEvents: () => this.events.splice(0),
      fieldMeta: () => this.meta || { units: [] },
      getPlayer: pid => this.packet?.players?.[pid],
    };
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data?.id);
      if (!p) return;
      this.pending.delete(data.id);
      clearTimeout(p.timer);
      if (data.error) { const err = failure(data.error.code || 'PLUGIN_WORKER_FAILED', data.error.message); p.reject(err); this.fail(err); }
      else p.resolve(data.value);
    };
    this.worker.onerror = () => this.fail(failure('PLUGIN_WORKER_FAILED', 'simulation worker failed'));
    this.worker.onmessageerror = () => this.fail(failure('PLUGIN_WORKER_FAILED', 'simulation worker message failed'));
  }
  rpc(method, args = [], timeoutMs = this.timeoutMs, fatal = true) {
    if (this.stopped) return Promise.reject(failure('PLUGIN_WORKER_STOPPED', 'simulation worker stopped'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = failure('PLUGIN_WORKER_TIMEOUT', `simulation worker ${method} exceeded ${timeoutMs} ms`);
        // A control RPC that answers too late means the worker is good for nothing; a stat/pool probe queued
        // behind a long step only misses its answer — the step's own deadline is what judges the worker.
        if (fatal) this.fail(err);
        else { this.pending.delete(id); reject(err); }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ id, method, args }); } catch (err) { this.fail(err); }
    });
  }
  fail(err) { if (this.stopped) return; this.stop(err); this.onFailure(err); }
  async load(cs, content = null) {
    content ||= await this.contentFor?.(cs);
    if (!content || content.cs !== cs || !content.data) throw failure('PLUGIN_WORKER_FAILED', 'no checked content set');
    this.cs = cs;
    const traitRuntimeVerified = await checkOperatorTraitRuntime(content.data);
    const ready = await this.rpc('load', [{ ...content, cs, traitRuntimeVerified },
      this.stepPacketFull ? { stepPacket: 'full' } : undefined], this.loadTimeoutMs);
    if (ready.install) await this.rpc('install');
    return this;
  }
  accept(packet) {
    this.packet = packet;
    // The lean packet's meta/ops (absent between identity changes) leave the last ones in place.
    if (packet.meta !== undefined) this.meta = packet.meta;
    if (packet.ops !== undefined) this.ops = packet.ops;
    this.events.push(...packet.ev);
    Object.assign(this.battle, packet.state);
    this.meter = packet.meter;
    return packet;
  }
  async start(spec) {
    this.spec = spec;
    // A reused worker still has the previous battle's events and stat RPCs. Drop them after `start` returns so a
    // step that was already in flight cannot append onto the new battle, and ignore stat replies from the old one.
    this.statsGeneration = (this.statsGeneration || 0) + 1;
    this.statsPending.clear();
    this.meta = undefined;
    this.ops = undefined;
    const packet = await this.rpc('start', [spec]);
    this.events.length = 0;
    this.statsCache.clear();
    this.accept(packet);
    return this;
  }
  async step(n, opts) {
    // The slice's own deadline: 240 ticks fit the control budget, a 600-tick catch-up slice gets proportionally
    // more — a heavy-but-healthy set is not taken over for being slow. A genuinely stuck worker still dies.
    return this.accept(await this.rpc('step', [n, opts], this.timeoutMs * (1 + n / WORKER_STEP_TICKS_PER_TIMEOUT)));
  }
  progress() { return this.packet.progress; }
  uniteLeft() { return this.packet.left; }
  compactResult() { return this.packet.result; }
  unitStats(id) {
    if (!this.stopped && !this.statsPending.has(id)) {
      this.statsPending.add(id);
      const generation = this.statsGeneration || 0;
      this.rpc('unitStats', [id], this.timeoutMs, false).then(v => {
        if (generation === (this.statsGeneration || 0)) this.statsCache.set(id, v);
      }, () => {}).finally(() => {
        if (generation === (this.statsGeneration || 0)) this.statsPending.delete(id);
      });
    }
    return this.statsCache.get(id) || null;
  }
  ownerOps(pid) { return this.ops?.[pid] || []; }
  /**
   * The on-demand half of the lean step packet: a fresh full meta/ops straight from the worker. Non-fatal and
   * best-effort like unitStats — a miss keeps the cached meta (the fingerprint-gated packets are the primary
   * freshness mechanism). Resolves the reply ({ meta, ops }) or null; the runner's show() compares it against what
   * it emitted and re-enters the field when the lean packets missed an identity change.
   */
  refreshMeta() {
    return this.rpc('meta', [], this.timeoutMs, false).then(
      v => {
        if (v?.meta) { this.meta = v.meta; if (v.ops) this.ops = v.ops; }
        return v || null;
      },
      () => null,
    );
  }
  syncPool(hp, acked) { return this.rpc('syncPool', [hp, acked], this.timeoutMs, false).catch(() => {}); }
  async forceEnd(reason) { this.accept(await this.rpc('forceEnd', [reason])); }
  stop(err = failure('PLUGIN_WORKER_STOPPED', 'simulation worker stopped')) {
    if (this.stopped) return;
    this.stopped = true;
    this.worker.terminate();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }
}

/**
 * Identity signature of a field meta (a UnitInfo list): what a view built from it keeps for the unit's whole life —
 * model, form, down membership, loadout, skin, stats-seed — as one string. The runner's show() compares it against
 * a fresh refreshMeta() fetch to heal a lean step packet that missed a change (a missed change would draw stale
 * models or lose spawns); position, HP, facing and attack interval stay out — the snapshot tuples carry them and
 * the views re-read them every frame.
 */
export function metaIdentity(meta) {
  const units = Array.isArray(meta?.units) ? meta.units : [];
  let s = '';
  for (const u of units) {
    s += `${u.id}|${u.uid ?? ''}|${u.defId ?? ''}|${u.spine ?? ''}|${u.avatar ?? ''}|${u.name ?? ''}|${u.form ?? ''}`
      + `|${u.skin ?? ''}|${u.ownerCharId ?? ''}|${u.tier ?? ''}|${u.golden ? 1 : 0}|${u.motion ?? ''}|${u.boss ? 1 : 0}`
      + `|${u.dir ?? ''}|${u.skillIndex ?? ''}|${u.ammoSkill ? 1 : 0}|${u.moduleId ?? ''}|${u.potential ?? ''}|${u.cultivate ?? ''}`
      + `|${Array.isArray(u.items) ? u.items.join(',') : ''}|${u.standInFor ?? ''}|${u.diy ? JSON.stringify(u.diy) : ''}`
      + `|${Array.isArray(u.itemProgress) ? JSON.stringify(u.itemProgress) : ''};`;
  }
  return s;
}
