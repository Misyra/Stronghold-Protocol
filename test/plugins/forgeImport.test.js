// test/plugins/forgeImport.test.js — Forge workshop import (DESIGN §32.12, docs/PLUGINS.md §16).
// The three packs under test/fixtures/forge/ are written for this test (no official art, nothing copied from Forge).
// A cosmetic product must resolve through createVisualSets with no problems and no warnings. A content product must
// come back from buildContentSet with an empty problems list. There is no buildVisualSet symbol.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../../tools/plugin.mjs';
import { importForge, readUntrustedZip } from '../../server/plugins/forgeImport.js';
import { crc32 } from '../../server/plugins/zip.js';
import { createPluginRegistry, readVanillaAssets } from '../../server/plugins/registry.js';
import { createVisualSets } from '../../server/plugins/visualSet.js';
import { buildContentSet } from '../../server/plugins/contentSet.js';
import { PLUGIN_LIMITS } from '../../shared/plugins/manifest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'forge');
const BAIT = '/tmp/sp-forge-bait-wp-h.txt';
const vanilla = readVanillaAssets(path.join(ROOT, 'data'));

const quiet = async (argv) => {
  const out = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try { return { code: await main(argv), out: out.join('\n') }; }
  finally { console.log = log; console.error = err; }
};

function walk(dir, rel = '') {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const next = rel ? `${rel}/${name}` : name;
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) out.push(...walk(abs, next));
    else out.push(next);
  }
  return out;
}

function zipEntry({ name, data = Buffer.alloc(0), rawSize = data.length, method = 0, external = (0o100644 << 16) >>> 0 }) {
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(rawSize >>> 0, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(rawSize >>> 0, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(external, 38);
  return { local: Buffer.concat([local, nameBuf, data]), central, nameBuf };
}

function zipOf(entries) {
  const built = entries.map(zipEntry);
  let offset = 0;
  const parts = [];
  const centrals = [];
  for (const b of built) {
    b.central.writeUInt32LE(offset, 42);
    parts.push(b.local);
    centrals.push(b.central, b.nameBuf);
    offset += b.local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(built.length, 8);
  eocd.writeUInt16LE(built.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

async function importPack(name, { dryRun = false, json = false } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-forge-'));
  const id = name === 'skin-pack' ? 'rose-skin' : name === 'numbers-pack' ? 'rose-numbers' : 'rose-mixed';
  const argv = ['import-forge', path.join(FIXTURES, name), '--out', path.join(parent, id), '--root', ROOT];
  if (dryRun) argv.push('--dry-run');
  if (json) argv.push('--json');
  const r = await quiet(argv);
  return { parent, id, ...r };
}

function setsOf(parent) {
  const registry = createPluginRegistry({
    publicDir: path.join(ROOT, 'public'), packsDir: path.join(ROOT, 'packs'), pluginsDir: parent, dataDir: path.join(ROOT, 'data'),
  }, { recheckMs: 0, log: { info() {}, warn() {} } });
  return { registry, visual: createVisualSets({ registry }) };
}

test('skin pack: cosmetic overlay, check --strict, pack, visual set with no problems', async () => {
  fs.rmSync(BAIT, { force: true });
  const got = await importPack('skin-pack');
  try {
    assert.equal(got.code, 0, got.out);
    const dir = path.join(got.parent, 'rose-skin');
    assert.ok(fs.existsSync(path.join(dir, 'IMPORT-REPORT.md')));
    assert.match(fs.readFileSync(path.join(dir, 'IMPORT-REPORT.md'), 'utf8'), /audio\.voiceJp/);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    assert.equal(manifest.class, 'cosmetic');
    assert.deepEqual(manifest.permissions, ['assets.override']);
    const check = await quiet(['check', dir, '--strict', '--root', ROOT]);
    assert.equal(check.code, 0, check.out);
    const pack = await quiet(['pack', dir, '--root', ROOT]);
    assert.equal(pack.code, 0, pack.out);
    const { visual } = setsOf(got.parent);
    const set = visual.resolve(['rose-skin']);
    assert.equal(set.ok, true, JSON.stringify(set));
    assert.deepEqual(set.set.warnings, []);
    assert.equal(fs.existsSync(BAIT), false);
  } finally { fs.rmSync(got.parent, { recursive: true, force: true }); }
});

test('boss music and ui sounds become a cosmetic overlay; an unknown sound bucket is named and left out', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-forge-'));
  const pack = path.join(parent, 'pack');
  fs.mkdirSync(path.join(pack, 'audio'), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'skin-pack', 'voice', 'select.mp3'), path.join(pack, 'audio', 'click.mp3'));
  fs.copyFileSync(path.join(FIXTURES, 'skin-pack', 'voice', 'select.mp3'), path.join(pack, 'audio', 'boss.mp3'));
  fs.writeFileSync(path.join(pack, 'pack.json'), JSON.stringify({
    id: 'rose-audio', name: '玫瑰音效', version: '1.0.0', license: 'CC0-1.0', content: [],
    art: { audio: { bossBgm: { roseboss: 'audio/boss.mp3' }, sfx: { ui: { click: 'audio/click.mp3' }, nope: { x: 'audio/click.mp3' } } } },
  }));
  const out = path.join(parent, 'out');
  const r = await quiet(['import-forge', pack, '--out', path.join(out, 'rose-audio'), '--root', ROOT]);
  try {
    assert.equal(r.code, 0, r.out);
    const dir = path.join(out, 'rose-audio');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    const overlay = JSON.parse(fs.readFileSync(path.join(dir, 'assets.json'), 'utf8'));
    assert.equal(manifest.class, 'cosmetic');
    assert.equal(overlay.audio.sfx.ui.click, 'files/audio/click.mp3');
    assert.equal(overlay.audio.bossBgm.roseboss.loop, 'files/audio/boss.mp3');
    assert.equal(overlay.audio.sfx.nope, undefined);
    const report = fs.readFileSync(path.join(dir, 'IMPORT-REPORT.md'), 'utf8');
    assert.match(report, /art\.audio\.sfx\.nope/);
    assert.match(report, /ui、battle、units/);
    const check = await quiet(['check', dir, '--strict', '--root', ROOT]);
    assert.equal(check.code, 0, check.out);
    const packed = await quiet(['pack', dir, '--root', ROOT]);
    assert.equal(packed.code, 0, packed.out);
    const { visual } = setsOf(out);
    const set = visual.resolve(['rose-audio']);
    assert.equal(set.ok, true, JSON.stringify(set));
    assert.deepEqual(set.set.warnings, []);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('numbers pack: bond patch, operator and enemy, content set with no problems, kit script not run', async () => {
  fs.rmSync(BAIT, { force: true });
  const got = await importPack('numbers-pack');
  try {
    assert.equal(got.code, 0, got.out);
    const dir = path.join(got.parent, 'rose-numbers');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    assert.equal(manifest.class, 'content');
    assert.deepEqual(manifest.permissions, ['data.patch', 'data.add']);
    const op = JSON.parse(fs.readFileSync(path.join(dir, 'operators', 'imported.json'), 'utf8'));
    assert.equal(op.profession, 'TANK');
    assert.equal(op.as, 'chess');
    assert.equal(op.kit, 'generic');
    assert.deepEqual(op.chess.bonds, ['deputShip']);
    assert.match(op.charId, /^char_x_rose_numbers_/);
    const enemy = JSON.parse(fs.readFileSync(path.join(dir, 'enemies', 'imported.json'), 'utf8'));
    assert.equal(enemy.base, 'enemy_1422_lrsldr');
    assert.equal(enemy.set.stats.maxHp, 6000);
    assert.match(enemy.id, /^enemy_x_rose_numbers_/);
    const report = fs.readFileSync(path.join(dir, 'IMPORT-REPORT.md'), 'utf8');
    assert.match(report, /通用 kit/);
    assert.match(report, /kits\/guard\.js/);
    assert.equal(walk(dir).some((f) => f.endsWith('.js')), false);
    const check = await quiet(['check', dir, '--strict', '--root', ROOT]);
    assert.equal(check.code, 0, check.out);
    const pack = await quiet(['pack', dir, '--root', ROOT]);
    assert.equal(pack.code, 0, pack.out);
    const { registry } = setsOf(got.parent);
    const set = buildContentSet({ registry, ids: ['rose-numbers'] });
    assert.deepEqual(set.problems, [], JSON.stringify(set.problems));
    assert.equal(fs.existsSync(BAIT), false);
  } finally { fs.rmSync(got.parent, { recursive: true, force: true }); }
});

test('mixed pack: cosmetic, content, ui and lang; refused pieces named with their reasons', async () => {
  fs.rmSync(BAIT, { force: true });
  const got = await importPack('mixed-pack');
  try {
    assert.equal(got.code, 0, got.out);
    const ids = fs.readdirSync(got.parent).filter((n) => !n.startsWith('.')).sort();
    assert.deepEqual(ids, ['rose-mixed', 'rose-mixed-en', 'rose-mixed-hud-right', 'rose-mixed-look']);
    const report = fs.readFileSync(path.join(got.parent, 'rose-mixed', 'IMPORT-REPORT.md'), 'utf8');
    assert.match(report, /服务端逻辑/);
    assert.match(report, /server logic/);
    assert.match(report, /HTTP 路由/);
    assert.match(report, /root\.overlays/);
    assert.match(report, /对不上我们的界面插槽/);
    assert.match(report, /extra\/note\.png/);
    assert.match(report, /没有引用它/);
    assert.match(report, /kits\/boom\.js/);
    assert.match(report, /不执行/);
    const ui = JSON.parse(fs.readFileSync(path.join(got.parent, 'rose-mixed-hud-right', 'plugin.json'), 'utf8'));
    assert.deepEqual(ui.slots, ['hud.right']);
    assert.match(fs.readFileSync(path.join(got.parent, 'rose-mixed-hud-right', 'ui', 'index.html'), 'utf8'), /postMessage API v1/);
    const lang = JSON.parse(fs.readFileSync(path.join(got.parent, 'rose-mixed-en', 'plugin.json'), 'utf8'));
    assert.equal(lang.class, 'lang');
    assert.equal(lang.lang, 'en');
    for (const id of ids) {
      const dir = path.join(got.parent, id);
      const check = await quiet(['check', dir, '--strict', '--root', ROOT]);
      assert.equal(check.code, 0, `${id}\n${check.out}`);
      const pack = await quiet(['pack', dir, '--root', ROOT]);
      assert.equal(pack.code, 0, `${id}\n${pack.out}`);
      assert.equal(walk(dir).some((f) => f.endsWith('.js')), false, id);
    }
    const { registry, visual } = setsOf(got.parent);
    const look = visual.resolve(['rose-mixed-look']);
    assert.equal(look.ok, true, JSON.stringify(look));
    assert.deepEqual(look.set.warnings, []);
    const content = buildContentSet({ registry, ids: ['rose-mixed'] });
    assert.deepEqual(content.problems, [], JSON.stringify(content.problems));
    assert.equal(fs.existsSync(BAIT), false);
  } finally { fs.rmSync(got.parent, { recursive: true, force: true }); }
});

test('--dry-run writes nothing; --json is stable and has no home path', async () => {
  const a = await importPack('skin-pack', { dryRun: true, json: true });
  const b = await importPack('skin-pack', { dryRun: true, json: true });
  try {
    assert.equal(a.code, 0, a.out);
    assert.equal(b.code, 0, b.out);
    assert.equal(a.out, b.out);
    const report = JSON.parse(a.out);
    assert.equal(report.ok, true);
    assert.equal(report.dryRun, true);
    assert.equal(report.wrote, false);
    assert.equal(report.products[0].id, 'rose-skin');
    assert.equal(fs.readdirSync(a.parent).length, 0);
    assert.equal(fs.readdirSync(b.parent).length, 0);
    assert.equal(a.out.includes(os.homedir()), false);
    assert.equal(a.out.includes('/Users/'), false);
  } finally {
    fs.rmSync(a.parent, { recursive: true, force: true });
    fs.rmSync(b.parent, { recursive: true, force: true });
  }
});

test('a second import into the same folder is refused and leaves the first folder as it was', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-forge-'));
  try {
    const first = await importForge(path.join(FIXTURES, 'skin-pack'), { pluginsDir: parent, root: ROOT, dataDir: path.join(ROOT, 'data'), vanilla });
    assert.equal(first.ok, true, first.markdown);
    const before = fs.readFileSync(path.join(parent, 'rose-skin', 'plugin.json'));
    const second = await importForge(path.join(FIXTURES, 'skin-pack'), { pluginsDir: parent, root: ROOT, dataDir: path.join(ROOT, 'data'), vanilla });
    assert.equal(second.ok, false);
    assert.equal(second.issues[0].code, 'PLUGIN_FORGE_EXISTS');
    assert.ok(before.equals(fs.readFileSync(path.join(parent, 'rose-skin', 'plugin.json'))));
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('malicious zip and directory input is refused and a script in the pack is not executed', async () => {
  fs.rmSync(BAIT, { force: true });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-forge-'));
  const opts = { pluginsDir: parent, root: ROOT, dataDir: path.join(ROOT, 'data'), vanilla };
  try {
    const slip = await importForge({ zip: zipOf([{ name: '../slip.txt', data: Buffer.from('no') }, { name: 'pack.json', data: Buffer.from('{"id":"rose-slip","name":"x","version":"1.0.0"}') }]) }, opts);
    assert.equal(slip.ok, false);
    assert.equal(slip.issues[0].code, 'PLUGIN_FORGE_ZIP');
    assert.match(slip.issues[0].detail, /path escapes/);

    const link = await importForge({ zip: zipOf([{ name: 'link.txt', data: Buffer.from('/tmp/x'), external: (0o120000 << 16) >>> 0 }, { name: 'pack.json', data: Buffer.from('{"id":"rose-link","name":"x","version":"1.0.0"}') }]) }, opts);
    assert.equal(link.issues[0].code, 'PLUGIN_FORGE_ZIP');
    assert.match(link.issues[0].detail, /symbolic link/);

    const huge = await importForge({ zip: zipOf([{ name: 'pack.json', data: Buffer.from('{"id":"rose-huge","name":"x","version":"1.0.0"}'), rawSize: PLUGIN_LIMITS.pluginBytes + 1 }]) }, opts);
    assert.equal(huge.issues[0].code, 'PLUGIN_FORGE_ZIP');
    assert.match(huge.issues[0].detail, /larger than/);

    let deep = { id: 'rose-deep', name: 'd', version: '1.0.0' };
    for (let i = 0; i < 70; i++) deep = { nest: deep };
    const deepDir = path.join(parent, 'deep');
    fs.mkdirSync(deepDir);
    fs.writeFileSync(path.join(deepDir, 'pack.json'), JSON.stringify(deep));
    const nested = await importForge(deepDir, opts);
    assert.equal(nested.issues[0].code, 'PLUGIN_FORGE_JSON');
    assert.match(nested.issues[0].detail, /nested deeper/);

    const escaped = await importForge({ files: new Map([['../evil.json', Buffer.from('{}')], ['pack.json', Buffer.from('{"id":"rose-evil","name":"x","version":"1.0.0"}')]]) }, opts);
    assert.equal(escaped.issues[0].code, 'PLUGIN_FORGE_ZIP');

    const baitDir = path.join(parent, 'bait');
    fs.mkdirSync(path.join(baitDir, 'kits'), { recursive: true });
    fs.writeFileSync(path.join(baitDir, 'pack.json'), JSON.stringify({ id: 'rose-bait', name: 'bait', version: '1.0.0' }));
    fs.copyFileSync(path.join(FIXTURES, 'mixed-pack', 'kits', 'boom.js'), path.join(baitDir, 'kits', 'boom.js'));
    const bait = await importForge(baitDir, opts);
    assert.equal(bait.ok, true, bait.markdown);
    assert.equal(bait.wrote, false);
    assert.match(bait.markdown, /kits\/boom\.js/);
    assert.match(bait.markdown, /不执行/);
    assert.equal(fs.existsSync(BAIT), false);
    assert.equal(fs.readdirSync(parent).includes('rose-bait'), false);

    const linked = path.join(parent, 'linked');
    fs.mkdirSync(linked);
    fs.writeFileSync(path.join(linked, 'pack.json'), '{"id":"rose-linked","name":"x","version":"1.0.0"}');
    fs.symlinkSync('/tmp', path.join(linked, 'escape'));
    const sym = await importForge(linked, opts);
    assert.equal(sym.issues[0].code, 'PLUGIN_FORGE_ZIP');
    assert.match(sym.issues[0].detail, /symbolic link/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(BAIT, { force: true });
  }
});

test('readUntrustedZip rejects a truncated archive before it yields entries', async () => {
  await assert.rejects(readUntrustedZip(Buffer.from('not a zip')), (e) => e.code === 'PLUGIN_FORGE_ZIP');
});
