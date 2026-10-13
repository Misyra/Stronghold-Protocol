// server/plugins/contentSetStub.js — STUB of WP-A's server/plugins/contentSet.js (handoff 030-plan C1), written for P1c
// (DESIGN §32.6) while the data plugins (P1b) are built on another branch. REPLACE WHEN WP-A MERGES: server/plugins/
// contentSets.js then imports buildContentSet / contentSetFiles from './contentSet.js' and this file goes.
//
// The C1 interface it follows:
//   buildContentSet({ registry, ids, … }) → { cs, vanilla, plugins: [{ id, version, hash }], data: { <name>: object },
//     files: { <rel>: { sha256, bytes } }, modes: [...], problems: [...] } — the content set of the content plugins `ids`
//     (already closed over their requirements and in load order: shared/plugins/order.js); `cs` in the composition of
//     shared/plugins/identity.js (the vanilla set's `cs` unchanged); no set when there is a problem (`problems`, cs null)
//   contentSetFiles(set) → what the /cs/<cs16>/… routes serve (server/http/static.js)
// What the stub does — "the vanilla data plus the plugin list" (the WP-B task): `data` is the server's vanilla data, and
// `cs` names the vanilla data hashes plus every plugin's id, version and gameplay files (plugin.json and every file its
// manifest names) and its normalised settings — so a content set is a content set of its own (its own `cs`, its own
// worker, the client's byte check, the BattleSpec / b.result cs check), but its battles are the vanilla ones. One
// exception, so that room.setMode has something to choose: a `modes` file (the design study's 附录 B shape
// `{ mode: 1, id, base, roomMode: 'coop' | 'solo', difficulty, name, set }`) becomes config.modes[id] — a copy of the
// official mode `base`, renamed, with `set`'s top-level fields over it — which makes data/config.json a patched file of
// the set (served from memory at /cs/<cs16>/data/config.json, its bytes JSON.stringify of the merged config) [STUB].
// Fields beyond C1 that P1c reads (WP-A's set needs them too, or server/plugins/contentSets.js adapts):
//   hashInput   the exact contentHashOf input ({ app, sim, data: { <name>: sha256 }, plugins: [{ id, version, files }],
//               settings }) — the client recomputes `cs` from /cs/<cs16>/index.json with it, the worker checks it
//   kitted      the operators a 自选 slot may field in this set (null = the vanilla list, server/sim/content/kits)
//   bodies      the served bytes of every patched file (rel → Buffer), not enumerable

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DIFFICULTIES } from '../../shared/constants.js';
import { declaredPaths } from '../../shared/plugins/manifest.js';
import { CONTENT_HASH_VERSION, canonicalJson, contentHashOf, csUrlPart } from '../../shared/plugins/identity.js';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const MODE_ID = /^mode_[A-Za-z0-9_]{1,58}$/;

/**
 * A plugin's settings as the room gave them, normalised against its manifest's definitions (shared/plugins/manifest.js
 * readSetting): a value of the right type within its range / options, else the default; keys it does not define left
 * out. {} for a plugin without settings.
 * @param {Record<string, any>} defs @param {Record<string, unknown> | undefined} given
 */
export function normalizeSettings(defs, given) {
  const out = {};
  for (const [key, d] of Object.entries(isObj(defs) ? defs : {})) {
    const v = isObj(given) && Object.hasOwn(given, key) ? given[key] : undefined;
    let ok = false;
    if (d.type === 'boolean') ok = typeof v === 'boolean';
    else if (d.type === 'enum') ok = Array.isArray(d.options) && d.options.includes(v);
    else if (d.type === 'integer' || d.type === 'number') {
      ok = typeof v === 'number' && Number.isFinite(v) && v >= d.min && v <= d.max && (d.type !== 'integer' || Number.isInteger(v))
        && (!(d.step > 0) || Math.abs((v - d.min) / d.step - Math.round((v - d.min) / d.step)) < 1e-9);
    }
    out[key] = ok ? v : d.default;
  }
  return out;
}

/** A mode file's entry (the design study's 附录 B shape), checked against the vanilla config — or a problem. */
function readMode(json, config, where) {
  if (!isObj(json)) return { problem: `${where}: not a mode object` };
  const { id, base, roomMode, difficulty, name, set } = json;
  if (typeof id !== 'string' || !MODE_ID.test(id)) return { problem: `${where}: "id" must be mode_<letters, digits, _>` };
  if (isObj(config?.modes) && Object.hasOwn(config.modes, id)) return { problem: `${where}: "${id}" is an official mode` };
  if (typeof base !== 'string' || !isObj(config?.modes?.[base])) return { problem: `${where}: "base" must name an official mode` };
  if (roomMode !== 'coop' && roomMode !== 'solo') return { problem: `${where}: "roomMode" must be "coop" or "solo"` };
  if (!DIFFICULTIES.includes(difficulty)) return { problem: `${where}: "difficulty" must be one of ${DIFFICULTIES.join(', ')}` };
  if (set !== undefined && !isObj(set)) return { problem: `${where}: "set" must be an object of mode fields` };
  const names = typeof name === 'string' ? { zh: name } : isObj(name) ? Object.fromEntries(Object.entries(name).filter(([k, v]) => /^[a-z]{2}(-[A-Z]{2})?$/.test(k) && typeof v === 'string' && v).map(([k, v]) => [k, v.slice(0, 40)])) : {};
  if (!Object.keys(names).length) return { problem: `${where}: "name" is missing` };
  return { mode: { id, base, roomMode, difficulty, name: names, set: set || {} } };
}

/**
 * The content set of the content plugins `ids` (see the header) [STUB].
 * @param {{ registry: { plugin: (id: string) => any }, ids: string[], settings?: Record<string, Record<string, unknown>>,
 *   vanilla: import('./identity.js').VanillaContent, vanillaData: Readonly<Record<string, any>>, pluginsDir: string }} opts
 *   vanilla: this server's vanilla content (hashes); vanillaData: its parsed data (server/data.js); pluginsDir: plugins/
 */
export function buildContentSet({ registry, ids, settings = {}, vanilla, vanillaData, pluginsDir }) {
  const problems = [];
  const plugins = [];
  const hashPlugins = [];
  const normSettings = {};
  const modes = [];
  for (const id of ids) {
    const p = registry.plugin(id);
    // the registry of this branch lists the content class as `planned` (WP-A makes it `loaded`) [STUB]
    if (!p || p.class !== 'content' || (p.status !== 'loaded' && p.status !== 'planned')) { problems.push(`${id}: not a content plugin of this server`); continue; }
    const dir = path.join(pluginsDir, id);
    /** @type {Record<string, string>} */
    const files = {};
    for (const rel of ['plugin.json', ...declaredPaths(p.manifest).map((d) => d.rel)]) {
      if (Object.hasOwn(files, rel)) continue;
      try { files[rel] = sha256(fs.readFileSync(path.join(dir, ...rel.split('/')))); } catch (e) { problems.push(`${id}: ${rel} cannot be read (${e?.code || e?.message || e})`); }
    }
    for (const rel of p.manifest.parts?.modes?.files || []) {
      let json;
      try { json = JSON.parse(fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8')); } catch (e) { problems.push(`${id}: ${rel} is not JSON (${e?.message || e})`); continue; }
      for (const [i, entry] of (Array.isArray(json) ? json : [json]).entries()) {
        const r = readMode(entry, vanillaData.config, `${id}: ${rel}${Array.isArray(json) ? `[${i}]` : ''}`);
        if (r.problem) problems.push(r.problem);
        else if (modes.some((m) => m.id === r.mode.id)) problems.push(`${id}: the mode ${r.mode.id} twice`);
        else modes.push({ ...r.mode, plugin: id });
      }
    }
    const version = p.manifest.version;
    const s = normalizeSettings(p.manifest.settings, settings[id]);
    if (Object.keys(s).length) normSettings[id] = s;
    hashPlugins.push({ id, version, files });
    plugins.push({ id, version, hash: sha256(canonicalJson({ id, version, files, settings: s })).slice(0, 16) });
  }
  if (problems.length) return { cs: null, vanilla: false, plugins, data: null, files: {}, modes: [], problems };

  /** @type {Record<string, any>} */
  const data = { ...vanillaData };
  /** @type {Record<string, { sha256: string, bytes: number }>} */
  const files = {};
  /** @type {Record<string, Buffer>} */
  const bodies = {};
  const dataHashes = Object.fromEntries(Object.entries(vanilla.data).map(([k, v]) => [k, v.sha256]));
  if (modes.length) {
    const cfg = JSON.parse(JSON.stringify(vanillaData.config));
    for (const m of modes) {
      cfg.modes[m.id] = { ...cfg.modes[m.base], ...m.set, modeId: m.id, name: m.name.zh || Object.values(m.name)[0], difficulty: m.difficulty, type: m.roomMode === 'solo' ? 'SINGLE' : 'MULTI' };
    }
    const body = Buffer.from(JSON.stringify(cfg));
    const h = sha256(body);
    data.config = cfg;
    files['data/config.json'] = { sha256: h, bytes: body.length };
    bodies['data/config.json'] = body;
    dataHashes.config = h;
  }
  const hashInput = { v: CONTENT_HASH_VERSION, app: vanilla.app, sim: vanilla.sim, data: dataHashes, plugins: hashPlugins, settings: normSettings };
  const cs = contentHashOf(hashInput);
  const set = {
    cs, vanilla: false, plugins, data, files, problems: [],
    modes: modes.map((m) => ({ id: m.id, name: m.name, roomMode: m.roomMode, difficulty: m.difficulty, base: m.base, plugin: m.plugin })),
    hashInput, kitted: null,
  };
  Object.defineProperty(set, 'bodies', { value: bodies, enumerable: false });
  return set;
}

/**
 * What the /cs/<cs16>/… routes serve of a set [STUB of C1 contentSetFiles]: `index` — the body of
 * /cs/<cs16>/index.json, the shape of the vanilla one (server/plugins/identity.js contentIndexOf) with `vanilla: false`,
 * the plugins and settings of the composition, the modes and the 自选 list: every data file's URL (a file the set did not
 * change: its plain URL /data/<file>?v=<8 hex>; a patched one: /cs/<cs16>/data/<file>), sha256 and size — and `files`,
 * the patched files' bodies by their path under /cs/<cs16>/.
 * @param {any} set a buildContentSet result
 * @param {import('./identity.js').VanillaContent} vanilla
 * @returns {{ index: Record<string, unknown>, files: Map<string, { body: Buffer, sha256: string, bytes: number }> }}
 */
export function contentSetFiles(set, vanilla) {
  const cs16 = csUrlPart(set.cs);
  const data = {};
  for (const [name, f] of Object.entries(vanilla.data)) {
    const rel = `data/${f.file}`;
    const patched = set.files[rel];
    data[name] = patched
      ? { url: `/cs/${cs16}/${rel.split('/').map(encodeURIComponent).join('/')}`, sha256: patched.sha256, bytes: patched.bytes }
      : { url: `/data/${encodeURIComponent(f.file)}?v=${f.sha256.slice(0, 8)}`, sha256: f.sha256, bytes: f.bytes };
  }
  const h = set.hashInput;
  const index = {
    v: h.v, cs: set.cs, app: h.app, vanilla: false, sim: h.sim, simFiles: { ...vanilla.simFiles }, data,
    plugins: h.plugins, settings: h.settings, modes: set.modes, kitted: set.kitted ?? null,
  };
  const files = new Map();
  for (const [rel, f] of Object.entries(set.files)) files.set(rel, { body: set.bodies[rel], sha256: f.sha256, bytes: f.bytes });
  return { index, files };
}
