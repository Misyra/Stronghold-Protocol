// server/plugins/visualSet.js — the visual sets of this server (DESIGN §32 P1a, docs/PLUGINS.md §5; the format:
// shared/plugins/visual.js): a set of loaded cosmetic plugins, closed over their requirements and in load order
// (shared/plugins/order.js), named by its visual hash `vs`, and the two documents it is served as —
//
//   GET /vs/<vs16>/assets.json    the effective manifest: the served data/assets.json (server/http/assetViews.js — its
//                                 /assets/~<hash>/… URLs; the committed file until the asset index is ready, or without
//                                 one) with the set's overlays laid over it in load order, and the set's composition in
//                                 `visual` — what a room member's page draws with (public/js/content.js)
//   GET /vs/<vs16>/overlay.json   the overlay alone: `{ visual, ops }`, the resolved writes (shared/plugins/visual.js
//                                 applyOps) — a player's personal plugin is the set of that plugin alone (the catalogue's
//                                 `vs` of it), laid over whatever the page draws with
//
// Both answer `no-cache` with their body's hash as ETag, like the served manifests: the installation's URLs inside follow
// the asset index, not `vs` [ASSUMED: not immutable as the design study had it — 0.2.6's content-hashed asset URLs came
// after it]. A set is known once something resolved it — a room's host chose it (resolve) or a browser asked for the
// set of one plugin the catalogue named — and holds the plugins as they were then: a plugin changed on disk afterwards
// is served at its new bytes under the old URL with `no-cache` (server/http/static.js), a removed one's files 404. The
// 256 most recently used sets are kept and the documents of the last 8 built [ASSUMED]. A set holds only loaded cosmetic
// plugins of the scope it is for (room / personal), and serves VISUAL_LIMITS.setBytes (300 MB) of art at most [ASSUMED].
// Nothing here changes a battle: a room's `cs` stays the vanilla one whatever its visual set.

import { createHash } from 'node:crypto';
import { ERR } from '../../shared/constants.js';
import { resolvePluginOrder } from '../../shared/plugins/order.js';
import {
  VISUAL_HASH_VERSION, VISUAL_LIMITS, applyOps, mergePluginOps, resolveOps, visualHashOf, vsUrlPart,
} from '../../shared/plugins/visual.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
/** Sets kept by vs16, most recently used last. */
const MAX_SETS = 256;
/** Built documents kept. */
const MAX_DOCS = 8;

const hash16 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

/**
 * @typedef {import('./registry.js').Plugin} Plugin
 * @typedef {{ id: string, version: string, class: 'cosmetic', hash: string, auto?: true }} SetPlugin
 *   a plugin of a room's set as room.state.content lists it (auto: switched on because another needs it)
 * @typedef {{ code: string, params: Record<string, unknown> }} SetWarning
 *   `override` { path, plugins: [earlier, later] } — two plugins change the same thing, the later applies;
 *   `app` { id, app } — a plugin made for other game versions (a cosmetic one is still allowed: only a warning)
 * @typedef {{ vs: string, plugins: SetPlugin[], warnings: SetWarning[], bytes: number }} VisualSet
 * @typedef {{ vs: string, assets: string, overlays: import('../../shared/plugins/visual.js').VisualOverlay[],
 *   plugins: { id: string, ops: import('../../shared/plugins/visual.js').AssetOp[], shas: Record<string, string> }[] }} KnownSet
 */

/**
 * The visual sets of one server.
 * @param {{ registry: ReturnType<typeof import('./registry.js').createPluginRegistry>,
 *   views?: ReturnType<typeof import('../http/assetViews.js').createManifestViews> | null, log?: object,
 *   limits?: { setBytes: number, warnings: number } }} opts
 *   registry: the plugin registry (its loaded cosmetic plugins, the installation's art manifest); views: the served
 *   manifests (none: the committed data/assets.json is the base)
 */
export function createVisualSets({ registry, views = null, log = noopLog, limits = VISUAL_LIMITS }) {
  /** @type {Map<string, KnownSet>} */
  const sets = new Map();
  /** @type {Map<string, { body: Buffer, hash: string }>} */
  const docs = new Map();
  /** @type {{ hash: string, doc: any } | null} the last parsed view of data/assets.json */
  let parsedView = null;
  const warned = new Set();

  const remember = (key, set) => {
    sets.delete(key);
    sets.set(key, set);
    while (sets.size > MAX_SETS) sets.delete(sets.keys().next().value);
  };
  const snapshot = (p) => ({ id: p.id, ops: p.visual.ops, shas: Object.fromEntries([...p.visual.served].map(([rel, f]) => [rel, f.sha256])) });
  /** Is `p` a loaded cosmetic plugin with an overlay (of `scope`, when given)? */
  const usable = (p, scope) => !!p && p.class === 'cosmetic' && p.status === 'loaded' && !!p.visual && (!scope || p.manifest.scope.includes(scope));

  /**
   * The set of the plugins `ids` asks for, as a room (or a player) would use it: each a loaded cosmetic plugin of
   * `scope`, their requirements switched on, in load order, within the size limit; remembered by its vs16.
   * @param {string[]} ids
   * @param {{ scope?: 'room' | 'personal' }} [opts]
   * @returns {{ ok: true, set: VisualSet } | { error: string, detail: string }}
   */
  function resolve(ids, { scope = 'room' } = {}) {
    const art = registry.vanillaAssets();
    if (!art || !art.sha256) return { error: ERR.PLUGIN_UNKNOWN, detail: 'this server has no art manifest (data/assets.json)' };
    for (const id of ids) {
      const p = registry.plugin(id);
      if (!p) return { error: ERR.PLUGIN_UNKNOWN, detail: `${String(id).slice(0, 40)} is not installed` };
      if (!usable(p, scope)) return { error: ERR.PLUGIN_BLOCKED, detail: `${id} is not a cosmetic plugin of scope ${scope} this version loads` };
    }
    const lookup = (id) => { const p = registry.plugin(id); return usable(p, scope) ? { id: p.id, ...p.manifest } : null; };
    const r = resolvePluginOrder(ids, lookup);
    if ('error' in r) return { error: ERR[r.error] || ERR.BAD_MSG, detail: r.detail };
    const list = r.order.map((id) => /** @type {Plugin} */ (registry.plugin(id)));
    const bytes = list.reduce((n, p) => n + p.visual.bytes, 0);
    if (bytes > limits.setBytes) return { error: ERR.PLUGIN_LIMIT, detail: `${Math.ceil(bytes / 1048576)} MB of art, more than ${Math.floor(limits.setBytes / 1048576)} MB` };
    const merged = mergePluginOps(list.map((p) => ({ id: p.id, ops: p.visual.ops })));
    /** @type {SetWarning[]} */
    const warnings = [
      ...list.filter((p) => !p.manifest.compatible).map((p) => ({ code: 'app', params: { id: p.id, app: p.manifest.app } })),
      ...merged.warnings,
    ].slice(0, limits.warnings);
    const overlays = list.map((p) => p.visual.composition);
    const vs = visualHashOf({ assets: art.sha256, overlays });
    remember(vsUrlPart(vs), { vs, assets: art.sha256, overlays, plugins: list.map(snapshot) });
    return {
      ok: true,
      set: {
        vs,
        plugins: list.map((p) => ({ id: p.id, version: p.manifest.version, class: 'cosmetic', hash: p.visual.hash, ...(r.auto.includes(p.id) ? { auto: true } : {}) })),
        warnings,
        bytes,
      },
    };
  }

  /** The set a vs16 names: a remembered one, or the set of one loaded cosmetic plugin alone (the catalogue's `vs`). */
  function known(vs16) {
    const hit = sets.get(vs16);
    if (hit) { remember(vs16, hit); return hit; }
    const art = registry.vanillaAssets();
    for (const p of registry.plugins('cosmetic')) {
      if (!usable(p) || !p.visual.vs || vsUrlPart(p.visual.vs) !== vs16 || !art?.sha256) continue;
      const set = { vs: p.visual.vs, assets: art.sha256, overlays: [p.visual.composition], plugins: [snapshot(p)] };
      remember(vs16, set);
      return set;
    }
    return null;
  }

  /** The manifest the documents are built on: the served view of data/assets.json, else the committed file. */
  async function base() {
    const view = views ? await views.get('assets.json') : null;
    if (view) {
      if (!parsedView || parsedView.hash !== view.hash) parsedView = { hash: view.hash, doc: JSON.parse(view.body.toString('utf8')) };
      return parsedView;
    }
    const art = registry.vanillaAssets();
    return art?.manifest ? { hash: `file-${String(art.sha256).slice(0, 16)}`, doc: art.manifest } : null;
  }

  /**
   * A set's document (see the header), built on first request.
   * @param {string} vs16 the first 16 hex digits of its vs
   * @param {'assets' | 'overlay'} kind
   * @returns {Promise<{ body: Buffer, hash: string } | null>} null for a set this server does not know
   */
  async function doc(vs16, kind) {
    const set = known(vs16);
    if (!set) return null;
    const b = await base();
    if (!b) return null;
    const key = `${vs16}|${kind}|${b.hash}`;
    const hit = docs.get(key);
    if (hit) { docs.delete(key); docs.set(key, hit); return hit; }
    const ops = [];
    for (const p of set.plugins) {
      const r = resolveOps(p.ops, { id: p.id, sha: (rel) => p.shas[rel] ?? null, base: b.doc });
      ops.push(...r.ops);
      for (const why of r.problems) {
        const line = `[plugins] ${p.id}: ${why} (left out of set ${vs16})`;
        if (!warned.has(line)) { warned.add(line); log.warn?.(line); }
      }
    }
    const visual = { v: VISUAL_HASH_VERSION, vs: set.vs, assets: set.assets, overlays: set.overlays };
    const out = kind === 'assets' ? { ...applyOps(b.doc, ops), visual } : { visual, ops };
    const body = Buffer.from(JSON.stringify(out));
    const built = { body, hash: hash16(body) };
    docs.set(key, built);
    while (docs.size > MAX_DOCS) docs.delete(docs.keys().next().value);
    return built;
  }

  return {
    resolve,
    doc,
    /** A file a loaded cosmetic plugin serves (registry pluginFile). @param {string} id @param {string} rel */
    file: (id, rel) => registry.pluginFile(id, rel),
    /** A served file was found changed on disk: the registry reads the folders again (at most every 5 s). */
    noteChanged: (() => {
      let at = -Infinity;
      return () => {
        const now = Date.now();
        if (now - at < 5000) return;
        at = now;
        setImmediate(() => { try { registry.rescan?.(); } catch (e) { log.error?.('[plugins] rescan failed', e); } });
      };
    })(),
    stats: () => ({ sets: sets.size, docs: docs.size }),
  };
}
