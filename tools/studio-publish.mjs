#!/usr/bin/env node
/** Publish the browser code tree to the ModelScope Studio (创空间) as an append-only, content-addressed copy.
 *
 * Layout on the Studio repo (`studios/<space>`): a single tree `code/<treeTag>/{vendor,shared,sim,js}/…` —
 * ONE 16-hex `treeTag` over all four roots, so the tree is self-contained: raw module bytes served from it
 * resolve their cross-root relative imports inside the tree (js→shared, sim→shared, sim→/data.js excepted —
 * the importmap routes that one back to the origin's versioned shim). The treeTag and the per-root group
 * tags both come from the server's own formula (`server/assetVersion.js` codeContentTags + codeTransformer,
 * imported below — 创空间发布物与服务端 importmap 的 tag 逐字节一致), so the Studio copy is just a base-swap
 * of the `/_v/<tag>/` origin namespace, and the origin keeps serving the identical bytes as the fallback
 * (module-level fallback v1 is deliberately not built; a page-level reload covers a dead mirror — the origin
 * answers `/_v/<groupTag>/…` with the same bytes meanwhile). Publish from the same commit you deploy: the
 * tag salts with the rewriter bytes (codeTransformer), so a different rewriter state yields a different tag
 * for identical files — that is safe (a new tag dir) but then the origin's importmap must name THAT tag.
 *
 * Append-only: an existing `code/<tag>/…` dir is never rewritten or deleted. The space also still holds the
 * first publish's scattered per-group dirs `code/<组tag>/<root>/…` (commit fa239ce9cf0e, computed by this
 * tool's earlier inline formula without the transformer salt) — they stay resolvable forever; the single-tree
 * layout lives under its own tag dirs and never collides with them. (The earlier formula also differed in
 * the salt and the sim file set, so old and new tags never share values by design.)
 *
 * Subcommands:
 *   plan                       — stage nothing, print the tree tag / per-root file count / bytes
 *   publish [--apply]          — clone-or-refresh the Studio worktree under .cache/studio-publish/,
 *                                copy `code/<treeTag>/…` in, refuse on content conflicts under an
 *                                existing tag dir (append-only), commit + push, print the resolve base
 *   verify [--base <url>]      — re-fetch every published file (bounded concurrency) and check
 *                                200 + SHA-256 + `Access-Control-Allow-Origin: *` + `.js` MIME
 *
 * Auth: git push uses username `oauth2` + the SDK token (`MODELSCOPE_API_KEY` env or the repo `.env`);
 * the token travels only through a credential helper reading an env var, never through argv.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { codeContentTags, codeTransformer } from '../server/assetVersion.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** [URL root served to browsers, directory on disk]. /sim is served verbatim from server/sim/ and
 * /shared from the repo-root shared/ — both are the dual-end (Node+browser) directories. */
const GROUPS = [
  ['vendor', 'public/vendor'],
  ['shared', 'shared'],
  ['sim', 'server/sim'],
  ['js', 'public/js'],
];
/** The sim mount serves `.js` only and never nodeData.js (server/http/static.js SIM_PRIVATE): the tag
 * must digest exactly the served set, so the walk filters the same way. */
const SIM_SERVED = (name) => {
  const lower = name.toLowerCase();
  return lower.endsWith('.js') && lower !== 'nodedata.js';
};
const DEFAULT_SPACE = 'Misyra/arknight-proto';
const STUDIO_GIT = (space) => `https://www.modelscope.cn/studios/${space}.git`;
const RESOLVE_BASE = (space, commit) => `https://modelscope.cn/studio/${space}/resolve/${commit}`;

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

function loadToken() {
  const env = process.env.MODELSCOPE_API_KEY;
  if (env) return env;
  const dotEnv = readFileSync(join(ROOT, '.env'), 'utf8');
  const line = dotEnv.split('\n').find((l) => l.startsWith('MODELSCOPE_API_KEY='));
  if (!line) throw new Error('MODELSCOPE_API_KEY not in env or .env');
  return line.slice('MODELSCOPE_API_KEY='.length).replace(/^"|"$/g, '');
}

function walk(dir, base, out, filter) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (e.name.startsWith('.') || e.name.endsWith('~') || e.isSymbolicLink()) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) { walk(abs, `${base}/${e.name}`, out, filter); continue; }
    if (!e.isFile()) continue;
    if (filter && !filter(e.name)) continue;
    const buf = readFileSync(abs);
    out.push({ rel: `${base}/${e.name}`, abs, hash: createHash('sha256').update(buf).digest('hex'), bytes: buf.length });
  }
  return out;
}

/** Stage every group and compute its content tags with the server's own formula: per-root group tags
 * (the origin's `/_v/<组tag>/` namespaces) and the single tree tag the layout publishes. `rel` stays the
 * on-disk shape (`js/main.js`, no leading slash) for paths and URLs; the tag formula eats the served form
 * (`/js/main.js`), which is what server/assetVersion.js walks. */
export function stage() {
  const groups = GROUPS.map(([root, dir]) => {
    const files = walk(join(ROOT, dir), root, [], root === 'sim' ? SIM_SERVED : null);
    return { root, files, bytes: files.reduce((n, f) => n + f.bytes, 0) };
  });
  const { groupTags, treeTag } = codeContentTags(
    groups.flatMap((g) => g.files.map((f) => ({ rel: `/${f.rel}`, hash: f.hash }))),
    codeTransformer(),
  );
  for (const g of groups) g.tag = groupTags[g.root];
  return { treeTag, groups };
}

function git(cwd, args_, token) {
  const base = ['-c', 'credential.helper=', '-c', 'credential.helper=!f(){ echo "username=oauth2"; echo "password=$SP_MS_TOKEN"; };f',
    '-c', 'user.name=Misyra', '-c', 'user.email=Misyra@163.com'];
  return execFileSync('git', [...base, ...args_], { cwd, encoding: 'utf8', env: { ...process.env, SP_MS_TOKEN: token } }).trim();
}

function ensureWorktree(space, token) {
  const dir = join(ROOT, '.cache', 'studio-publish', space.replaceAll('/', '_'));
  if (!existsSync(dir)) {
    mkdirSync(dirname(dir), { recursive: true });
    execFileSync('git', ['clone', '--depth', '1', STUDIO_GIT(space), dir], { stdio: 'pipe' });
  } else {
    git(dir, ['fetch', '--depth', '1', 'origin', 'master'], token);
    // Tool-managed cache worktree: always exactly the remote tip, never carries local edits.
    git(dir, ['checkout', '-q', 'FETCH_HEAD'], token);
    git(dir, ['reset', '--hard', 'FETCH_HEAD', '-q'], token);
  }
  git(dir, ['clean', '-fdq'], token);
  return dir;
}

function publish() {
  const apply = args.includes('--apply');
  const space = flag('--space') || DEFAULT_SPACE;
  const { treeTag, groups } = stage();
  const total = groups.reduce((n, g) => n + g.files.length, 0);
  const totalBytes = groups.reduce((n, g) => n + g.bytes, 0);
  if (!apply) {
    console.log('plan only (add --apply to push):');
    console.log(`  code/${treeTag}/  ${total} files  ${(totalBytes / 1048576).toFixed(1)} MiB  (single tree)`);
    for (const g of groups) console.log(`    code/${treeTag}/${g.root}/  ${g.files.length} files  ${(g.bytes / 1048576).toFixed(1)} MiB  (group tag ${g.tag})`);
    return;
  }
  const token = loadToken();
  const dir = ensureWorktree(space, token);
  const conflicts = [];
  let copied = 0, skipBytes = 0;
  for (const g of groups) {
    for (const f of g.files) {
      const target = join(dir, 'code', treeTag, f.rel);
      if (existsSync(target)) {
        const have = createHash('sha256').update(readFileSync(target)).digest('hex');
        if (have !== f.hash) conflicts.push(`code/${treeTag}/${f.rel}`);
        skipBytes += f.bytes;
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(f.abs, target);
      copied++;
    }
  }
  if (conflicts.length) {
    console.error(`ABORT — append-only violation, existing tag dir holds different bytes:\n  ${conflicts.slice(0, 10).join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  const dirty = git(dir, ['status', '--porcelain'], token);
  if (!dirty) {
    console.log(`nothing to push — all ${total} files already present under code/${treeTag}/`);
  } else {
    const tags = groups.map((g) => `${g.root} ${g.tag}`).join(', ');
    git(dir, ['add', '-A', 'code'], token);
    git(dir, ['commit', '-q', '-m', `publish code tree ${treeTag} (${tags}) — ${copied} new files`], token);
    git(dir, ['push', '-q', 'origin', 'HEAD:master'], token);
  }
  const commit = git(dir, ['rev-parse', 'HEAD'], token);
  const base = RESOLVE_BASE(space, commit);
  const manifest = { space, commit, base, treeTag, groups: groups.map(({ root, tag, files, bytes }) => ({ root, tag, bytes, count: files.length, files })) };
  writeFileSync(join(ROOT, '.cache', 'studio-publish', 'last-publish.json'), JSON.stringify(manifest));
  console.log(`published commit ${commit.slice(0, 12)} (${copied} new files, ${(skipBytes / 1048576).toFixed(1)} MiB already present)`);
  console.log(`  ${base}/code/${treeTag}/  (tree tag ${treeTag})`);
  console.log('now run: node tools/studio-publish.mjs verify');
}

async function verify() {
  const base = flag('--base') || JSON.parse(readFileSync(join(ROOT, '.cache', 'studio-publish', 'last-publish.json'), 'utf8')).base;
  const { treeTag, groups } = stage();
  const total = groups.reduce((n, g) => n + g.files.length, 0);
  console.log(`verifying ${total} files under ${base}/code/${treeTag}/...`);
  const failures = [];
  let done = 0;
  const queue = [];
  for (const g of groups) for (const f of g.files) queue.push({ f });
  async function worker() {
    while (queue.length) {
      const { f } = queue.shift();
      const url = `${base}/code/${treeTag}/${encodeURI(f.rel)}`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        const type = res.headers.get('content-type') || '';
        if (f.rel.endsWith('.js') && !type.includes('javascript')) throw new Error(`MIME ${type}`);
        if (res.headers.get('access-control-allow-origin') !== '*') throw new Error('missing ACAO:*');
        const body = Buffer.from(await res.arrayBuffer());
        const have = createHash('sha256').update(body).digest('hex');
        if (have !== f.hash) throw new Error(`sha mismatch got ${have.slice(0, 12)}`);
      } catch (e) {
        failures.push(`${url} — ${e.message}`);
      }
      if (++done % 100 === 0) console.log(`  ${done}/${total}`);
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  if (failures.length) {
    console.error(`FAIL ${failures.length}/${total}:\n  ${failures.slice(0, 20).join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`OK — ${total}/${total} files verified (200 + sha256 + ACAO:* + .js MIME)`);
  }
}

// Import-safe: a test importing this module must not trigger the CLI dispatch (or its process.exitCode).
const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly && (cmd === 'plan' || cmd === 'publish')) publish();
else if (invokedDirectly && cmd === 'verify') await verify();
else if (invokedDirectly) {
  console.error('usage: studio-publish.mjs plan | publish [--apply] | verify [--base <url>]');
  process.exitCode = 1;
}
