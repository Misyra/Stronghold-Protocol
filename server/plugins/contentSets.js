// server/plugins/contentSets.js — the content sets of this server (DESIGN §32.6, P1c; the design study's §6.2–§6.4): a
// set of content plugins (gameplay: data patches, new records, modes), closed over their requirements and in load order,
// merged with the vanilla data into one immutable content set named by its own content hash `cs`
// (shared/plugins/identity.js) — what a room with gameplay plugins plays, what every member's page downloads and checks
// and what the room's match host worker runs (server/match/host/).
//
//   resolve(ids, { settings, replacing })  the set of these content plugins (built by WP-A's C1, kept by cs16): refused
//                                          with PLUGIN_BUSY when it would be one set more than `limits.maxSets` rooms
//                                          hold at once (a set a room already holds is free; `replacing`: the set the
//                                          asking room holds now, freed by the change) [ASSUMED default 4]
//   hold(cs) / release(cs)                 a room uses the set (never dropped while held)
//   file(cs16, rel)                        what /cs/<cs16>/… serves: index.json (the set's manifest) and its data and
//                                          translation files — a held set's, or one of the last MAX_KEPT [ASSUMED 8]
//   dataOf(cs) / kittedOf(cs) / modesOf(cs) the merged data (the lobby checks a member's loadout and 自选 picks against
//                                          it), the operators a 自选 slot may field, the modes its plugins add
//   dataBytes(cs)                          the served bytes of every data file of the set — exactly the bytes the
//                                          builder hashed — which a match host worker checks against the set's hash
//                                          input and parses (server/match/host/entry.js)
// The builder is WP-A's C1 (server/plugins/contentSet.js buildContentSet / contentSetFiles, DESIGN §32.5); this file
// adapts its set to what P1c reads: `hashInput` (the contentHashOf input a browser and a worker recompute `cs` from — out
// of the set's index), `modes` (only the config.modes entries the vanilla data lacks, as { id, name, roomMode,
// difficulty }), `warnings` in room.state's `{ code, params }` shape, `dataBytes` (what the members download beyond the
// vanilla files). Until WP-A merged, a stub stood in (P1c's first commits).

import { ERR, DIFFICULTIES } from '../../shared/constants.js';
import { csUrlPart, isContentHash } from '../../shared/plugins/identity.js';
import { buildContentSet, contentSetFiles } from './contentSet.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
/** Content sets kept that no room holds (their /cs/ files stay servable a while). [ASSUMED] */
export const MAX_KEPT = 8;
/** Concurrent content sets with gameplay plugins rooms may hold (plugins/config.json limits.maxSets). [ASSUMED] */
export const DEFAULT_MAX_SETS = 4;

/**
 * @typedef {{ cs: string, plugins: { id: string, version: string, hash: string }[], modes: object[], data: Record<string, any>,
 *   hashInput: { app: string, sim: string, data: Record<string, string>, plugins: object[], settings: object },
 *   kitted: string[] | null, warnings: { code: string, params: object }[],
 *   served: Map<string, { body: Buffer, sha256: string, bytes: number }>, dataBytes: number }} ContentSet
 */

/** A C1 problem ({ code, path, message } or a string) as one line. */
const problemText = (p) => (p && typeof p === 'object' ? `${p.code || 'PLUGIN'}${p.plugin ? ` ${p.plugin}` : ''} ${p.path ?? ''}: ${p.message ?? ''}`.trim() : String(p));

/**
 * The modes a set's plugins add: its config.modes entries the vanilla data lacks — what room.setMode may choose
 * (room.state.content.modes): `{ id, name, roomMode: 'solo' | 'coop', difficulty }`.
 * @param {any[]} modes the set's config.modes records @param {Readonly<Record<string, any>>} vanillaData
 */
export function pluginModes(modes, vanillaData) {
  const official = vanillaData?.config?.modes && typeof vanillaData.config.modes === 'object' ? vanillaData.config.modes : {};
  return (Array.isArray(modes) ? modes : [])
    .filter((m) => m && typeof m.modeId === 'string' && !Object.hasOwn(official, m.modeId))
    .map((m) => ({
      id: m.modeId,
      name: typeof m.name === 'string' ? m.name.slice(0, 40) : m.modeId,
      roomMode: m.type === 'SINGLE' ? 'solo' : 'coop',
      difficulty: DIFFICULTIES.includes(m.difficulty) ? m.difficulty : null,
    }));
}

/**
 * The content sets of one server.
 * @param {{ registry: { plugin: (id: string) => any }, vanillaData: Readonly<Record<string, any>>, log?: object,
 *   maxSets?: () => number, build?: typeof buildContentSet, filesOf?: typeof contentSetFiles, maxKept?: number }} opts
 *   maxSets: the limit now (the server owner's policy may change it); build / filesOf: the C1 builder (tests inject one)
 */
export function createContentSets({ registry, vanillaData, log = noopLog, maxSets = () => DEFAULT_MAX_SETS,
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

  /** A built C1 set → a ContentSet (see the header). */
  function adopt(built) {
    const index = built.index || {};
    const served = filesOf(built);
    const data = {};
    let dataBytes = 0;
    for (const [name, f] of Object.entries(index.data || {})) {
      data[name] = f.sha256;
      if (typeof f.url === 'string' && f.url.startsWith('/cs/')) dataBytes += Number(f.bytes) || 0;
    }
    for (const f of Object.values(index.i18n || {})) if (typeof f?.url === 'string' && f.url.startsWith('/cs/')) dataBytes += Number(f.bytes) || 0;
    return {
      cs: built.cs, plugins: built.plugins || [], data: built.data,
      hashInput: { app: index.app, sim: index.sim, data, plugins: index.plugins || [], settings: index.settings || {} },
      modes: pluginModes(built.modes, vanillaData),
      kitted: Array.isArray(built.kitted) ? built.kitted : null,
      warnings: (Array.isArray(built.warnings) ? built.warnings : []).map((w) => (w && w.code === 'PLUGIN_PATCH_OVERRIDE'
        ? { code: 'override', params: { path: `data:${w.path}`, plugins: Array.isArray(w.plugins) ? w.plugins : [] } }
        : { code: String(w?.code || 'warning'), params: { ...(w || {}) } })),
      served, dataBytes,
    };
  }

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
      built = build({ registry, ids: ids.map((id) => (settings[id] ? { id, settings: settings[id] } : id)) });
    } catch (e) {
      log.error?.('[plugins] content set failed to build', e);
      return { error: ERR.INTERNAL, detail: 'the content set failed to build' };
    }
    if (!built || !isContentHash(built.cs) || (Array.isArray(built.problems) && built.problems.length)) {
      const list = Array.isArray(built?.problems) ? built.problems : [];
      const why = list.length ? list.slice(0, 4).map(problemText).join('; ') : 'no content set';
      log.warn?.(`[plugins] content set of ${ids.join(', ')} refused: ${why}`);
      // a load-order problem keeps its own code (PLUGIN_DEPENDENCY / PLUGIN_CONFLICT); any other problem of the data is
      // a set this server cannot make
      const code = list.find((p) => p && Object.hasOwn(ERR, p.code))?.code;
      return { error: code || ERR.PLUGIN_BLOCKED, detail: why.slice(0, 200) };
    }
    const key = csUrlPart(built.cs);
    let set = sets.get(key);
    if (!set || set.cs !== built.cs) set = adopt(built);
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
    /** The modes its plugins add. @param {string} cs */
    modesOf: (cs) => byCs(cs)?.modes || [],
    /**
     * A file of a kept set as /cs/<cs16>/<rel> serves it (index.json, data/<table>.json, i18n/<lang>.json), or null.
     * @param {string} cs16 @param {string} rel
     * @returns {{ body: Buffer, sha256: string | null, type: string } | null}
     */
    file(cs16, rel) {
      const set = sets.get(cs16);
      const f = set ? set.served.get(rel) : null;
      return f ? { body: f.body, sha256: rel === 'index.json' ? null : f.sha256, type: 'application/json; charset=utf-8' } : null;
    },
    /**
     * The served bytes of every data file of the set of `cs`, by table name (the names of its hash input) — null for a set
     * not kept; a table the builder served no body for is left out (the worker then refuses the set).
     * @param {string} cs
     * @returns {Record<string, Buffer> | null}
     */
    dataBytes(cs) {
      const set = byCs(cs);
      if (!set) return null;
      const out = {};
      for (const name of Object.keys(set.hashInput.data)) {
        const f = set.served.get(`data/${name}.json`);
        if (f) out[name] = f.body;
        else log.warn?.(`[plugins] content set ${cs.slice(0, 8)} serves no data/${name}.json`);
      }
      return out;
    },
    /** Content sets rooms hold now (/healthz content.sets). */
    inUse: () => held.size,
    stats: () => ({ sets: sets.size, held: held.size }),
  };
}
