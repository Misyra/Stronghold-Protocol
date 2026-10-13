// server/match/host/index.js — where a room's match runs (DESIGN §32.6, P1c; the design study's §6.4 方案 B):
//
//   * the vanilla content set — and a room whose plugins are all cosmetic (its cs is the vanilla one) — runs its match in
//     this process exactly as before: server/lobby.js does `new MatchClass(opts)` itself and never asks the hosts;
//   * a content set with gameplay plugins runs its matches in a worker thread of its own (server/match/host/entry.js),
//     shared by every room that plays that set (one worker per `cs`, any number of matches in it): its module table holds
//     that set's data and registries, so a plugin's data can never leak into another room, and a plugin that hangs or
//     crashes a worker ends that set's matches only.
//
//   create(cs, opts) → a MatchProxy (server/match/host/proxy.js) — the lobby's room.match. The worker is started on the
//     first match of a set (the set's data bytes and hash input from server/plugins/contentSets.js: the worker checks them
//     against `cs` before it imports the match) and kept while it has matches, then IDLE_MS more [ASSUMED 10 min: the
//     design study's]; a new set needing a worker when `maxWorkers` run stops an idle one first, else PLUGIN_BUSY.
//   Watchdog: every worker posts a heartbeat each heartbeatMs (1 s); one silent for watchdogMs (10 s) [ASSUMED: the design
//     study's] is terminated and each of its matches ends with 'plugin-hang' (the room back in its lobby, its members told:
//     proxy.js crash). A worker that exits on its own (an uncaught error, ERR_WORKER_OUT_OF_MEMORY past `resourceLimits`)
//     ends them with 'plugin-crash'; one whose content set does not boot, with 'plugin-start'. The log names the set and
//     its plugins.
//   resourceLimits [ASSUMED]: 768 MB old generation, 64 MB young generation, 4 MB stack per worker (options.resourceLimits).
//   stats() → { workers, matches } (/healthz); close() terminates every worker (server shutdown).
//
// Options (startServer `matchHost`): maxWorkers (default: the content-set limit, 4), heartbeatMs, watchdogMs, idleMs,
// resourceLimits, matchOptions (JSON-safe Match options every hosted match gets — the e2e and host tests scale the timers
// with it), and for tests only: matchModule (a module whose `Match` replaces server/match/Match.js in the workers),
// virtualTime (the matches run on a virtual clock).

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { ERR } from '../../../shared/constants.js';
import { csUrlPart } from '../../../shared/plugins/identity.js';
import { MatchProxy } from './proxy.js';

const ENTRY = fileURLToPath(new URL('./entry.js', import.meta.url));
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** Defaults [ASSUMED] (see the header). */
export const HOST_DEFAULTS = Object.freeze({
  maxWorkers: 4,
  heartbeatMs: 1000,
  watchdogMs: 10_000,
  idleMs: 10 * 60_000,
  resourceLimits: Object.freeze({ maxOldGenerationSizeMb: 768, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 }),
});

/** An error the lobby turns into a refusal (start). */
export class HostError extends Error {
  /** @param {string} code an ERR code @param {string} message */
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * The match hosts of one server.
 * @param {{ contents: { get: (cs: string) => any, dataBytes: (cs: string) => Record<string, Buffer> | null },
 *   log?: object, options?: Partial<typeof HOST_DEFAULTS> & { matchOptions?: object, matchModule?: string, virtualTime?: boolean } }} deps
 */
export function createMatchHosts({ contents, log = noopLog, options = {} }) {
  const o = { ...HOST_DEFAULTS, ...options };
  /** @type {Map<string, WorkerHost>} by cs */
  const hosts = new Map();
  let seq = 0;
  let closed = false;

  /** One worker and the matches of its content set. */
  class WorkerHost {
    constructor(cs) {
      this.cs = cs;
      this.tag = `[cs:${csUrlPart(cs).slice(0, 8)}]`;
      const set = contents.get(cs);
      const files = set ? contents.dataBytes(cs) : null;
      if (!set || !files) throw new HostError(ERR.INTERNAL, `the content set ${csUrlPart(cs)} is not kept by this server`);
      this.plugins = (set.plugins || []).map((p) => `${p.id}@${p.version}`).join(', ');
      /** @type {Map<string, MatchProxy>} */
      this.matches = new Map();
      this.lastBeat = Date.now();
      this.ready = false;
      this.dead = null;
      this.idleTimer = null;
      this.worker = new Worker(ENTRY, {
        workerData: {
          cs, hashInput: set.hashInput, files,
          options: { heartbeatMs: o.heartbeatMs, matchOptions: o.matchOptions || {}, matchModule: o.matchModule || null, virtualTime: !!o.virtualTime },
        },
        resourceLimits: { ...o.resourceLimits },
        stdout: false,
        stderr: false,
      });
      this.worker.unref?.();
      this.worker.on('message', (m) => this.onMessage(m));
      this.worker.on('error', (e) => {
        log.error?.(`[plugins] match host ${this.tag} (${this.plugins}) failed: ${e?.code || ''} ${e?.message || e}`);
        this.stop(this.ready ? 'plugin-crash' : 'plugin-start', `${e?.code || ''} ${e?.message || e}`.trim());
      });
      this.worker.on('exit', (code) => {
        if (!this.dead) {
          log.warn?.(`[plugins] match host ${this.tag} (${this.plugins}) exited (code ${code})`);
          this.stop(this.ready ? 'plugin-crash' : 'plugin-start', `the worker exited (code ${code})`);
        }
        if (hosts.get(this.cs) === this) hosts.delete(this.cs);
      });
      log.info?.(`[plugins] match host ${this.tag} started for ${this.plugins}`);
    }

    post(m) {
      if (this.dead) {
        // a message for a host already gone: its match learns it at once
        const p = this.matches.get(m.matchId);
        if (p) queueMicrotask(() => p.crash(this.dead.reason, this.dead.detail));
        return;
      }
      this.worker.postMessage(m);
    }

    forget(matchId) {
      this.matches.delete(matchId);
      this.armIdle();
    }

    armIdle() {
      if (this.dead || this.matches.size || this.idleTimer) return;
      this.idleTimer = setTimeout(() => { this.idleTimer = null; if (!this.matches.size) this.stop(null, 'idle'); }, o.idleMs);
      this.idleTimer.unref?.();
    }

    onMessage(m) {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'hb') { this.lastBeat = Date.now(); return; }
      if (m.type === 'log') {
        const fn = log[m.level] || log.info;
        fn?.call(log, `${this.tag} ${String(m.text)}`);
        return;
      }
      if (m.type === 'ready') { this.ready = true; this.lastBeat = Date.now(); log.info?.(`[plugins] match host ${this.tag} ready`); return; }
      if (m.type === 'boot-error') {
        log.error?.(`[plugins] match host ${this.tag} (${this.plugins}) did not boot: ${m.error}`);
        this.stop('plugin-start', String(m.error || ''));
        return;
      }
      const p = this.matches.get(m.matchId);
      if (p) p.deliver(m);
    }

    /**
     * Stop the worker: its matches end with `reason` (null: none left — an idle stop or the server's shutdown).
     * @param {'plugin-crash' | 'plugin-hang' | 'plugin-start' | null} reason @param {string} [detail]
     */
    stop(reason, detail = '') {
      if (this.dead) return;
      this.dead = { reason: reason || 'plugin-crash', detail };
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
      if (hosts.get(this.cs) === this) hosts.delete(this.cs);
      try { this.worker.terminate(); } catch { /* gone */ }
      const list = [...this.matches.values()];
      this.matches.clear();
      if (reason && list.length) log.warn?.(`[plugins] match host ${this.tag} (${this.plugins}) stopped (${reason}${detail ? `: ${detail}` : ''}) — ${list.length} match(es) ended`);
      for (const p of list) { try { if (reason) p.crash(reason, detail); else p.halt(); } catch (e) { log.error?.('[plugins] crash handler failed', e); } }
    }
  }

  // the watchdog: a worker whose heartbeats stopped is terminated (its matches end)
  const watchdog = setInterval(() => {
    const now = Date.now();
    for (const h of [...hosts.values()]) if (!h.dead && now - h.lastBeat > o.watchdogMs) h.stop('plugin-hang', `no heartbeat for ${Math.round((now - h.lastBeat) / 1000)} s`);
  }, Math.max(100, Math.min(1000, Math.floor(o.watchdogMs / 4))));
  watchdog.unref?.();

  /** A worker for `cs`: the running one, or a new one (an idle one of another set stopped when the limit is reached). */
  function hostFor(cs) {
    const cur = hosts.get(cs);
    if (cur && !cur.dead) return cur;
    if (hosts.size >= o.maxWorkers) {
      const idle = [...hosts.values()].find((h) => !h.matches.size);
      if (idle) idle.stop(null, 'room for another content set');
      else throw new HostError(ERR.PLUGIN_BUSY, `${hosts.size} match hosts run (limit ${o.maxWorkers})`);
    }
    const h = new WorkerHost(cs);
    hosts.set(cs, h);
    return h;
  }

  return {
    /**
     * The match of a room playing the content set `cs` (with gameplay plugins), run in that set's worker.
     * @param {string} cs @param {any} opts the lobby's Match options (send / broadcast / onEnd stay here)
     * @returns {MatchProxy}
     */
    create(cs, opts) {
      if (closed) throw new HostError(ERR.INTERNAL, 'the server is stopping');
      const h = hostFor(cs);
      if (h.idleTimer) { clearTimeout(h.idleTimer); h.idleTimer = null; }
      const matchId = `${opts.roomCode ?? 'room'}-${opts.matchNo ?? 0}-${++seq}`;
      const proxy = new MatchProxy({ host: h, matchId, opts, log });
      h.matches.set(matchId, proxy);
      return proxy;
    },
    /** Workers running and the matches in them (/healthz). */
    stats() {
      let matches = 0;
      for (const h of hosts.values()) matches += h.matches.size;
      return { workers: hosts.size, matches };
    },
    /** Stop every worker (the server stops; the lobby has disposed its rooms first). */
    close() {
      closed = true;
      clearInterval(watchdog);
      for (const h of [...hosts.values()]) h.stop(null, 'shutdown');
    },
    /** Test hook: the worker of a set (its thread id, its state). */
    _host: (cs) => hosts.get(cs) || null,
  };
}
