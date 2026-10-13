// test/studio/studio.test.js — the plugin studio's server side (server/studio/, DESIGN §32.9, the 0.3.0 plan's C5):
//   * who may use it (gate.js): this machine and the local network, a local Host name (no DNS rebinding), the
//     X-SP-Studio header and the studio's own origin on a change — anyone else gets the 404 of a page that does not exist,
//     at the page and at every API route, whatever the method;
//   * the files (files.js): only inside plugins/<id>/ — no traversal, no link followed (a link inside the folder, a
//     folder swapped for a link), only the file types a plugin carries, the size limits (a body over the limit is refused
//     before it is read);
//   * the API: a new plugin from a template and a target, files dropped on a slot (the right names, the overlay set, the
//     old file removed), a reference, a slot emptied, the coded findings, a one-click fix, the preview composition (a
//     draft too, a model not packed yet), pack and a deterministic zip, the list.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../../server/index.js';
import { studioAllowed, isStudioChange, isLocalHost, hostName, studioMode } from '../../server/studio/gate.js';
import { createPluginFiles, StudioError } from '../../server/studio/files.js';
import { suggestId, isStudioPath } from '../../server/studio/index.js';
import { unzipFiles, zipFiles } from '../../server/plugins/zip.js';
import { png, skel, atlas, writePlugin, cosmetic } from '../helpers/pluginFixtures.js';

const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers: { host: 'localhost:3000', ...headers } });

test('gate: loopback and private networks with a local Host name; a public client, a forwarded public client, a foreign Host — refused', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.1.20', '10.0.0.8', '172.16.4.4', '100.100.1.1', 'fd12::1']) {
    assert.equal(studioAllowed(req(ip), { mode: 'lan', hosts: [] }).ok, true, ip);
  }
  for (const ip of ['8.8.8.8', '203.0.113.7', '2001:db8::1']) assert.equal(studioAllowed(req(ip), { mode: 'lan', hosts: [] }).ok, false, ip);
  // a tunnel or proxy on this machine names a public visitor: refused (TRUST_PROXY auto honours a local peer's headers)
  assert.equal(studioAllowed(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), { mode: 'lan', hosts: [] }).ok, false);
  assert.equal(studioAllowed(req('127.0.0.1', { 'cf-connecting-ip': '198.51.100.4' }), { mode: 'lan', hosts: [] }).ok, false);
  assert.equal(studioAllowed(req('127.0.0.1', { 'x-forwarded-for': '192.168.1.7' }), { mode: 'lan', hosts: [] }).ok, true);
  // SP_STUDIO=local: this machine only; off: nobody
  assert.equal(studioAllowed(req('192.168.1.20'), { mode: 'local', hosts: [] }).ok, false);
  assert.equal(studioAllowed(req('127.0.0.1'), { mode: 'local', hosts: [] }).ok, true);
  assert.equal(studioAllowed(req('127.0.0.1'), { mode: 'off', hosts: [] }).ok, false);
  assert.deepEqual([studioMode({}), studioMode({ SP_STUDIO: 'off' }), studioMode({ SP_STUDIO: 'local' }), studioMode({ SP_STUDIO: '0' })], ['lan', 'off', 'local', 'off']);
  // Host names: addresses and local names only (a public name pointed at this machine — DNS rebinding — is refused)
  for (const h of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000', '192.168.1.5', 'mypc:3000', 'nas.local', 'game.lan', 'x.home.arpa', 'a.localhost']) assert.equal(isLocalHost(h), true, h);
  for (const h of ['evil.example.com', 'example.com:3000', '', 'a b', 'localhost.evil.com']) assert.equal(isLocalHost(h), false, h);
  assert.equal(isLocalHost('play.example.org', ['play.example.org']), true, 'SP_STUDIO_HOSTS adds a name');
  assert.equal(studioAllowed(req('127.0.0.1', { host: 'evil.example.com' }), { mode: 'lan', hosts: [] }).ok, false);
  assert.equal(hostName('[::1]:80'), '::1');
  // a change: the header, the same origin
  assert.equal(isStudioChange({ headers: { host: 'localhost:3000', 'x-sp-studio': '1' } }), true);
  assert.equal(isStudioChange({ headers: { host: 'localhost:3000', 'x-sp-studio': '1', origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' } }), true);
  assert.equal(isStudioChange({ headers: { host: 'localhost:3000' } }), false, 'no header');
  assert.equal(isStudioChange({ headers: { host: 'localhost:3000', 'x-sp-studio': '1', origin: 'http://evil.example.com' } }), false, 'another origin');
  assert.equal(isStudioChange({ headers: { host: 'localhost:3000', 'x-sp-studio': '1', 'sec-fetch-site': 'cross-site' } }), false);
});

test('files: confined to plugins/<id>/ — ids, paths, links, types, sizes; a write is atomic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-studio-files-'));
  try {
    const plugins = path.join(dir, 'plugins');
    const f = createPluginFiles(plugins);
    const code = (fn) => { try { fn(); return null; } catch (e) { return e instanceof StudioError ? `${e.code}:${e.status}` : String(e); } };
    assert.equal(code(() => f.root('ab', { create: true })), null);
    assert.equal(code(() => f.root('ab', { create: true })), 'PLUGIN_STUDIO_EXISTS:409');
    assert.equal(code(() => f.root('AB', { create: true })), 'PLUGIN_ID:400', 'upper case is no plugin id');
    for (const bad of ['_template', '.git', '../x', 'A', 'a/b', 'x', 'a']) assert.match(code(() => f.root(bad, { create: true })), /^PLUGIN_ID:400$/, bad);
    assert.equal(code(() => f.root('nope')), 'PLUGIN_UNKNOWN:404');
    f.write('ab', 'art/x.png', png());
    assert.ok(fs.existsSync(path.join(plugins, 'ab', 'art', 'x.png')));
    assert.deepEqual(fs.readdirSync(path.join(plugins, 'ab', 'art')), ['x.png'], 'no temporary file left');
    for (const rel of ['../b.png', 'art/../../b.png', '.hidden.png', 'art/.x/y.png', '/abs.png', 'a\\b.png', ' sp.png', 'x'.repeat(201) + '.png']) {
      assert.match(code(() => f.write('ab', rel, png())), /^PLUGIN_STUDIO_PATH:400$/, rel);
    }
    assert.equal(code(() => f.write('ab', 'run.exe', Buffer.from('x'))), 'PLUGIN_FILE_TYPE:400');
    assert.equal(code(() => f.write('ab', 'plugin.lock.json', Buffer.from('{}'))), 'PLUGIN_FILE_TYPE:400', 'the lock is the packer\'s');
    assert.equal(code(() => f.write('ab', 'plugin.json', Buffer.alloc(1024 * 1024 + 1, 32))), 'PLUGIN_STUDIO_SIZE:413');
    // links: a link inside the folder (to a file or a folder outside) is never followed, for reading or writing
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.png'), 'secret');
    fs.symlinkSync(path.join(outside, 'secret.png'), path.join(plugins, 'ab', 'link.png'));
    fs.symlinkSync(outside, path.join(plugins, 'ab', 'out'));
    assert.equal(code(() => f.stat('ab', 'link.png')), 'PLUGIN_STUDIO_PATH:403');
    assert.equal(code(() => f.write('ab', 'link.png', png())), 'PLUGIN_STUDIO_PATH:403');
    assert.equal(code(() => f.write('ab', 'out/new.png', png())), 'PLUGIN_STUDIO_PATH:403');
    assert.equal(code(() => f.remove('ab', 'out/secret.png')), 'PLUGIN_STUDIO_PATH:403');
    assert.equal(fs.readFileSync(path.join(outside, 'secret.png'), 'utf8'), 'secret', 'nothing outside was touched');
    assert.deepEqual(fs.readdirSync(outside), ['secret.png']);
    // a plugin folder that is itself a link (the owner's choice, as the registry allows) is followed once
    const real = path.join(dir, 'elsewhere');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(plugins, 'linked'));
    f.write('linked', 'a.png', png());
    assert.ok(fs.existsSync(path.join(real, 'a.png')));
    // remove: plain files, empty folders go with them, never plugin.json
    f.write('ab', 'plugin.json', Buffer.from('{}'));
    assert.equal(code(() => f.remove('ab', 'plugin.json')), 'PLUGIN_STUDIO_PATH:400');
    f.remove('ab', 'art/x.png');
    assert.equal(fs.existsSync(path.join(plugins, 'ab', 'art')), false);
    assert.deepEqual(f.ids(), ['ab', 'linked']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('isStudioPath: every spelling a static server would map to public/studio/', () => {
  for (const p of ['/studio', '/studio/', '/Studio/x', '//studio/', '/%73tudio/', '/STUDIO', '/studio%2Fapi']) assert.equal(isStudioPath(p), true, p);
  for (const p of ['/', '/studios/', '/js/studio.js', '/studio.html', '/%E0%A4%A']) assert.equal(isStudioPath(p), false, p);
});

test('suggestId: from Latin letters of the name, else from the target and the template; free and legal', () => {
  const taken = new Set(['texas-art']);
  assert.equal(suggestId({ name: 'Red Texas!' }, taken), 'red-texas');
  assert.equal(suggestId({ name: '红色德克萨斯', target: { key: 'char_102_texas' }, template: 'art' }, taken), 'texas-art-2');
  assert.equal(suggestId({ name: '', target: { key: 'enemy_1007_slime' }, template: 'spine' }, new Set()), 'slime-spine');
  assert.equal(suggestId({ name: '音乐' }, new Set()), 'plugin');
  assert.match(suggestId({ name: 'x'.repeat(80) }, new Set()), /^[a-z0-9][a-z0-9-]{1,31}$/);
});

test('zip: deterministic (the same files give the same bytes), stored media, deflated text, a round trip', () => {
  const files = [{ name: 'p/b.png', data: png(8, 8) }, { name: 'p/plugin.json', data: Buffer.from(JSON.stringify({ a: 'x'.repeat(500) })) }, { name: 'p/中文.md', data: Buffer.from('说明') }];
  const a = zipFiles(files);
  const b = zipFiles([...files].reverse());
  assert.ok(a.equals(b), 'order and time do not matter');
  const back = unzipFiles(a);
  assert.deepEqual(back.map((e) => e.name), ['p/b.png', 'p/plugin.json', 'p/中文.md']);
  for (const e of back) assert.ok(e.data.equals(files.find((f) => f.name === e.name).data), e.name);
  assert.ok(a.length < files.reduce((n, f) => n + f.data.length, 0) + 400, 'the JSON was deflated');
});

describe('the studio over HTTP', () => {
  let srv;
  let tmp;
  let plugins;
  const H = { 'x-sp-studio': '1', 'content-type': 'application/json' };
  const call = async (method, url, body, headers = H) => {
    const r = await fetch(srv.url + url, { method, headers, body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
  };
  /** A raw request (any Host header, a body over its declared length). */
  const raw = (method, url, headers = {}, body = null) => new Promise((resolve, reject) => {
    const u = new URL(srv.url + url);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
  const b64 = (buf) => Buffer.from(buf).toString('base64');

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-studio-http-'));
    plugins = path.join(tmp, 'plugins');
    writePlugin(path.join(plugins, 'handmade'), cosmetic({ colour: 'red', assets: { chars: { char_102_texas: { avatar: 'a.png' } } } }), { 'a.png': png(), 'notes.psd': 'x' });
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, pluginsDir: plugins, assetIndex: false });
  });
  after(async () => { await srv?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  test('the page and every API route answer 404 to a foreign Host, a forwarded public client, a change without the header', async () => {
    assert.equal((await raw('GET', '/studio/')).status, 200);
    assert.equal((await raw('GET', '/studio')).status, 301);
    for (const url of ['/studio/', '/studio/api/info', '/studio/api/plugins', '/studio/js/main.js', '/studio/studio.css']) {
      assert.equal((await raw('GET', url, { host: 'evil.example.com' })).status, 404, `${url}: foreign Host`);
      assert.equal((await raw('GET', url, { 'x-forwarded-for': '203.0.113.9' })).status, 404, `${url}: forwarded public client`);
    }
    const page = await raw('GET', '/studio/api/info', { 'x-forwarded-for': '203.0.113.9' });
    assert.match(page.text, /页面不存在 · Not found/, 'the same page as any missing one');
    // changes: the header, the studio's own origin; OPTIONS (a preflight) gets no answer that allows anything
    assert.equal((await raw('POST', '/studio/api/plugins', { 'content-type': 'application/json' }, '{}')).status, 404, 'no X-SP-Studio');
    assert.equal((await raw('POST', '/studio/api/plugins', { 'x-sp-studio': '1', origin: 'http://evil.example.com' }, '{}')).status, 404, 'another origin');
    const pre = await raw('OPTIONS', '/studio/api/plugins', { origin: 'http://evil.example.com', 'access-control-request-method': 'POST' });
    assert.ok(pre.status === 404 || pre.status === 405, `preflight ${pre.status}`);
    assert.equal((await raw('DELETE', '/studio/api/plugins/handmade/files/a.png', { 'x-forwarded-for': '203.0.113.9', 'x-sp-studio': '1' })).status, 404);
    assert.ok(fs.existsSync(path.join(plugins, 'handmade', 'a.png')), 'nothing was removed');
    // another spelling of the prefix never reaches the page — neither through the studio nor through the static mounts
    for (const url of ['/Studio/', '/STUDIO/api/info', '//studio/', '/%73tudio/', '/studio%2Fapi/info', '//studio/js/main.js']) {
      assert.equal((await raw('GET', url)).status, 404, url);
    }
    // the game's pages are untouched by the studio's routes
    assert.equal((await raw('GET', '/')).status, 200);
    assert.equal((await raw('POST', '/')).status, 405);
  });

  test('a server without a studio (startServer studio: false) never serves its page as a static file', async () => {
    const other = await startServer({ port: 0, host: '127.0.0.1', quiet: true, pluginsDir: plugins, assetIndex: false, studio: false });
    try {
      for (const u of ['/studio/', '/studio/index.html', '/studio/js/main.js', '/Studio/', '/studio']) assert.equal((await fetch(other.url + u)).status, 404, u);
      assert.equal(other.studio, null);
    } finally { await other.close(); }
  });

  test('a new plugin from a template; files on a slot; a reference; a slot emptied; the preview; pack and zip; the list', async () => {
    const info = await call('GET', '/studio/api/info');
    assert.deepEqual(info.body.templates.map((t) => t.id), ['art', 'spine', 'voice', 'audio']);
    const found = await call('GET', `/studio/api/targets?q=${encodeURIComponent('德克萨斯')}&kinds=operator`);
    assert.equal(found.body.targets[0].key, 'char_102_texas');
    const slots = await call('GET', '/studio/api/slots?template=art&target=operator:char_102_texas');
    assert.deepEqual(slots.body.slots.map((s) => s.field), ['avatar', 'avatarE2', 'portrait', 'portraitE2']);
    let r = await call('POST', '/studio/api/plugins', { template: 'art', id: 'red-texas', name: '红色德克萨斯', target: 'operator:char_102_texas', authors: ['me'], license: 'CC-BY-4.0' });
    assert.equal(r.status, 201);
    assert.deepEqual([r.body.loaded, r.body.check.ok, r.body.sections], [true, true, [{ template: 'art', target: 'operator:char_102_texas' }]]);
    const m0 = JSON.parse(fs.readFileSync(path.join(plugins, 'red-texas', 'plugin.json'), 'utf8'));
    assert.deepEqual([m0.manifest, m0.class, m0.name, m0.license, m0.assets], [2, 'cosmetic', { zh: '红色德克萨斯' }, 'CC-BY-4.0', { chars: { char_102_texas: {} } }]);
    assert.equal((await call('POST', '/studio/api/plugins', { template: 'art', id: 'red-texas', name: 'x' })).body.error, 'PLUGIN_STUDIO_EXISTS');
    assert.equal((await call('POST', '/studio/api/plugins', { template: 'nope', id: 'zz-1' })).body.error, 'PLUGIN_STUDIO_TEMPLATE');
    assert.equal((await call('POST', '/studio/api/plugins', { template: 'voice', id: 'zz-2', target: 'music:lobby' })).body.error, 'PLUGIN_STUDIO_TARGET');
    // a picture on the avatar slot: art/<key>/avatar.png, the overlay set, loaded at once
    r = await call('POST', '/studio/api/plugins/red-texas/slot', { at: ['chars', 'char_102_texas', 'avatar'], files: [{ name: 'my red.PNG', data: b64(png(4, 4, [255, 0, 0, 255])) }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.overlay, { chars: { char_102_texas: { avatar: 'art/char_102_texas/avatar.png' } } });
    assert.equal(r.body.loaded, true);
    // the same slot, a WebP: the old PNG goes, the new file takes its place
    r = await call('POST', '/studio/api/plugins/red-texas/slot', { at: ['chars', 'char_102_texas', 'avatar'], files: [{ name: 'b.webp', data: b64(Buffer.from('RIFF....WEBP')) }] });
    assert.deepEqual(r.body.files.filter((f) => f.rel.startsWith('art/')).map((f) => f.rel), ['art/char_102_texas/avatar.webp']);
    // the wrong kind of file for a slot
    const wrong = await call('POST', '/studio/api/plugins/red-texas/slot', { at: ['chars', 'char_102_texas', 'portrait'], files: [{ name: 'a.mp3', data: b64('x') }] });
    assert.deepEqual([wrong.status, wrong.body.error], [400, 'PLUGIN_STUDIO_FILE_KIND']);
    // a reference, then the slot emptied
    r = await call('POST', '/studio/api/plugins/red-texas/ref', { at: ['chars', 'char_102_texas', 'portrait'], ref: 'char_112_siege' });
    assert.deepEqual(r.body.overlay.chars.char_102_texas.portrait, { ref: 'char_112_siege' });
    r = await call('POST', '/studio/api/plugins/red-texas/ref', { at: ['chars', 'char_102_texas', 'portraitE2'], ref: 'char_000_nobody' });
    assert.ok(r.body.check.issues.some((i) => i.code === 'PLUGIN_REF' && i.at.join('.') === 'assets.chars.char_102_texas.portraitE2'), 'the finding beside its slot');
    r = await call('POST', '/studio/api/plugins/red-texas/clear', { at: ['chars', 'char_102_texas', 'portraitE2'] });
    assert.equal(r.body.check.ok, true);
    // the preview: the plugin's file at the studio's URL, the reference to copy, a draft's too
    const pv = await call('GET', '/studio/api/plugins/red-texas/preview');
    assert.deepEqual(pv.body.ops.map((o) => [o.at.join('.'), o.value ? 'value' : 'from']), [['chars.char_102_texas.avatar', 'value'], ['chars.char_102_texas.portrait', 'from']]);
    assert.match(pv.body.ops[0].value, /^\/studio\/api\/plugins\/red-texas\/f\/[0-9a-f]{8}\/art\/char_102_texas\/avatar\.webp$/);
    assert.equal((await call('GET', pv.body.ops[0].value)).status, 200);
    // meta: the basic fields
    r = await call('POST', '/studio/api/plugins/red-texas/meta', { fields: { version: '1.0.1', credits: '我自己画的', scope: ['personal'] }, lang: 'zh' });
    assert.equal(r.body.version, '1.0.1');
    const m1 = JSON.parse(fs.readFileSync(path.join(plugins, 'red-texas', 'plugin.json'), 'utf8'));
    assert.deepEqual([m1.version, m1.credits, m1.scope], ['1.0.1', '我自己画的', ['personal']]);
    assert.equal((await call('POST', '/studio/api/plugins/red-texas/meta', { fields: { version: '1.0' } })).body.error, 'PLUGIN_VERSION');
    // pack: the lock; the zip: every file under <id>/, the same bytes twice
    r = await call('POST', '/studio/api/plugins/red-texas/pack', {});
    assert.deepEqual([r.body.pack.wrote, r.body.check.ok, r.body.lock.present, r.body.lock.fresh], [true, true, true, true]);
    const z1 = await call('GET', '/studio/api/plugins/red-texas/zip');
    assert.equal(z1.headers.get('content-disposition'), 'attachment; filename="red-texas-1.0.1.zip"');
    assert.deepEqual(unzipFiles(z1.body).map((e) => e.name), ['red-texas/README.md', 'red-texas/art/char_102_texas/avatar.webp', 'red-texas/plugin.json', 'red-texas/plugin.lock.json']);
    assert.ok((await call('GET', '/studio/api/plugins/red-texas/zip')).body.equals(z1.body), 'deterministic');
    const list = await call('GET', '/studio/api/plugins');
    assert.deepEqual(list.body.plugins.map((p) => [p.id, p.status, p.codes]), [['handmade', 'skipped', ['PLUGIN_FILE_TYPE']], ['red-texas', 'loaded', []]], 'the hand-made one keeps a .psd: skipped, with its code');
  });

  test('a hand-made plugin: its sections read off its overlay; the findings coded; one-click fixes; a file type moved out, never deleted', async () => {
    let r = await call('GET', '/studio/api/plugins/handmade');
    assert.deepEqual(r.body.sections, [{ template: 'art', target: 'operator:char_102_texas' }]);
    assert.deepEqual(r.body.check.issues.map((i) => i.code).sort(), ['PLUGIN_FIELD_UNKNOWN', 'PLUGIN_FILE_TYPE']);
    assert.equal(r.body.loaded, false, 'the .psd keeps it out');
    r = await call('POST', '/studio/api/plugins/handmade/fix', { code: 'PLUGIN_FIELD_UNKNOWN', at: ['colour'] });
    assert.deepEqual(r.body.fixed, { code: 'PLUGIN_FIELD_UNKNOWN', did: 'removed "colour"' });
    r = await call('POST', '/studio/api/plugins/handmade/fix', { code: 'PLUGIN_FILE_TYPE', file: 'notes.psd' });
    assert.equal(r.body.loaded, true);
    assert.equal(fs.readFileSync(path.join(plugins, '_moved', 'handmade', 'notes.psd'), 'utf8'), 'x', 'moved into plugins/_moved/ (never read by the registry)');
    assert.equal((await call('POST', '/studio/api/plugins/handmade/fix', { code: 'PLUGIN_VERSION_X' })).body.error, 'PLUGIN_STUDIO_REQUEST');
    // a missing permission fixed in one click
    fs.writeFileSync(path.join(plugins, 'handmade', 'plugin.json'), JSON.stringify(cosmetic({ permissions: [], assets: { chars: { char_102_texas: { avatar: 'a.png' } } } })));
    r = await call('GET', '/studio/api/plugins/handmade');
    const miss = r.body.check.issues.find((i) => i.code === 'PLUGIN_PERMISSION_MISSING');
    r = await call('POST', '/studio/api/plugins/handmade/fix', { code: miss.code, at: miss.at, params: miss.params });
    assert.deepEqual([r.body.check.ok, r.body.manifest.permissions], [true, ['assets.override']]);
  });

  test('a model on a slot: one name for the skeleton and its atlas, the pages by theirs, textures from the atlas; previewed before it is packed', async () => {
    await call('POST', '/studio/api/plugins', { template: 'spine', id: 'model', name: 'model', target: 'operator:char_102_texas' });
    const r = await call('POST', '/studio/api/plugins/model/slot', { at: ['chars', 'char_102_texas', 'spine', 'front'], files: [
      { name: 'exported.skel', data: b64(skel()) }, { name: 'whatever.atlas', data: b64(atlas(['page one.png'])) }, { name: 'page one.png', data: b64(png()) }] });
    assert.deepEqual(r.body.overlay.chars.char_102_texas.spine.front, { skel: 'spine/char_102_texas/front/char_102_texas.skel', atlas: 'spine/char_102_texas/front/char_102_texas.atlas', textures: ['spine/char_102_texas/front/page one.png'] });
    assert.deepEqual(r.body.check.issues.map((i) => i.code), ['PLUGIN_LOCK_MISSING'], 'not packed yet');
    const pv = await call('GET', '/studio/api/plugins/model/preview');
    const sp = pv.body.ops[0].value;
    assert.deepEqual([sp.anims.idle, Object.keys(sp.animations).sort()], ['Idle', ['Attack', 'Die', 'Idle', 'Start']], 'the clips read from the skeleton itself');
    const hash = sp.skel.split('/')[5];
    assert.ok([sp.atlas, ...sp.textures].every((u) => u.split('/')[5] === hash), 'one folder for the model\'s files');
    const fixed = await call('POST', '/studio/api/plugins/model/fix', { code: 'PLUGIN_LOCK_MISSING' });
    assert.deepEqual([fixed.body.check.ok, fixed.body.loaded], [true, true]);
  });

  test('limits: a body over the limit is refused before it is read; a file the studio does not write; a path out of the folder', async () => {
    const big = await raw('POST', '/studio/api/plugins/model/slot', { 'x-sp-studio': '1', 'content-type': 'application/json', 'content-length': String(400 * 1024 * 1024) });
    assert.equal(big.status, 413);
    assert.equal(JSON.parse(big.text).error, 'PLUGIN_STUDIO_SIZE');
    assert.equal((await call('PUT', '/studio/api/plugins/model/files/run.exe', 'x', { 'x-sp-studio': '1' })).body.error, 'PLUGIN_FILE_TYPE');
    assert.equal((await call('PUT', '/studio/api/plugins/model/files/..%2F..%2Fx.png', 'x', { 'x-sp-studio': '1' })).body.error, 'PLUGIN_STUDIO_PATH');
    assert.equal((await call('GET', '/studio/api/plugins/..%2Fx')).status, 400);
    assert.equal(fs.existsSync(path.join(tmp, 'x.png')), false);
  });
});
