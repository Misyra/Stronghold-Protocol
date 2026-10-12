#!/usr/bin/env node
// tools/plugin.mjs — the plugins of a checkout (DESIGN §31, docs/PLUGINS.md; the registry the server runs is
// server/plugins/registry.js, the format shared/plugins/manifest.js):
//
//   node tools/plugin.mjs list [--json]                  every plugin and language pack the registry finds — plugins/,
//                                                        packs/, the language folders — by class with its status, what
//                                                        was skipped and why, the warnings, and the vanilla content hash
//   node tools/plugin.mjs check [<dir|id> …] [--strict]   check plugin folders (default: every folder of plugins/ but the
//                                                        `_` templates): the manifest (manifest 2, its class, the parts
//                                                        and permissions), the files (types by class, sizes, counts,
//                                                        every path the manifest names, inside the folder) and every
//                                                        JSON file (valid, nesting ≤ 64, numbers finite within ±1e9).
//                                                        Exit 1 on a problem, with --strict on a warning too. Nothing is
//                                                        merged or applied yet (P1: the art and data plugins)
//   --root <dir>   another checkout or an unpacked release (default: this checkout)
//
// A language pack's strings are checked by node tools/i18n.mjs check <code> (docs/I18N.md); tools/packs.mjs keeps the
// pack commands of 0.2.0 (list, index, check).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanPlugins, pluginIndexOf, readPluginFolder, listPluginFiles } from '../server/plugins/registry.js';
import { computeVanillaContent } from '../server/plugins/identity.js';
import { DATA_SHIM_JS } from '../server/http/static.js';
import { PLUGIN_CLASSES, PLUGIN_LIMITS, checkJsonLimits, extOf } from '../shared/plugins/manifest.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: node tools/plugin.mjs list [--json] | check [<dir|id> …] [--strict]   [--root <dir>]';

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
 * Check one plugin folder: the registry's rules (readPluginFolder) and every JSON file's content.
 * @param {string} dir
 * @param {string} where how the folder is named in the output
 * @returns {{ where: string, plugin: import('../server/plugins/registry.js').Plugin | null, problems: string[], warnings: string[] }}
 */
export function checkPluginFolder(dir, where) {
  const r = readPluginFolder(dir, { where });
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
    for (const { dir, where } of folders) {
      const r = checkPluginFolder(dir, where);
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
