#!/usr/bin/env node
// tools/plugin.mjs — the plugins of a checkout (DESIGN §32, docs/PLUGINS.md; the registry the server runs is
// server/plugins/registry.js, the format shared/plugins/manifest.js):
//
//   node tools/plugin.mjs list [--json]                  every plugin and language pack the registry finds — plugins/,
//                                                        packs/, the language folders — by class with its status, what
//                                                        was skipped and why, the warnings, and the vanilla content hash
//   node tools/plugin.mjs check [<dir|id> …] [--strict]   check plugin folders (default: every folder of plugins/ but the
//                                                        `_` templates): the manifest (manifest 2, its class, the parts
//                                                        and permissions), the files (types by class, sizes, counts,
//                                                        every path the manifest names, inside the folder), every JSON
//                                                        file (valid, nesting ≤ 64, numbers finite within ±1e9) and a
//                                                        cosmetic plugin's asset overlay (shared/plugins/visual.js: its
//                                                        shape, files, references to this checkout's data/assets.json,
//                                                        permissions, plugin.lock.json for its Spine models). Exit 1 on a
//                                                        problem, with --strict on a warning too
//   node tools/plugin.mjs pack <dir|id> …                 write plugin.lock.json for a cosmetic plugin: every file's
//                                                        SHA-256 and size, and each Spine model's clip data — the
//                                                        skeleton parsed like tools/fetch-assets.mjs parses the game's
//                                                        (tools/assets/skel.mjs, anim-roles.mjs: roles, durations,
//                                                        events, hits, bounds), its atlas pages matched against
//                                                        `textures` — then check the folder. Run it again after a change
//                                                        to a skeleton: the server refuses a lock made from another one
//   --root <dir>   another checkout or an unpacked release (default: this checkout)
//
// A language pack's strings are checked by node tools/i18n.mjs check <code> (docs/I18N.md); tools/packs.mjs keeps the
// pack commands of 0.2.0 (list, index, check).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { scanPlugins, pluginIndexOf, readPluginFolder, listPluginFiles, readVanillaAssets } from '../server/plugins/registry.js';
import { computeVanillaContent } from '../server/plugins/identity.js';
import { DATA_SHIM_JS } from '../server/http/static.js';
import { PLUGIN_CLASSES, PLUGIN_LIMITS, PLUGIN_MANIFEST, checkJsonLimits, extOf, readPluginManifest } from '../shared/plugins/manifest.js';
import { LOCK_FILE, LOCK_VERSION, readAssetOverlay } from '../shared/plugins/visual.js';
import { parseSkel } from './assets/skel.mjs';
import { resolveRoles } from './assets/anim-roles.mjs';
import { atlasInfo } from './assets/atlas.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: node tools/plugin.mjs list [--json] | check [<dir|id> …] [--strict] | pack <dir|id> …   [--root <dir>]';

/** The folders the registry reads in a checkout. @param {string} root */
export const pluginDirs = (root) => ({
  publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data'), packsDir: path.join(root, 'packs'), pluginsDir: path.join(root, 'plugins'),
});

/** The vanilla content of a checkout (server/plugins/identity.js). @param {string} root */
export const vanillaOf = (root) => computeVanillaContent({
  simDir: path.join(root, 'server', 'sim'), sharedDir: path.join(root, 'shared'), dataDir: path.join(root, 'data'), shim: DATA_SHIM_JS,
});

const files = (n) => `${n} file${n === 1 ? '' : 's'}`;
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);

/**
 * Check one plugin folder: the registry's rules (readPluginFolder — for a cosmetic plugin its asset overlay too) and
 * every JSON file's content.
 * @param {string} dir
 * @param {string} where how the folder is named in the output
 * @param {{ vanilla?: import('../server/plugins/registry.js').VanillaAssets }} [opts] vanilla: the art manifest references
 *   must name (default: none — they are not checked)
 * @returns {{ where: string, plugin: import('../server/plugins/registry.js').Plugin | null, problems: string[], warnings: string[] }}
 */
export function checkPluginFolder(dir, where, { vanilla } = {}) {
  const r = readPluginFolder(dir, { where, vanilla });
  const problems = [...r.problems];
  const warnings = [...r.warnings];
  if (fs.existsSync(path.join(dir, 'plugin.json'))) {
    for (const f of listPluginFiles(dir)) {
      if (f.link || extOf(f.rel) !== '.json' || f.bytes > PLUGIN_LIMITS.jsonBytes) continue;
      let json;
      try { json = JSON.parse(fs.readFileSync(path.join(dir, ...f.rel.split('/')), 'utf8')); } catch (e) {
        problems.push(`${f.rel}: not valid JSON (${e instanceof SyntaxError ? e.message : e?.code || e})`);
        continue;
      }
      const bad = checkJsonLimits(json);
      if (bad) problems.push(`${f.rel}: ${bad}`);
    }
  }
  return { where, plugin: problems.length ? null : r.plugin, problems, warnings };
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** The skill indices a model's roles are resolved for, by the container of its overlay entry (as fetch-assets does). */
const roleOptions = (container) => (container === 'enemies' ? { skillIndices: [0], numberedSkills: true } : container === 'chars' ? { skillIndices: [0, 1, 2] } : { skillIndices: [0] });

/**
 * The lock file of a plugin folder (see the header): every file's SHA-256 and size (not the lock's own, no dot file),
 * and — for a cosmetic plugin — the clip data of each Spine model its overlay names.
 * @param {string} dir
 * @returns {{ lock: Record<string, unknown> | null, problems: string[], warnings: string[] }}
 */
export function buildPluginLock(dir) {
  const problems = [];
  const warnings = [];
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, PLUGIN_MANIFEST), 'utf8')); } catch (e) {
    return { lock: null, problems: [`${PLUGIN_MANIFEST}: ${e instanceof SyntaxError ? `not valid JSON (${e.message})` : e?.code || e}`], warnings };
  }
  const { manifest, problems: mp } = readPluginManifest(raw, { id: path.basename(dir) });
  if (!manifest) return { lock: null, problems: mp, warnings };
  const listed = listPluginFiles(dir).filter((f) => !f.link && f.rel !== LOCK_FILE);
  const files = {};
  for (const f of listed) files[f.rel] = { sha256: sha256(fs.readFileSync(path.join(dir, ...f.rel.split('/')))), bytes: f.bytes };
  const spine = {};
  const part = manifest.parts.assets;
  if (manifest.class === 'cosmetic' && part) {
    let assets = part.inline;
    if (!assets) {
      try { assets = JSON.parse(fs.readFileSync(path.join(dir, ...part.files[0].split('/')), 'utf8')); } catch (e) { problems.push(`${part.files[0]}: ${e?.message || e}`); }
    }
    const ov = readAssetOverlay(assets, { has: (rel) => Object.hasOwn(files, rel) });
    problems.push(...ov.problems);
    for (const op of ov.ops) {
      if (!op.spine || spine[op.spine.skel]) continue;
      const s = op.spine;
      try {
        const info = atlasInfo(fs.readFileSync(path.join(dir, ...s.atlas.split('/')), 'utf8'));
        const folder = s.atlas.replace(/[^/]*$/, '');
        const pages = info.pages.map((p) => folder + p);
        for (const p of pages) if (!s.textures.includes(p)) problems.push(`${s.atlas}: its page ${p} is not in "textures" (a page the server is not told about is never served)`);
        for (const t of s.textures) if (!pages.includes(t)) warnings.push(`${s.skel}: "textures" names ${t}, which its atlas does not use`);
        const bytes = fs.readFileSync(path.join(dir, ...s.skel.split('/')));
        const sk = parseSkel(new Uint8Array(bytes), info.regions);
        if (!sk.animations.length) { problems.push(`${s.skel}: the skeleton has no animations`); continue; }
        if (sk.missingRegions.length) warnings.push(`${s.skel}: ${sk.missingRegions.length} attachment(s) not in its atlas (e.g. ${sk.missingRegions[0]})`);
        spine[s.skel] = {
          sha256: sha256(bytes), anims: resolveRoles(sk.animations, { ...roleOptions(op.at[0]), durations: sk.durations }),
          animations: sk.durations, events: sk.events, hits: sk.hits, bounds: sk.bounds,
        };
      } catch (e) {
        problems.push(`${s.skel}: not a Spine 3.8 skeleton the client can read (${String(e?.message || e).slice(0, 120)})`);
      }
    }
  }
  return { lock: { lock: LOCK_VERSION, id: manifest.id, version: manifest.version, generator: 'tools/plugin.mjs pack', files, spine }, problems, warnings };
}

/**
 * The CLI.
 * @param {string[]} argv
 * @returns {Promise<number>} the exit code
 */
export async function main(argv) {
  const [cmd, ...rest] = argv;
  let root = REPO;
  const flags = new Set();
  const targets = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--root') {
      const v = rest[++i];
      if (!v || v.startsWith('--')) { console.error(`plugin: --root needs a path\n${USAGE}`); return 2; }
      root = path.resolve(v);
    } else if (a.startsWith('--')) flags.add(a.slice(2));
    else targets.push(a);
  }
  const dirs = pluginDirs(root);

  if (cmd === 'list') {
    if (targets.length) { console.error(`plugin: list takes no folder\n${USAGE}`); return 2; }
    const scan = scanPlugins(dirs);
    const content = vanillaOf(root);
    if (flags.has('json')) {
      console.log(JSON.stringify({ index: pluginIndexOf(scan.plugins, { vanilla: content.cs }), skipped: scan.skipped, warnings: scan.warnings }, null, 2));
      return 0;
    }
    console.log(`vanilla content: ${content.cs} (${Object.keys(content.simFiles).length} code files, ${Object.keys(content.data).length} data files)`);
    for (const [cls, kind] of Object.entries(PLUGIN_CLASSES)) {
      const list = scan.plugins.filter((p) => p.class === cls);
      console.log(`${cls} (${kind.status}: ${kind.summary}): ${list.length ? '' : 'none'}`);
      for (const p of list) {
        const m = p.manifest;
        const lang = cls === 'lang' ? ` ${m.lang}${m.fallback?.length ? ` → ${m.fallback.join(' → ')}` : ''}` : '';
        const extra = [m.version && `v${m.version}`, m.app && `app ${m.app}${m.compatible ? '' : ' (not this version)'}`, p.status !== 'loaded' && p.status,
          kind.unofficial && 'unofficial', p.strings !== undefined && `${p.strings} strings`, p.files.data && 'game texts',
          Number.isFinite(p.count) && `${files(p.count)}, ${kb(p.bytes)}`].filter(Boolean).join(', ');
        console.log(`  ${p.id.padEnd(16)} ${m.name}${m.englishName !== m.name ? ` (${m.englishName})` : ''}${lang}  — ${p.where}${extra ? `; ${extra}` : ''}`);
      }
    }
    for (const k of scan.skipped) console.log(`skipped  ${k.where}: ${k.problems.join('; ')}`);
    for (const w of scan.warnings) console.log(`warning  ${w.where}: ${w.warning}`);
    return 0;
  }

  if (cmd === 'pack') {
    if (!targets.length) { console.error(`plugin: pack needs a plugin folder\n${USAGE}`); return 2; }
    let failed = 0;
    for (const t of targets) {
      const asDir = path.resolve(t);
      const inPlugins = path.join(dirs.pluginsDir, t);
      const dir = fs.existsSync(path.join(asDir, PLUGIN_MANIFEST)) ? asDir : fs.existsSync(path.join(inPlugins, PLUGIN_MANIFEST)) ? inPlugins : null;
      if (!dir) { console.error(`plugin: ${t} is not a plugin folder (no ${PLUGIN_MANIFEST})`); return 2; }
      const r = buildPluginLock(dir);
      for (const x of r.problems) console.log(`  problem  ${x}`);
      for (const x of r.warnings) console.log(`  warning  ${x}`);
      if (!r.lock || r.problems.length) { console.log(`${t}: ${LOCK_FILE} not written`); failed++; continue; }
      fs.writeFileSync(path.join(dir, LOCK_FILE), `${JSON.stringify(r.lock, null, 2)}\n`);
      const nFiles = Object.keys(/** @type {any} */ (r.lock).files).length;
      const nModels = Object.keys(/** @type {any} */ (r.lock).spine).length;
      console.log(`${t}: wrote ${LOCK_FILE} (${files(nFiles)}, ${nModels} Spine model${nModels === 1 ? '' : 's'})`);
      const c = checkPluginFolder(dir, `${t}/`, { vanilla: readVanillaAssets(dirs.dataDir) });
      for (const x of c.problems) console.log(`  problem  ${x}`);
      for (const x of c.warnings) console.log(`  warning  ${x}`);
      if (c.problems.length) failed++;
      else console.log('  check: ok');
    }
    return failed ? 1 : 0;
  }

  if (cmd === 'check') {
    /** @type {{ dir: string, where: string }[]} */
    const folders = [];
    if (!targets.length) {
      let names = [];
      try { names = fs.readdirSync(dirs.pluginsDir).sort(); } catch { /* no plugins/ */ }
      for (const n of names) {
        if (n.startsWith('_') || n.startsWith('.')) continue;
        const dir = path.join(dirs.pluginsDir, n);
        try { if (fs.statSync(dir).isDirectory()) folders.push({ dir, where: `plugins/${n}/` }); } catch { /* gone */ }
      }
    }
    for (const t of targets) {
      const asDir = path.resolve(t);
      const inPlugins = path.join(dirs.pluginsDir, t);
      const dir = fs.existsSync(asDir) && fs.statSync(asDir).isDirectory() ? asDir : fs.existsSync(inPlugins) && fs.statSync(inPlugins).isDirectory() ? inPlugins : null;
      if (!dir) { console.error(`plugin: ${t} is neither a folder nor a plugin in ${path.relative(process.cwd(), dirs.pluginsDir) || dirs.pluginsDir}`); return 2; }
      const rel = path.relative(root, dir).split(path.sep).join('/');
      folders.push({ dir, where: `${rel && !rel.startsWith('..') ? rel : dir}/` });
    }
    if (!folders.length) { console.log('no plugin folders to check (plugins/ holds none)'); return 0; }
    let problems = 0;
    let warnings = 0;
    const vanilla = readVanillaAssets(dirs.dataDir);
    for (const { dir, where } of folders) {
      const r = checkPluginFolder(dir, where, { vanilla });
      const p = r.plugin;
      const head = p ? `${p.id} ${p.manifest.version} · ${p.class} (${p.status}) · ${files(p.count)}, ${kb(p.bytes)}` : 'not loadable';
      console.log(`${where}  ${head}`);
      for (const x of r.problems) console.log(`  problem  ${x}`);
      for (const x of r.warnings) console.log(`  warning  ${x}`);
      if (!r.problems.length && !r.warnings.length) console.log('  ok');
      problems += r.problems.length;
      warnings += r.warnings.length;
    }
    console.log(`${folders.length} folder(s): ${problems} problem(s), ${warnings} warning(s)`);
    return problems || (flags.has('strict') && warnings) ? 1 : 0;
  }

  console.log(USAGE);
  return cmd ? 2 : 0;
}

const invoked = (() => { try { return pathToFileURL(fs.realpathSync(process.argv[1] || '')).href; } catch { return null; } })();
if (invoked === import.meta.url) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(`plugin: ${e.message}`); process.exitCode = 2; });
