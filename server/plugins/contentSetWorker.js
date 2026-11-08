// server/plugins/contentSetWorker.js — the content set build worker (SP_CONTENT_BUILD_WORKER, default off): one
// dedicated worker thread that owns a second plugin registry read from the same plugin folders and runs C1's whole
// data walk (server/plugins/contentSet.js composeGen/finalizeGen — the patches, the records, the checks, the hashes,
// the freeze) off the main thread, which only parses the tables the set changed and verifies every transferred byte
// (builtSetFromWorkerFinal). The registry scan, the vanilla snapshot and the C1 caches live here exactly as the main
// thread's builder kept them — a build's inputs are the same disk bytes, so the result is the same bytes and the same
// problems (test/plugins/contentSetWorker.test.js pins the equality on the real worker).
//
// Snapshot pinning: the main thread's registry is the authority (its recheck cadence, its memo keys, its stale
// detection). Every build request carries the selected plugins' identity as the main thread sees it — status, content
// hash, script lock hash — and the worker answers `drift` when its own registry disagrees (its recheck saw other
// bytes, a plugin vanished, a lock changed). The caller then builds on the main thread as before: the worker is a
// faster seat, never a second authority. Script probes stay on the main thread (scriptPreflight.js): a set with
// script plugins comes back as `pending`, the caller probes against the main registry and asks `finalize` (or
// `discard`s — a refused set leaves nothing cached here, same as it never left a served byte or cache entry before).
//
// Messages (workerData { dirs, recheckMs?, scriptHost?, scriptMode? }; `wseq` correlates replies, `ref` names a
// pending walk):
//   { type: 'build', wseq, ids, expect }  → { wseq, drift } | { wseq, problems } | { wseq, pending: { scripts, hashInput } }
//                                           | { wseq, final } | { wseq, error }
//   { type: 'finalize', wseq, ref }       → { wseq, final } | { wseq, error }
//   { type: 'discard', ref }              → the pending walk is dropped, no reply
//   { type: 'script-host', host }         → the registry re-evaluates the trust gate (the server bound)
// `final` carries everything the main thread cannot rebuild cheaply: the cs, the index, the per-file hashes and the
// served bodies (transferred, zero-copy) — `builtSetFromWorkerFinal` verifies and parses them into the built set.
// The client never terminates a worker that is carrying a build; it only rejects the waiters when a worker dies and
// respawns on the next build (a lost worker is a fallback, not a lost set). close() (server shutdown, tests) is the
// only terminate.
import { parentPort, workerData, Worker } from 'node:worker_threads';
import { createPluginRegistry } from './registry.js';
import { contentSetFiles, composeSync, finalizeSync } from './contentSet.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** SP_CONTENT_BUILD_WORKER: off unless set to something other than the off words (0/off/false/no; default off — the
 * main-thread sliced build stays the shipped behaviour until the maintainer turns this on). */
export function contentSetWorkerEnabled(env = process.env) {
  const v = String(env.SP_CONTENT_BUILD_WORKER ?? '').trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'off' && v !== 'false' && v !== 'no';
}

// --- the worker side (this module as the Worker's entry) ---------------------------------------------------------------------

/** An ArrayBuffer this Buffer owns outright (transferable without copying or aliasing pool neighbours). */
function ownedBufferAb(buf) {
  return buf.byteOffset === 0 && buf.buffer.byteLength === buf.byteLength ? buf.buffer : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** The wire shape of a built set: everything but `data` (the main thread re-parses the served bodies) and `files`
 * (rebuilt from the hashes it verifies). Pure JSON plus the body bytes, so a structured clone round-trips it. */
function finalOf(set) {
  const files = contentSetFiles(set);
  const rels = [...files.keys()];
  const bodies = rels.map(rel => files.get(rel).body);
  const abs = bodies.map(ownedBufferAb);
  const hashes = {};
  for (const rel of rels) hashes[rel] = files.get(rel).sha256;
  return [{ cs: set.cs, vanilla: set.vanilla, index: set.index, plugins: set.plugins,
    ...(set.scripts?.length ? { scripts: set.scripts, execution: set.execution } : {}),
    ...(set.rules ? { rules: set.rules } : {}), warnings: set.warnings, settings: set.settings,
    kitted: set.kitted, bounds: set.bounds, ...(set.offers?.length ? { offers: set.offers } : {}),
    rels, hashes, bodies: abs.map(ab => new Uint8Array(ab)) }, abs];
}

function runWorker() {
  const post = (m, transfer) => { try { parentPort.postMessage(m, transfer ?? []); } catch { /* the parent is gone; the waiters fall back */ } };
  let registry = null;
  /** @type {Map<number, { pending: any }>} the walks awaiting their probe verdict, by build id */
  const pendings = new Map();
  const log = { info: noopLog.info, warn: (...a) => post({ type: 'log', level: 'warn', text: a.map(String).join(' ') }) };
  try {
    // the same trust inputs as the main thread's registry: a script plugin's execution (hashed into the cs) must not
    // depend on which side scanned it
    registry = createPluginRegistry(workerData.dirs, { log, recheckMs: workerData.recheckMs,
      ...(workerData.scriptHost !== undefined ? { scriptHost: workerData.scriptHost } : {}),
      ...(workerData.scriptMode !== undefined ? { scriptMode: workerData.scriptMode } : {}) });
  } catch (e) {
    post({ type: 'fatal', error: String(e?.message || e) });
    return;
  }
  /** The selected plugins as this registry sees them, against the main thread's pin: one differing row is drift. */
  const driftOf = (expect) => {
    const drift = [];
    for (const e of expect) {
      const p = registry.plugin(e.id); // refresh(): the same folder recheck cadence the main thread's registry runs
      if (!p || p.status !== e.status || (p.content?.hash ?? null) !== (e.contentHash ?? null)
        || (p.script?.lockHash ?? null) !== (e.lockHash ?? null)) drift.push(e.id);
    }
    return drift;
  };
  parentPort.on('message', (m) => {
    if (!m || typeof m.type !== 'string' || !Number.isInteger(m.wseq)) return;
    try {
      if (m.type === 'script-host') { // the server bound (or rebound): the trust gate re-evaluates, as on the main thread
        registry.setScriptHost(m.host);
        return;
      }
      if (m.type === 'build') {
        if (!Array.isArray(m.ids) || !Array.isArray(m.expect)) { post({ wseq: m.wseq, error: 'malformed build request' }); return; }
        const drift = driftOf(m.expect);
        if (drift.length) { post({ wseq: m.wseq, drift }); return; }
        const half = composeSync({ registry, ids: m.ids });
        if (half.problems?.length) { post({ wseq: m.wseq, problems: half.problems }); return; }
        if (!half.pending) { // the C1 cache hit: a set built here before — collect it like a fresh one
          const [final, transfer] = finalOf(half);
          post({ wseq: m.wseq, final }, transfer);
          return;
        }
        if (half.pending.probe) { // scripts: the main thread probes, then asks finalize (or discards)
          pendings.set(m.wseq, { pending: half.pending });
          if (pendings.size > 8) pendings.delete(pendings.keys().next().value);
          post({ wseq: m.wseq, pending: { scripts: half.pending.probe.scripts, hashInput: half.pending.probe.hashInput } });
          return;
        }
        const set = finalizeSync(half.pending);
        const [final, transfer] = finalOf(set);
        post({ wseq: m.wseq, final }, transfer);
        return;
      }
      if (m.type === 'finalize') {
        const held = pendings.get(m.ref);
        if (!held) { post({ wseq: m.wseq, error: 'no pending walk for this build' }); return; }
        pendings.delete(m.ref);
        const set = finalizeSync(held.pending);
        const [final, transfer] = finalOf(set);
        post({ wseq: m.wseq, final }, transfer);
        return;
      }
      if (m.type === 'discard') pendings.delete(m.ref);
    } catch (e) {
      pendings.delete(m.ref ?? m.wseq);
      post({ wseq: m.wseq, error: String(e?.message || e) });
    }
  });
}

// --- the main-thread client --------------------------------------------------------------------------------------------------

/**
 * The build worker of one server's content sets: lazy (spawned by the first build), single (a compose is one
 * synchronous block in the worker, so its builds queue exactly like the main thread's composeTail queue), and
 * expendable (a dead worker rejects its waiters — the caller builds on the main thread — and the next build respawns
 * one). `recheckMs` passes through to the worker's registry (tests pin a stale view to force a drift).
 */
export class ContentSetBuildWorker {
  constructor({ dirs, log = noopLog, recheckMs, scriptHost, scriptMode } = {}) {
    this.dirs = dirs;
    this.log = log;
    this.recheckMs = recheckMs;
    this.scriptHost = scriptHost;
    this.scriptMode = scriptMode;
    this.worker = null;
    this.seq = 0;
    this.spawns = 0;
    this.failures = 0;
    /** @type {Map<number, { yes: Function, no: Function }>} */
    this.waiters = new Map();
  }

  #spawn() {
    this.worker = new Worker(new URL('./contentSetWorker.js', import.meta.url), { workerData: {
      dirs: this.dirs,
      ...(this.recheckMs !== undefined ? { recheckMs: this.recheckMs } : {}),
      ...(this.scriptHost !== undefined ? { scriptHost: this.scriptHost } : {}),
      ...(this.scriptMode !== undefined ? { scriptMode: this.scriptMode } : {}),
    } });
    this.spawns++;
    this.worker.on('message', (m) => {
      if (m?.type === 'log') { this.log.warn?.(`[plugins] build worker: ${m.text}`); return; }
      if (m?.type === 'fatal') { this.log.error?.(`[plugins] build worker died at start: ${m.error}`); return; }
      const w = this.waiters.get(m?.wseq);
      if (!w) return;
      this.waiters.delete(m.wseq);
      this.worker.unref();
      if (m.error) { this.failures++; w.no(new Error(m.error)); return; }
      w.yes(m);
    });
    const gone = (why) => {
      if (!this.worker) return;
      this.worker = null;
      const waiters = [...this.waiters.values()];
      this.waiters.clear();
      this.failures++;
      for (const w of waiters) w.no(new Error(`the content set build worker ${why}`));
    };
    this.worker.on('error', (e) => gone(`failed (${e?.message || e})`));
    this.worker.on('exit', (code) => { if (this.waiters.size) gone(`exited (${code})`); else this.worker = null; });
    return this.worker;
  }

  /** One round trip. Resolves with the worker's reply ({ drift | problems | pending | final }, `.wseq` echoed),
   * rejects when the worker is gone — both mean "build on the main thread". */
  #ask(message, transfer = []) {
    const worker = this.worker ?? this.#spawn();
    const wseq = ++this.seq;
    return new Promise((yes, no) => {
      this.waiters.set(wseq, { yes, no });
      worker.ref();
      worker.postMessage({ ...message, wseq }, transfer);
    });
  }

  /** A build request: the ids (with normalized settings, as the builder reads them) and the main registry's pin of
   * the selected plugins. The reply carries `.wseq` — the handle for finalize/discard of a pending walk. */
  build(ids, expect) { return this.#ask({ type: 'build', ids, expect }); }

  /** The probe came back clean: the worker finishes the walk it kept under this build's wseq. */
  finalize(wseq) { return this.#ask({ type: 'finalize', ref: wseq }); }

  /** The probe refused the set: the worker drops the walk (nothing cached, nothing served — as before). */
  discard(wseq) {
    if (this.worker) { try { this.worker.postMessage({ type: 'discard', ref: wseq, wseq: 0 }); } catch { /* gone; the pending dies with it */ } }
  }

  /** Alive (or spawnable) — a stats line, never a correctness input. */
  get alive() { return !!this.worker; }

  /** The server bound (or rebound): the worker registry re-evaluates the trust gate like the main one; a worker not
   * yet spawned takes the address at spawn time. */
  setScriptHost(host) {
    this.scriptHost = host;
    if (this.worker) { try { this.worker.postMessage({ type: 'script-host', wseq: 0, host }); } catch { /* gone; the next spawn carries it */ } }
  }

  /** Stop the worker (server shutdown, tests). In-flight builds reject; their callers fall back. */
  async close() {
    const worker = this.worker;
    this.worker = null;
    const waiters = [...this.waiters.values()];
    this.waiters.clear();
    for (const w of waiters) w.no(new Error('the content set build worker closed'));
    if (worker) await worker.terminate();
  }
}

if (parentPort) runWorker();
