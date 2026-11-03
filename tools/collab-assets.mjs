#!/usr/bin/env node
// tools/collab-assets.mjs — build the collab art pack (联动干员, shared/collabAssets.js; docs/ASSETS.md "The collab pack"):
// data/assets-collab.json from a body of manifest entries, and the pack's files moved (or copied) from their normal-pack
// paths to public/assets/collab/…, so the normal pack (public/assets minus collab/) carries none of them.
//
//   node tools/collab-assets.mjs --body <entries.json> [--copy] [--public <dir>] [--dry-run]
//       <entries.json>: the sections of data/assets.json (chars, tokens, skills, skillsById, modules, skins, audio) for
//       the collab operators and their summons, with their normal URLs (/assets/char/…, /assets/spine/…, /assets/audio/…).
//       Writes data/assets-collab.json (every URL under /assets/collab/) and moves each file it names from public/<url>
//       to public/assets/collab/<rest> (--copy: copies, the normal path keeps its file). A file data/assets.json or
//       data/local-assets.json names too (a generic sound: b_char_dead.mp3 …) is always copied: the normal pack keeps it.
//       A file already at its pack path is left; one at neither path is reported (exit 1, the manifest is still written).
//   node tools/collab-assets.mjs --fx <dir> [--public <dir>]
//       the collab operators' official effects from an `extract.py --only fx --fx-collab only --out <dir>/local
//       --manifest <dir>/local-assets.json` run (its <dir>/local-fx.json and <dir>/local/fx/**): writes
//       data/local-fx-collab.json and copies into public/assets/collab/local/fx/ its index.json, textures.json and every
//       prefab, texture and mesh the normal set (data/local-fx.json) lacks — a key both have stays the normal pack's, the
//       page's library falls back to it (shared/collabAssets.js mergeFxGroups). The pack's fx folder is replaced.
//   node tools/collab-assets.mjs --check [--public <dir>]
//       data/assets-collab.json against the rules: no URL outside the pack, every file on disk, data/assets.json naming
//       no collab operator (data/backups.json diy.excluded) and no pack file, and the official-FX index
//       (public/assets/local/fx/index.json, when the host has one) holding no unit or skill of a collab operator — their
//       effects are the pack's, so an extraction that adds them to the normal set is caught here —, and
//       data/local-fx-collab.json (when there is one) naming only pack files that are on disk. Exit 1 on a problem.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLLAB_ASSET_PREFIX, COLLAB_MANIFEST_FILE, COLLAB_FX_FILE, COLLAB_FX_PREFIX, collabManifestOf, collabManifestProblems, collabFxListProblems,
  isCollabUrl, manifestUrls } from '../shared/collabAssets.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

/**
 * The manifest document of a body: collabManifestOf plus the header fields of data/assets.json.
 * @param {any} body
 */
export function buildCollabManifest(body) {
  const { doc, moves } = collabManifestOf(body);
  const hash = createHash('sha256').update(JSON.stringify(doc)).digest('hex').slice(0, 12);
  const files = new Set(manifestUrls(doc)).size;
  return {
    doc: { version: 1, kind: 'collab', prefix: COLLAB_ASSET_PREFIX, hash, generator: 'tools/collab-assets.mjs',
      stats: { chars: Object.keys(doc.chars || {}).length, tokens: Object.keys(doc.tokens || {}).length, files }, ...doc },
    moves,
  };
}

/**
 * What breaks the pack's rules (empty = fine): the manifest's own problems, files missing under `publicDir`, and the
 * normal manifest naming a collab operator or a pack file, the official-FX index (`fx`, optional) naming a collab
 * operator's unit or skill.
 * @param {{ collab: any, assets: any, backups: any, publicDir: string, files?: boolean, fx?: any }} o
 */
export function collabPackProblems({ collab, assets, backups, publicDir, files = true, fx = null }) {
  const out = collabManifestProblems(collab).map((p) => `${COLLAB_MANIFEST_FILE}: ${p}`);
  if (files) for (const url of new Set(manifestUrls(collab))) if (!existsSync(join(publicDir, url.slice(1)))) out.push(`missing file: ${url}`);
  const excluded = Array.isArray(backups?.diy?.excluded) ? backups.diy.excluded : [];
  for (const id of excluded) if (assets?.chars?.[id]) out.push(`data/assets.json: chars.${id} is a collab operator (its art belongs in ${COLLAB_MANIFEST_FILE})`);
  for (const url of manifestUrls(assets)) if (isCollabUrl(url)) out.push(`data/assets.json names a pack file: ${url}`);
  if (fx && typeof fx === 'object') {
    const skills = new Set();
    for (const id of excluded) for (const f of Object.values(backups?.units?.[id]?.forms || {})) for (const sk of f.skills || []) if (sk?.skillId) skills.add(sk.skillId);
    for (const id of excluded) if (fx.units?.[id]) out.push(`fx index: units.${id} is a collab operator's (not in the pack yet)`);
    for (const id of skills) if (fx.skills?.[id]) out.push(`fx index: skills.${id} is a collab operator's (it belongs in ${COLLAB_FX_FILE})`);
  }
  return out;
}

/** The URL of a normal-set effect file in the pack: /assets/local/fx/<rel> → /assets/collab/local/fx/<rel>. */
const toCollabFx = (p) => (typeof p === 'string' && p.startsWith('/assets/local/fx/') ? COLLAB_FX_PREFIX + p.slice('/assets/local/fx/'.length) : p);

/**
 * The collab effects' file list of an extraction's list (`list`, paths under /assets/local/fx/) without the keys the
 * normal list (`normal`) has, its paths moved under the pack's prefix, and the files to copy ([from, to] URL pairs).
 * @param {any} list @param {any} normal
 * @returns {{ doc: any, copies: [string, string][], kept: Record<string, number>, shared: Record<string, number> }}
 */
export function collabFxListOf(list, normal) {
  const groups = {}, copies = [], kept = {}, shared = {};
  const ng = normal?.groups || {};
  for (const [group, entries] of Object.entries(list?.groups || {})) {
    groups[group] = {};
    kept[group] = 0; shared[group] = 0;
    for (const [key, e] of Object.entries(entries || {})) {
      if (group !== 'fx' && ng[group]?.[key]) { shared[group]++; continue; }
      const out = { ...e };
      for (const field of ['path', 'half']) {
        if (typeof e?.[field] !== 'string') continue;
        out[field] = toCollabFx(e[field]);
        copies.push([e[field], out[field]]);
      }
      groups[group][key] = out;
      kept[group]++;
    }
  }
  const count = Object.values(groups).reduce((n, g) => n + Object.keys(g).length, 0);
  return { doc: { ...list, kind: 'collab', prefix: COLLAB_FX_PREFIX, count, groups }, copies, kept, shared };
}

function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const publicDir = resolve(arg('--public') || join(ROOT, 'public'));
  const outFile = join(ROOT, 'data', COLLAB_MANIFEST_FILE);
  if (argv.includes('--check')) {
    const fxFile = join(publicDir, 'assets/local/fx/index.json');
    const problems = collabPackProblems({ collab: read(outFile), assets: read(join(ROOT, 'data/assets.json')),
      backups: read(join(ROOT, 'data/backups.json')), publicDir, fx: existsSync(fxFile) ? read(fxFile) : null });
    const fxList = join(ROOT, 'data', COLLAB_FX_FILE);
    if (existsSync(fxList)) {
      const list = read(fxList);
      problems.push(...collabFxListProblems(list).map((p) => `${COLLAB_FX_FILE}: ${p}`));
      for (const e of Object.values(list.groups || {}).flatMap((g) => Object.values(g || {}))) {
        for (const u of [e?.path, e?.half]) if (typeof u === 'string' && !existsSync(join(publicDir, u.slice(1)))) problems.push(`missing file: ${u}`);
      }
    }
    for (const p of problems.slice(0, 50)) console.error(p);
    console.log(problems.length ? `${problems.length} problem(s)` : 'collab pack ok');
    return problems.length ? 1 : 0;
  }
  const fxDir = arg('--fx');
  if (fxDir) {
    const dir = resolve(fxDir);
    const normalFile = join(ROOT, 'data/local-fx.json');
    const { doc, copies, kept, shared } = collabFxListOf(read(join(dir, 'local-fx.json')), existsSync(normalFile) ? read(normalFile) : null);
    const problems = collabFxListProblems(doc);
    if (problems.length) { for (const p of problems.slice(0, 20)) console.error(p); return 1; }
    rmSync(join(publicDir, COLLAB_FX_PREFIX.slice(1)), { recursive: true, force: true });
    const missing = [];
    for (const [from, to] of copies) {
      const src = join(dir, from.slice('/assets/'.length)), dst = join(publicDir, to.slice(1));
      if (!existsSync(src)) { missing.push(from); continue; }
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
    writeFileSync(join(ROOT, 'data', COLLAB_FX_FILE), JSON.stringify(doc));
    console.log(`${COLLAB_FX_FILE}: kept ${JSON.stringify(kept)}, left to the normal set ${JSON.stringify(shared)}; ${copies.length - missing.length} files copied, ${missing.length} missing`);
    for (const m of missing.slice(0, 20)) console.error(`missing: ${m}`);
    return missing.length ? 1 : 0;
  }
  const bodyFile = arg('--body');
  if (!bodyFile) { console.error('usage: node tools/collab-assets.mjs --body <entries.json> [--copy] [--public <dir>] [--dry-run] | --fx <dir> | --check'); return 2; }
  const { doc, moves } = buildCollabManifest(read(resolve(bodyFile)));
  const dry = argv.includes('--dry-run');
  const copy = argv.includes('--copy');
  // the files the normal pack names stay where they are (copied into the pack)
  const normal = new Set(manifestUrls(read(join(ROOT, 'data/assets.json'))));
  const localFile = join(ROOT, 'data/local-assets.json');
  if (existsSync(localFile)) for (const u of manifestUrls(read(localFile))) normal.add(u);
  let moved = 0, kept = 0, shared = 0;
  const missing = [];
  for (const [from, to] of moves) {
    const src = join(publicDir, from.slice(1)), dst = join(publicDir, to.slice(1));
    if (existsSync(dst)) { kept++; continue; }
    if (!existsSync(src)) { missing.push(from); continue; }
    if (!dry) {
      mkdirSync(dirname(dst), { recursive: true });
      if (copy || normal.has(from)) copyFileSync(src, dst); else renameSync(src, dst);
    }
    if (normal.has(from)) shared++;
    moved++;
  }
  if (!dry) writeFileSync(outFile, `${JSON.stringify(doc)}\n`);
  console.log(`${dry ? '[dry run] ' : ''}${COLLAB_MANIFEST_FILE}: ${doc.stats.chars} operators, ${doc.stats.tokens} tokens, ${doc.stats.files} files; ` +
    `${copy ? 'copied' : 'moved'} ${moved} (${shared} copied: the normal pack names them too), already in the pack ${kept}, missing ${missing.length}`);
  for (const m of missing.slice(0, 30)) console.error(`missing: ${m}`);
  return missing.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
