// SP_CODE_CDN (创空间单树布局, PLAN-2026-11-09 Task-3): the page's code resources — entry script src,
// rewritten relative imports, importmap root mappings — point at `${base}/code/<treeTag>/<root>/…` when the
// code CDN base is configured, and stay byte-identical on the origin's `/_v/<组tag>/` when it is not.
// tools/studio-publish.mjs publishes that tree with the same tag formula the server imports here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStaticHandler } from '../server/index.js';
import { createAssetVersion, codeContentTags, codeTransformer } from '../server/assetVersion.js';
import { parseCodeCdn } from '../server/http/config.js';
import { siteCsp } from '../server/http/csp.js';
import { stage as stageStudio } from '../tools/studio-publish.mjs';

const TOOL = fileURLToPath(new URL('../tools/studio-publish.mjs', import.meta.url));
/** The deterministic walk both server/assetVersion.js and the publish tool use (per-directory
 * `localeCompare(…, 'en')`, depth-first); the tag formula eats the rows in exactly this order. */
const walk = (dir, base, out = [], filter = null) => {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (e.name.startsWith('.') || e.name.endsWith('~') || e.isSymbolicLink()) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { walk(abs, `${base}/${e.name}`, out, filter); continue; }
    if (!e.isFile() || (filter && !filter(e.name))) continue;
    out.push({ rel: `${base}/${e.name}`, abs, hash: createHash('sha256').update(fs.readFileSync(abs)).digest('hex') });
  }
  return out;
};
const SIM_SERVED = (name) => {
  const lower = name.toLowerCase();
  return lower.endsWith('.js') && lower !== 'nodedata.js';
};

test('SP_CODE_CDN parses like assetCdnSettings or refuses to boot', () => {
  assert.equal(parseCodeCdn(undefined), '');
  assert.equal(parseCodeCdn('  '), '');
  assert.equal(parseCodeCdn('https://studio.test/'), 'https://studio.test');
  assert.equal(parseCodeCdn(' http://cdn.local:8443/base// '), 'http://cdn.local:8443/base');
  for (const bad of ['not a url', 'ftp://studio.test', 'https://studio.test/?a=1', 'https://studio.test/#f', 'https://u:p@studio.test']) {
    assert.throws(() => parseCodeCdn(bad), TypeError, bad);
  }
});

test('with a code CDN base the page, module graph and importmap point at the published single tree', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-code-cdn-'));
  const write = (rel, body) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  write('public/index.html', '<html><head><script type="importmap">{"imports":{"preact":"/vendor/preact.module.js"}}</script></head>'
    + '<script type="module" src="/js/main.js"></script></html>');
  write('public/js/main.js', "import './child.js';\nimport '../../shared/s.js';");
  write('public/js/child.js', 'export const x = 1;');
  write('public/vendor/preact.module.js', 'export const p = 1;');
  write('shared/s.js', 'export const s = 1;');
  write('sim/x.js', 'import "../../shared/s.js";');
  write('sim/content/support/i.js', "import { getData } from '../../../data.js';");
  write('data/d.json', '{}');
  const dirs = { publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data'), sharedDir: path.join(root, 'shared'), simDir: path.join(root, 'sim') };
  const handler = createStaticHandler({ ...dirs, codeCdnBase: 'https://studio.test/' });
  const srv = http.createServer((req, res) => handler(req, res, req.url.split('?')[0], req.url.split('?')[1] || ''));
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const get = (url) => fetch(`http://127.0.0.1:${srv.address().port}${url}`);
  const tree = handler.codeTreeVersion;
  try {
    const html = await (await get('/')).text();
    assert.ok(html.includes(`src="https://studio.test/code/${tree}/js/main.js"`), 'the entry script addresses the tree');
    const imports = JSON.parse(html.match(/type="importmap">(.*?)<\/script>/)[1]).imports;
    const shim = `/_v/${handler.runtimeVersion}/data.js`;
    assert.equal(imports.preact, `https://studio.test/code/${tree}/vendor/preact.module.js`);
    for (const rootKey of ['/js/', '/vendor/', '/shared/', '/sim/', '/_v/js/', '/_v/shared/']) {
      assert.equal(imports[rootKey], `https://studio.test/code/${tree}${rootKey.replace(/^\/_v/, '')}`, rootKey);
    }
    assert.equal(imports['https://studio.test/code/shared/'], `https://studio.test/code/${tree}/shared/`,
      'raw tree modules climbing past the tree root land at code/<root>/ — the importmap routes them back in');
    assert.equal(imports['/data.js'], shim, 'the generated shim stays on the origin runtime tag');
    assert.equal(imports[`https://studio.test/code/${tree}/data.js`], shim,
      "sim content's climb to /data.js lands inside the tree — routed back to the origin shim");
    // the tree tag in the URLs is the exported formula over the same walk
    const served = [
      ...walk(path.join(root, 'shared'), '/shared'),
      ...walk(path.join(root, 'sim'), '/sim', [], SIM_SERVED),
      ...walk(path.join(root, 'public'), ''),
    ];
    const { groupTags, treeTag } = codeContentTags(served, codeTransformer());
    assert.equal(tree, treeTag);
    assert.equal(JSON.parse(html.match(/__spCodeVersion=(\{[^}]+\})/)[1]).js, groupTags.js,
      'the head stamp keeps the origin group tags');
    // origin-served (fallback) module bytes rewrite their imports into the tree
    const main = await get(`/_v/${groupTags.js}/js/main.js`);
    assert.match(main.headers.get('cache-control'), /31536000, immutable/);
    const mainBody = await main.text();
    assert.ok(mainBody.includes(`import 'https://studio.test/code/${tree}/js/child.js';`), mainBody);
    assert.ok(mainBody.includes(`import 'https://studio.test/code/${tree}/shared/s.js';`), 'the cross-root climb is rewritten at the origin too');
    const simModule = await get(`/_v/${groupTags.sim}/sim/content/support/i.js`);
    assert.ok((await simModule.text()).includes(`from '${shim}'`), "the origin rewrites the data.js climb to the versioned shim");
    const versionedShim = await get(shim);
    assert.ok((await versionedShim.text()).includes(`from 'https://studio.test/code/${tree}/sim/simdata.js'`),
      'the versioned shim pulls simdata from the tree');
    assert.equal((await (await get('/data.js')).text()).includes('studio.test'), false, 'the bare shim stays untouched');
    // CSP: the code origin — and only script-src — gains it
    const withCode = siteCsp(dirs.publicDir, handler.transformPage, '', [], 'https://studio.test');
    assert.match(withCode, /script-src 'self' https:\/\/studio\.test /);
    assert.doesNotMatch(withCode, /img-src[^;]*studio\.test/, 'the code CDN never enters the art directives');
    assert.doesNotMatch(siteCsp(dirs.publicDir, handler.transformPage, '', [], ''), /script-src 'self' https:/);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createAssetVersion keeps unconfigured URLs on the origin and computes both tags with the exported formula', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-code-tags-'));
  const write = (rel, body) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  write('data/d.json', '{}');
  write('shared/s.js', 'export const s = 1;');
  write('sim/x.js', 'export const x = 1;');
  write('sim/nodeData.js', 'private loader');
  write('sim/notes.md', 'not served');
  write('public/js/a.js', 'export const a = 1;');
  write('public/js/sub/b.js', 'export const b = 1;');
  write('public/vendor/v.js', 'export const v = 1;');
  write('public/assets/p.png', 'art');
  // the real mount shape (server/http/static.js): sim is .js-only and never nodeData.js
  const mounts = [
    { dir: path.join(root, 'data'), prefix: '/data/' },
    { dir: path.join(root, 'shared'), prefix: '/shared/' },
    { dir: path.join(root, 'sim'), prefix: '/sim/', only: new Set(['.js']), deny: new Set(['nodedata.js']) },
    { dir: path.join(root, 'public'), prefix: '/' },
  ];
  const entries = [
    ...walk(path.join(root, 'data'), '/data'),
    ...walk(path.join(root, 'shared'), '/shared'),
    ...walk(path.join(root, 'sim'), '/sim', [], SIM_SERVED),
    ...walk(path.join(root, 'public'), ''),
  ];
  const release = createAssetVersion(mounts, 'shim');
  const { groupTags, treeTag } = codeContentTags(entries, codeTransformer());
  assert.deepEqual(release.groupTags, groupTags);
  assert.equal(release.treeTag, treeTag);
  // the served set, not the on-disk set: nodeData.js and notes.md must not be in the tag
  const polluted = codeContentTags([...entries, { rel: '/sim/nodeData.js', hash: createHash('sha256').update('private loader').digest('hex') },
    { rel: '/sim/notes.md', hash: createHash('sha256').update('not served').digest('hex') }], codeTransformer());
  assert.notEqual(release.treeTag, polluted.treeTag);
  // 未配置回归：URL 全部留在源站命名空间
  assert.equal(release.url('/js/a.js'), `/_v/${groupTags.js}/js/a.js`);
  assert.equal(release.url('/data.js'), `/_v/${release.runtimeTag}/data.js`);
  assert.equal(release.url('/assets/p.png'), `/_v/${release.artTag}/assets/p.png`);
  // 配置后：四个代码根指向单树，data.js 与素材不受影响，tag 本身不变
  const cdn = createAssetVersion(mounts, 'shim', { base: '', version: '' }, { codeBase: 'https://studio.test/' });
  assert.equal(cdn.treeTag, release.treeTag);
  assert.deepEqual(cdn.groupTags, release.groupTags);
  assert.equal(cdn.url('/js/a.js'), `https://studio.test/code/${treeTag}/js/a.js`);
  assert.equal(cdn.url('/sim/x.js'), `https://studio.test/code/${treeTag}/sim/x.js`);
  assert.equal(cdn.url('/data.js'), `/_v/${release.runtimeTag}/data.js`);
  assert.equal(cdn.url('/assets/p.png'), `/_v/${release.artTag}/assets/p.png`);
  assert.equal(cdn.url('/data/d.json'), `/_v/${release.tag}/data/d.json`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the publish tool stages the single-tree layout with the server formula, and plan prints it', () => {
  const { treeTag, groups } = stageStudio();
  const sim = groups.find((g) => g.root === 'sim');
  assert.ok(sim.files.some((f) => f.rel === 'sim/Battle.js'), 'the sim group stages the served modules');
  assert.equal(sim.files.some((f) => f.rel === 'sim/nodeData.js'), false, 'nodeData.js is never staged (server deny list)');
  assert.equal(sim.files.some((f) => !SIM_SERVED(path.basename(f.rel))), false, 'the sim group stages .js only');
  // wiring: recomputing both tags from the staged files with the server formula reproduces them
  const { groupTags, treeTag: expected } = codeContentTags(
    groups.flatMap((g) => g.files.map((f) => ({ rel: `/${f.rel}`, hash: f.hash }))), codeTransformer());
  assert.equal(treeTag, expected, 'the tree tag covers vendor+shared+sim+js');
  for (const g of groups) assert.equal(g.tag, groupTags[g.root], `${g.root} group tag matches the server formula`);
  // the CLI plan output names the single tree only
  const run = spawnSync(process.execPath, [TOOL, 'plan'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const tags = [...run.stdout.matchAll(/code\/([0-9a-f]{16})\//g)].map((m) => m[1]);
  assert.ok(tags.length >= 5, `plan names the tree per root: ${run.stdout.split('\n')[1]}`);
  assert.ok(tags.every((t) => t === treeTag), 'every published path sits under the one tree tag');
  assert.ok(run.stdout.includes('(single tree)'));
  assert.ok(run.stdout.includes(`code/${treeTag}/js/`));
});
