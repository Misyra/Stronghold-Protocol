// test/plugins/visualSet.test.js — the visual sets of a server and the files of cosmetic plugins (DESIGN §32 P1a,
// server/plugins/visualSet.js, server/http/static.js /vs/ and /p/): a set resolved for a room or a player (loaded
// cosmetic plugins of the scope, their requirements switched on, in load order, within the size limit — refused
// otherwise), its vs stable for the same files and new for one changed byte; GET /vs/<vs16>/assets.json — the served
// art manifest (its /assets/~<hash>/ URLs, as with no plugin) with the set laid over it and its composition, which a
// browser's check accepts — and /vs/<vs16>/overlay.json; GET /p/<id>/<hash8>/<path> — only a file an overlay names
// (never plugin.json, the lock, a document, a dot file, a path out of the folder or a link out of it), `immutable` at
// the hash of its bytes (its own, or its Spine model's), the current file with `no-cache` at any other — and the
// vanilla /data/assets.json unchanged by any plugin. Art is generated on the spot (test/helpers/pluginFixtures.js).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPluginRegistry } from '../../server/plugins/registry.js';
import { createVisualSets } from '../../server/plugins/visualSet.js';
import { createStaticHandler } from '../../server/http/static.js';
import { createAssetIndex } from '../../server/http/assetIndex.js';
import { createManifestViews } from '../../server/http/assetViews.js';
import { splitUrl } from '../../server/http/common.js';
import { checkVisualDoc, visualHashOf, modelHashOf, VISUAL_LIMITS } from '../../shared/plugins/visual.js';
import { main as pluginTool } from '../../tools/plugin.mjs';
import { png, skel, atlas, writePlugin, cosmetic } from '../helpers/pluginFixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** A checkout-shaped root: two operators' art in public/assets, the manifest naming them, and cosmetic plugins. */
function exampleRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-visual-'));
  const put = (rel, body) => { fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
  put('public/assets/char/avatar/char_102_texas.png', png(2, 2, [10, 10, 10, 255]));
  put('public/assets/char/avatar/char_112_siege.png', png(2, 2, [20, 20, 20, 255]));
  put('public/assets/ui/hp.png', png(2, 2, [30, 30, 30, 255]));
  put('data/assets.json', JSON.stringify({
    version: 1, hash: 'testhash', chars: {
      char_102_texas: { avatar: '/assets/char/avatar/char_102_texas.png' },
      char_112_siege: { avatar: '/assets/char/avatar/char_112_siege.png' },
    }, ui: { 'hudPanel/icon_hp': '/assets/ui/hp.png' },
  }));
  fs.mkdirSync(path.join(root, 'packs'));
  const plugins = path.join(root, 'plugins');
  writePlugin(path.join(plugins, 'red'), cosmetic({ authors: ['tester'], assets: {
    chars: { char_102_texas: { avatar: 'art/red.png', spine: { front: { skel: 'spine/t/t.skel' } } }, char_x_new: { ref: 'char_112_siege' } },
    ui: { 'hudPanel/icon_hp': { ref: 'hudPanel/icon_hp' } },
  }, permissions: ['assets.override', 'assets.add'] }), {
    'art/red.png': png(4, 4, [255, 0, 0, 255]), 'spine/t/t.skel': skel(), 'spine/t/t.atlas': atlas(['t.png']), 'spine/t/t.png': png(4, 4),
    'art/unused.png': png(1, 1), 'README.md': '# red\n', 'notes.txt': 'notes',
  });
  writePlugin(path.join(plugins, 'blue'), cosmetic({ loadAfter: ['red'], assets: { chars: { char_102_texas: { avatar: 'blue.png' } } } }), { 'blue.png': png(4, 4, [0, 0, 255, 255]) });
  writePlugin(path.join(plugins, 'needs-red'), cosmetic({ requires: { red: '^1.0.0' }, assets: { chars: { char_112_siege: { avatar: 'g.png' } } } }), { 'g.png': png(4, 4, [0, 255, 0, 255]) });
  writePlugin(path.join(plugins, 'mine'), cosmetic({ scope: ['personal'], app: '<0.1.0', assets: { chars: { char_112_siege: { avatar: 'm.png' } } } }), { 'm.png': png(4, 4, [9, 9, 9, 255]) });
  writePlugin(path.join(plugins, 'nope'), cosmetic({ conflicts: { blue: '*' }, assets: { chars: { char_112_siege: { avatar: 'n.png' } } } }), { 'n.png': png(4, 4) });
  writePlugin(path.join(plugins, 'gameplay'), { manifest: 2, version: '1.0.0', app: '*', api: 1, class: 'content', permissions: ['data.patch'], data: ['d.json'] }, { 'd.json': { patch: 1, ops: [] } });
  return root;
}

describe('the visual sets of a server', () => {
  let root;
  let registry;
  let visual;
  let assetIndex;
  let server;
  let base;
  const get = (rawPath, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: rawPath, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  const json = async (p) => { const r = await get(p); assert.equal(r.status, 200, `${p}: ${r.status}`); return JSON.parse(r.body.toString('utf8')); };

  before(async () => {
    root = exampleRoot();
    // the Spine model needs its lock (tools/plugin.mjs pack): written like an author would
    const log = console.log;
    console.log = () => {};
    try { assert.equal(await pluginTool(['pack', path.join(root, 'plugins', 'red'), '--root', root]), 0); } finally { console.log = log; }
    const dirs = { publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data'), packsDir: path.join(root, 'packs'), pluginsDir: path.join(root, 'plugins') };
    registry = createPluginRegistry(dirs, { recheckMs: 0 });
    assetIndex = createAssetIndex({ publicDir: dirs.publicDir, delayMs: 0, cacheFile: null });
    assetIndex.start();
    await assetIndex.whenReady();
    const views = createManifestViews({ dataDir: dirs.dataDir, index: assetIndex });
    await views.rebuildAll();
    visual = createVisualSets({ registry, views });
    const serveStatic = createStaticHandler({ ...dirs, sharedDir: path.join(ROOT, 'shared'), packs: registry, views, assetIndex, visual });
    server = http.createServer((req, res) => { const p = splitUrl(req.url); serveStatic(req, res, p.rawPath, p.query).catch(() => res.destroy()); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    assetIndex.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('resolve: loaded cosmetic plugins of the scope, requirements switched on, load order, warnings — or refused', () => {
    const one = visual.resolve(['red']);
    assert.equal(one.ok, true, JSON.stringify(one));
    assert.deepEqual(one.set.plugins.map((p) => [p.id, p.version, p.class, typeof p.hash, p.auto]), [['red', '1.0.0', 'cosmetic', 'string', undefined]]);
    assert.equal(one.set.vs, registry.plugin('red').visual.vs, 'a set of one plugin is the vs the catalogue names');
    const two = visual.resolve(['blue', 'red']);
    assert.deepEqual(two.set.plugins.map((p) => p.id), ['red', 'blue'], 'blue loads after red');
    assert.deepEqual(two.set.warnings, [{ code: 'override', params: { path: 'chars.char_102_texas.avatar', plugins: ['red', 'blue'] } }]);
    assert.equal(two.set.bytes, registry.plugin('red').visual.bytes + registry.plugin('blue').visual.bytes);
    const auto = visual.resolve(['needs-red']);
    assert.deepEqual(auto.set.plugins.map((p) => [p.id, !!p.auto]), [['red', true], ['needs-red', false]]);
    assert.equal(visual.resolve(['red']).set.vs, one.set.vs, 'the same plugins → the same vs');
    const refuse = (ids, scope) => { const r = visual.resolve(ids, { scope }); return [r.error, r.detail]; };
    assert.equal(refuse(['absent'])[0], 'PLUGIN_UNKNOWN');
    assert.match(refuse(['gameplay']).join(' '), /^PLUGIN_BLOCKED gameplay is not a cosmetic plugin of scope room/);
    assert.equal(refuse(['mine'])[0], 'PLUGIN_BLOCKED', 'a personal-only plugin is no room plugin');
    assert.equal(refuse(['nope', 'blue'])[0], 'PLUGIN_CONFLICT');
    const personal = visual.resolve(['mine'], { scope: 'personal' });
    assert.deepEqual(personal.set.warnings, [{ code: 'app', params: { id: 'mine', app: '<0.1.0' } }], 'made for other versions: a cosmetic plugin is only warned about');
    const tight = createVisualSets({ registry, limits: { ...VISUAL_LIMITS, setBytes: 100 } });
    assert.equal(tight.resolve(['red']).error, 'PLUGIN_LIMIT');
  });

  test('GET /vs/<vs16>/assets.json: the served manifest with the set over it — the installation\'s URLs keep their hash segment', async () => {
    const { set } = visual.resolve(['red', 'blue']);
    const r = await get(`/vs/${set.vs.slice(0, 16)}/assets.json`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-cache');
    assert.match(r.headers['content-type'], /^application\/json/);
    const m = JSON.parse(r.body.toString('utf8'));
    assert.equal(checkVisualDoc(m, set.vs), null, 'its composition hashes to the room\'s vs');
    assert.deepEqual(m.visual.overlays.map((o) => o.id), ['red', 'blue']);
    const blue = registry.plugin('blue').visual.served.get('blue.png');
    assert.equal(m.chars.char_102_texas.avatar, `/p/blue/${blue.sha256.slice(0, 8)}/blue.png`, 'the later plugin applies');
    const view = JSON.parse((await get('/data/assets.json')).body.toString('utf8'));
    assert.match(view.chars.char_112_siege.avatar, /^\/assets\/~[0-9a-f]{16}\/char\/avatar\/char_112_siege\.png$/, 'the served manifest (0.2.6)');
    assert.equal(m.chars.char_112_siege.avatar, view.chars.char_112_siege.avatar, 'an entry no plugin changes is the served one');
    assert.deepEqual(m.chars.char_x_new, view.chars.char_112_siege, 'a whole-record reference copies the served entry');
    assert.equal(m.ui['hudPanel/icon_hp'], view.ui['hudPanel/icon_hp']);
    const front = m.chars.char_102_texas.spine.front;
    const red = registry.plugin('red').visual;
    const mh = modelHashOf(['spine/t/t.skel', 'spine/t/t.atlas', 'spine/t/t.png'].map((rel) => red.served.get(rel).sha256)).slice(0, 8);
    assert.deepEqual([front.skel, front.atlas, front.textures], [`/p/red/${mh}/spine/t/t.skel`, `/p/red/${mh}/spine/t/t.atlas`, [`/p/red/${mh}/spine/t/t.png`]]);
    assert.deepEqual([front.anims.idle, front.anims.attack.loop, front.hits, front.animations.Attack], ['Idle', 'Attack', { Attack: [0.5] }, 0.5], 'the clip data from the lock');
    // revalidated with its ETag; the view itself is unchanged by any plugin
    assert.equal((await get(`/vs/${set.vs.slice(0, 16)}/assets.json`, { 'If-None-Match': r.headers.etag })).status, 304);
    const overlay = await json(`/vs/${set.vs.slice(0, 16)}/overlay.json`);
    assert.equal(checkVisualDoc(overlay, set.vs), null);
    assert.deepEqual(overlay.ops.map((o) => o.at.join('.')), ['chars.char_102_texas.avatar', 'chars.char_102_texas.spine.front', 'chars.char_x_new', 'ui.hudPanel/icon_hp', 'chars.char_102_texas.avatar']);
    for (const p of [`/vs/${'0'.repeat(16)}/assets.json`, `/vs/${set.vs}/assets.json`, `/vs/${set.vs.slice(0, 16)}/other.json`, '/vs/']) assert.equal((await get(p)).status, 404, p);
  });

  test('a plugin\'s own set (the catalogue\'s vs) is served without anybody resolving it: a personal plugin\'s overlay', async () => {
    const cat = await json('/plugins/index.json');
    const mine = cat.plugins.find((p) => p.id === 'mine');
    assert.deepEqual([mine.status, mine.unofficial, mine.scope, typeof mine.vs, mine.artBytes], ['loaded', true, ['personal'], 'string', registry.plugin('mine').visual.bytes]);
    assert.equal(cat.plugins.find((p) => p.id === 'gameplay').vs, undefined, 'only a loaded cosmetic plugin has one');
    const doc = await json(`/vs/${mine.vs.slice(0, 16)}/overlay.json`);
    assert.equal(checkVisualDoc(doc, mine.vs), null);
    assert.equal(doc.ops.length, 1);
    assert.match(doc.ops[0].value, /^\/p\/mine\/[0-9a-f]{8}\/m\.png$/);
  });

  test('GET /p/: only a file an overlay names, immutable at the hash of its bytes (its own or its model\'s), no-cache at another', async () => {
    const red = registry.plugin('red').visual;
    const avatar = red.served.get('art/red.png');
    const own = avatar.sha256.slice(0, 8);
    const r = await get(`/p/red/${own}/art/red.png`);
    assert.deepEqual([r.status, r.headers['cache-control'], r.headers['content-type'], r.headers.etag], [200, 'public, max-age=31536000, immutable', 'image/png', `"${avatar.sha256.slice(0, 16)}"`]);
    assert.equal(sha(r.body), avatar.sha256, 'the very bytes');
    const mh = modelHashOf(['spine/t/t.skel', 'spine/t/t.atlas', 'spine/t/t.png'].map((rel) => red.served.get(rel).sha256)).slice(0, 8);
    for (const rel of ['spine/t/t.skel', 'spine/t/t.atlas', 'spine/t/t.png']) assert.equal((await get(`/p/red/${mh}/${rel}`)).headers['cache-control'], 'public, max-age=31536000, immutable', rel);
    const other = await get('/p/red/00000000/art/red.png');
    assert.deepEqual([other.status, other.headers['cache-control']], [200, 'no-cache'], 'another hash: the current file, revalidated');
    assert.equal((await get(`/p/red/${own}/art/red.png`, { 'If-None-Match': r.headers.etag })).status, 304);
    // never served: what the overlay does not name, the manifest, the lock, documents, dot files, paths out of the folder
    const refused = ['/p/red/00000000/plugin.json', '/p/red/00000000/plugin.lock.json', '/p/red/00000000/README.md', '/p/red/00000000/notes.txt',
      '/p/red/00000000/art/unused.png', '/p/red/00000000/.hidden.png', '/p/red/00000000/../red/art/red.png', '/p/red/00000000/art/%2e%2e/plugin.json',
      '/p/red/00000000/art%2f..%2f..%2fplugin.json', '/p/red/0000000/art/red.png', '/p/red/abcdefgz/art/red.png', '/p/Red/00000000/art/red.png',
      '/p/absent/00000000/x.png', '/p/gameplay/00000000/d.json', '/p/red/00000000/', '/p/red/', '/p/', '/p/red/00000000/art/red.png%00'];
    for (const p of refused) assert.ok([400, 403, 404].includes((await get(p)).status), `${p} must not be served`);
    assert.equal((await get('/p/red/00000000/art%5cred.png')).status, 400, 'a backslash is no path');
  });

  test('GET /p/: a link put in place of a served file after the scan, leading out of the folder, is not followed', async (t) => {
    const outside = path.join(root, 'secret.png');
    fs.writeFileSync(outside, 'not for players');
    const target = path.join(root, 'plugins', 'blue', 'blue.png');
    const saved = fs.readFileSync(target);
    const h = registry.plugin('blue').visual.served.get('blue.png').sha256.slice(0, 8);
    fs.rmSync(target);
    try {
      fs.symlinkSync(outside, target);
    } catch {
      fs.writeFileSync(target, saved);
      t.skip('no symbolic links on this file system');
      return;
    }
    try {
      assert.equal((await get(`/p/blue/${h}/blue.png`)).status, 404);
    } finally {
      fs.rmSync(target, { force: true });
      fs.writeFileSync(target, saved);
    }
  });

  test('a changed byte: the old hash serves the new file with no-cache; once the folders are read again, a new vs and an immutable URL', async () => {
    const before = registry.plugin('blue').visual;
    const old = before.served.get('blue.png');
    const set0 = visual.resolve(['blue']).set;
    const file = path.join(root, 'plugins', 'blue', 'blue.png');
    fs.writeFileSync(file, png(4, 4, [0, 0, 254, 255]));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const r = await get(`/p/blue/${old.sha256.slice(0, 8)}/blue.png`);
    assert.deepEqual([r.status, r.headers['cache-control']], [200, 'no-cache'], 'served, but never as immutable under the old hash');
    assert.equal(sha(r.body), sha(fs.readFileSync(file)));
    registry.rescan();
    const now = registry.plugin('blue').visual;
    assert.notEqual(now.served.get('blue.png').sha256, old.sha256);
    const set1 = visual.resolve(['blue']).set;
    assert.notEqual(set1.vs, set0.vs, 'one changed byte → another vs');
    assert.equal(set1.vs, visualHashOf({ assets: registry.vanillaAssets().sha256, overlays: [now.composition] }));
    assert.equal((await get(`/p/blue/${now.served.get('blue.png').sha256.slice(0, 8)}/blue.png`)).headers['cache-control'], 'public, max-age=31536000, immutable');
  });

  test('no plugin changes the vanilla manifest a page loads (/data/assets.json is the served view as without plugins)', async () => {
    const withPlugins = await get('/data/assets.json');
    const plain = createStaticHandler({ publicDir: path.join(root, 'public'), dataDir: path.join(root, 'data'), sharedDir: path.join(ROOT, 'shared'),
      packsDir: path.join(root, 'packs'), pluginsDir: path.join(root, 'no-plugins'), views: createManifestViews({ dataDir: path.join(root, 'data'), index: assetIndex }), assetIndex });
    const s2 = http.createServer((req, res) => { const p = splitUrl(req.url); plain(req, res, p.rawPath, p.query); });
    await new Promise((r) => s2.listen(0, '127.0.0.1', r));
    try {
      const body = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: s2.address().port, path: '/data/assets.json', agent: false }, (res) => {
          const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
      });
      assert.equal(body.toString('utf8'), withPlugins.body.toString('utf8'));
    } finally { await new Promise((r) => s2.close(r)); }
  });
});
