// server/plugins/contentSets.js — the content sets of this server (DESIGN §32.6, P1c; the design study's §6.2–§6.4): a
// set of content plugins (gameplay: data patches, new records, modes), closed over their requirements and in load order,
// merged with the vanilla data into one immutable content set named by its own content hash `cs`
// (shared/plugins/identity.js) — what a room with gameplay plugins plays, what every member's page downloads and checks
// and what the room's match host worker runs (server/match/host/).
//
//   resolve(ids, { settings, replacing })  the set of these content plugins (built once per `cs`, then kept): refused
//                                          with PLUGIN_BUSY when it would be one set more than `limits.maxSets` rooms
//                                          hold at once (a set a room already holds is free; `replacing`: the set the
//                                          asking room holds now, freed by the change) [ASSUMED default 4]
//   hold(cs) / release(cs)                 a room uses the set (never dropped while held)
//   file(cs16, rel)                        what /cs/<cs16>/… serves: index.json (the set's manifest) and its patched
//                                          files — a held set's, or one of the last MAX_KEPT built [ASSUMED 8]
//   dataOf(cs) / kittedOf(cs) / modesOf(cs) the merged data (the lobby checks a member's loadout and 自选 picks against
//                                          it), the operators a 自选 slot may field, the modes it provides
//   dataBytes(cs)                          the served bytes of every gameplay data file of the set (the patched ones from
//                                          memory, the others read from disk now) — what a match host worker checks
//                                          against the set's hash input and parses (server/match/host/entry.js)
// The builder is WP-A's C1 interface (buildContentSet / contentSetFiles); until it merges, ./contentSetStub.js stands
// in (the vanilla data plus the plugin list) — the one import to change below.

import fs from 'node:fs';
import path from 'node:path';
import { ERR } from '../../shared/constants.js';
import { csUrlPart, isContentHash } from '../../shared/plugins/identity.js';
// REPLACE WHEN WP-A MERGES: import { buildContentSet, contentSetFiles } from './contentSet.js';
import { buildContentSet, contentSetFiles } from './contentSetStub.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
/** Content sets kept that no room holds (their /cs/ files stay servable a while). [ASSUMED] */
export const MAX_KEPT = 8;
/** Concurrent content sets with gameplay plugins rooms may hold (plugins/config.json limits.maxSets). [ASSUMED] */
export const DEFAULT_MAX_SETS = 4;

/**
 * @typedef {{ cs: string, plugins: { id: string, version: string, hash: string }[], modes: object[], data: Record<string, any>,
 *   files: Record<string, { sha256: string, bytes: number }>, hashInput: any, kitted: string[] | null,
 *   served: { index: Record<string, unknown>, indexBody: Buffer, files: Map<string, { body: Buffer, sha256: string, bytes: number }> },
 *   dataBytes: number }} ContentSet
 */

/**
 * The content sets of one server.
 * @param {{ registry: { plugin: (id: string) => any }, vanilla: import('./identity.js').VanillaContent,
 *   vanillaData: Readonly<Record<string, any>>, dataDir: string, pluginsDir: string, log?: object,
 *   maxSets?: () => number, build?: typeof buildContentSet, filesOf?: typeof contentSetFiles, maxKept?: number }} opts
 *   maxSets: the limit now (the server owner's policy may change it); build / filesOf: the C1 builder (tests inject one)
 */
export function createContentSets({ registry, vanilla, vanillaData, dataDir, pluginsDir, log = noopLog, maxSets = () => DEFAULT_MAX_SETS,
  build = buildContentSet, filesOf = contentSetFiles, maxKept = MAX_KEPT }) {
  /** @type {Map<string, ContentSet>} by cs16, most recently used last */
  const sets = new Map();
  /** @type {Map<string, number>} cs16 → rooms holding it */
  const held = new Map();

  const keep = (key, set) => {
    sets.delete(key);
    sets.set(key, set);
    let free = 0;
    for (const k of sets.keys()) if (!held.has(k)) free++;
    for (const k of [...sets.keys()]) {
      if (free <= maxKept) break;
      if (k === key || held.has(k)) continue;
      sets.delete(k);
      free--;
    }
  };

  /**
   * The content set of the content plugins `ids` (closed and in load order — server/plugins/roomSets.js), built or
   * remembered (see the header).
   * @param {string[]} ids
   * @param {{ settings?: Record<string, Record<string, unknown>>, replacing?: string | null }} [opts]
   * @returns {{ ok: true, set: ContentSet } | { error: string, detail: string }}
   */
  function resolve(ids, { settings = {}, replacing = null } = {}) {
    let built;
    try {
      built = build({ registry, ids, settings, vanilla, vanillaData, pluginsDir, dataDir });
    } catch (e) {
      log.error?.('[plugins] content set failed to build', e);
      return { error: ERR.INTERNAL, detail: 'the content set failed to build' };
    }
    if (!built || !isContentHash(built.cs) || (Array.isArray(built.problems) && built.problems.length)) {
      const why = Array.isArray(built?.problems) && built.problems.length ? built.problems.join('; ') : 'no content set';
      log.warn?.(`[plugins] content set of ${ids.join(', ')} refused: ${why}`);
      return { error: ERR.PLUGIN_BLOCKED, detail: why.slice(0, 200) };
    }
    const key = csUrlPart(built.cs);
    let set = sets.get(key);
    if (!set || set.cs !== built.cs) {
      const served = filesOf(built, vanilla);
      set = {
        cs: built.cs, plugins: built.plugins, modes: Array.isArray(built.modes) ? built.modes : [], data: built.data, files: built.files || {},
        hashInput: built.hashInput, kitted: Array.isArray(built.kitted) ? built.kitted : null,
        served: { index: served.index, indexBody: Buffer.from(JSON.stringify(served.index)), files: served.files },
        dataBytes: Object.values(built.files || {}).reduce((n, f) => n + (Number(f.bytes) || 0), 0),
      };
    }
    // the limit: one set more than the rooms hold now (a set already held, or the one the asking room gives up, is free)
    if (!held.has(key)) {
      const freed = replacing && isContentHash(replacing) && held.get(csUrlPart(replacing)) === 1 ? 1 : 0;
      const limit = Math.max(0, Number(maxSets()) || 0);
      if (held.size - freed >= limit) return { error: ERR.PLUGIN_BUSY, detail: `${held.size} content sets in use (limit ${limit})` };
    }
    keep(key, set);
    return { ok: true, set };
  }

  const byCs = (cs) => { const s = isContentHash(cs) ? sets.get(csUrlPart(cs)) : null; return s && s.cs === cs ? s : null; };

  return {
    resolve,
    /** A room uses the set of `cs`: never dropped until every holder released it. @param {string} cs */
    hold(cs) { if (!isContentHash(cs)) return; const k = csUrlPart(cs); held.set(k, (held.get(k) || 0) + 1); },
    /** A room no longer uses the set of `cs`. @param {string} cs */
    release(cs) {
      if (!isContentHash(cs)) return;
      const k = csUrlPart(cs);
      const n = (held.get(k) || 0) - 1;
      if (n > 0) held.set(k, n);
      else held.delete(k);
    },
    /** The set of `cs`, while it is kept. @param {string} cs @returns {ContentSet | null} */
    get: byCs,
    /** Its merged data (the lobby's checks), or null. @param {string} cs */
    dataOf: (cs) => byCs(cs)?.data || null,
    /** The operators a 自选 slot may field in it (null = the vanilla list). @param {string} cs */
    kittedOf: (cs) => byCs(cs)?.kitted || null,
    /** The modes its plugins provide. @param {string} cs */
    modesOf: (cs) => byCs(cs)?.modes || [],
    /**
     * A file of a kept set as /cs/<cs16>/<rel> serves it: its manifest (index.json) or a patched file; null otherwise.
     * @param {string} cs16 @param {string} rel
     * @returns {{ body: Buffer, sha256: string | null, type: string } | null}
     */
    file(cs16, rel) {
      const set = sets.get(cs16);
      if (!set) return null;
      if (rel === 'index.json') return { body: set.served.indexBody, sha256: null, type: 'application/json; charset=utf-8' };
      const f = set.served.files.get(rel);
      return f ? { body: f.body, sha256: f.sha256, type: 'application/json; charset=utf-8' } : null;
    },
    /**
     * The served bytes of every gameplay data file of the set of `cs`, by data name (see the header) — null for a set
     * not kept; a vanilla file that cannot be read is left out (the worker then refuses the set: its hash input names it).
     * @param {string} cs
     * @returns {Record<string, Buffer> | null}
     */
    dataBytes(cs) {
      const set = byCs(cs);
      if (!set) return null;
      const out = {};
      for (const [name, f] of Object.entries(vanilla.data)) {
        const patched = set.served.files.get(`data/${f.file}`);
        if (patched) { out[name] = patched.body; continue; }
        try { out[name] = fs.readFileSync(path.join(dataDir, f.file)); } catch (e) { log.warn?.(`[plugins] data/${f.file} cannot be read: ${e?.code || e?.message || e}`); }
      }
      return out;
    },
    /** Content sets rooms hold now (/healthz content.sets). */
    inUse: () => held.size,
    stats: () => ({ sets: sets.size, held: held.size }),
  };
}
