// test/ui/config-transfer.test.js — the 统一配置导入导出入口 (ui/configTransfer.js, mounted by ui/settings.js
// SettingsModal): every kind of this browser's per-browser config — 干员预设 / 干员调配 / 干员持有 / 自选编队 /
// 皮肤配置 / 统计数据 — exports and imports in one panel. The panel dispatches an import by the payload's own
// envelope `kind` (an unknown kind is an explicit error, never another parser's guess), reuses each kind's model
// parser / sanitiser unchanged (the old entries keep their semantics), and only links the stats merge
// (ui/stats.js importStats) — no logic of its own there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const CHESS = readJson('data/chess.json');
const BACKUPS = readJson('data/backups.json');

const { KITTED_CHARS } = await import('../../server/sim/content/kits/index.js');
const C = await import('../../public/js/ui/configTransfer.js');
const P = await import('../../public/js/ui/operatorPresetModel.js');
const LM = await import('../../public/js/ui/loadoutModel.js');
const OM = await import('../../public/js/ui/ownershipModel.js');
const DM = await import('../../public/js/ui/diyModel.js');
const ST = await import('../../public/js/ui/skinTransfer.js');
const stats = await import('../../public/js/ui/stats.js');
const S = await import('../../public/js/ui/loadoutSync.js');
const skins = await import('../../public/js/ui/skins.js');
const { data } = await import('../../public/js/data.js');

const SLOT = 'chess_char_5_diy1_a';
const deps = () => ({ lookup: (id) => (Object.hasOwn(CHESS, id) ? CHESS[id] : null), data: { chess: CHESS, backups: BACKUPS }, kitted: KITTED_CHARS });
const seed = () => {
  mem.clear();
  S.loadoutStore.set({
    byChar: { char_498_inside: { skill: 0 } }, ops: { char_498_inside: { potential: 5 } },
    notOwnedChars: ['char_1026_gvial2'], diy: { [SLOT]: { charId: 'char_601_cguard' } },
    entries: { chess_char_1_01_a: { skill: 0 } }, notOwned: ['chess_char_4_23_a'],
  });
  skins.setSkins({ chess_char_3_01_a: 'char_103_angel_wild_1' });
  skins.setPortraits({ chess_char_3_01_a: 'e2' });
};

test('the panel offers every scattered config in one place, each with its own envelope kind', () => {
  assert.deepEqual(C.CONFIG_KINDS.map((k) => k.id), ['operator-preset', 'loadout', 'ownership', 'diy', 'skins', 'stats']);
  assert.deepEqual(C.CONFIG_KINDS.map((k) => k.kind), ['stronghold.operator-preset', 'stronghold.loadout', 'stronghold.ownership', 'stronghold.diy', 'stronghold.skins', 'local-stats']);
});

test('exportConfigText writes each kind\'s own envelope from the live stores', () => {
  seed();
  const by = Object.fromEntries(C.CONFIG_KINDS.map((k) => [k.id, JSON.parse(C.exportConfigText(k.id))]));
  assert.equal(by['operator-preset'].kind, 'stronghold.operator-preset');
  assert.deepEqual(Object.keys(by['operator-preset']).sort(), ['byChar', 'diy', 'exportedAt', 'kind', 'notOwnedChars', 'ops', 'portraits', 'skins', 'v']);
  assert.equal(by.loadout.kind, 'stronghold.loadout');
  assert.deepEqual(by.loadout.byChar, { char_498_inside: { skill: 0 } });
  assert.deepEqual(by.loadout.skins, { chess_char_3_01_a: 'char_103_angel_wild_1' }, 'a 调配 export carries the roster\'s 皮肤, not the slots\'');
  assert.equal(by.ownership.kind, 'stronghold.ownership');
  assert.deepEqual(by.ownership.notOwnedChars, ['char_1026_gvial2']);
  assert.equal(by.diy.kind, 'stronghold.diy');
  assert.deepEqual(Object.keys(by.diy.picks), [SLOT]);
  assert.deepEqual(by.diy.skins, {}, 'no slot 皮肤 chosen');
  assert.equal(by.skins.kind, 'stronghold.skins');
  assert.deepEqual(by.skins.skins, { chess_char_3_01_a: 'char_103_angel_wild_1' });
  assert.equal(by.stats.kind, 'local-stats');
  assert.deepEqual(by.stats.records, []);
  assert.equal(C.exportConfigText('nope'), null, 'an unknown id exports nothing');
});

test('an export of every kind parses back to its own row (round-trip by kind)', () => {
  seed();
  for (const item of C.CONFIG_KINDS) {
    const r = C.parseConfigPayload(C.exportConfigText(item.id));
    assert.equal(r.ok, true, item.id);
    assert.equal(r.id, item.id, item.id);
  }
});

test('an import is dispatched by the payload\'s own kind, and the model parsers stay authoritative', () => {
  seed();
  // each legacy envelope goes to its own model's parser, unchanged semantics
  const loadout = C.parseConfigPayload(LM.serializeExport({ char_498_inside: { skill: 1 } }, { ops: {} }));
  assert.equal(loadout.id, 'loadout');
  assert.deepEqual(loadout.parsed.patch.byChar, { char_498_inside: { skill: 1 } });
  const ownership = C.parseConfigPayload(OM.serializeOwnership(['char_1026_gvial2']));
  assert.equal(ownership.id, 'ownership');
  assert.deepEqual(ownership.parsed.patch.notOwnedChars, ['char_1026_gvial2']);
  const diy = C.parseConfigPayload(DM.serializeDiy({ [SLOT]: { charId: 'char_601_cguard' } }));
  assert.equal(diy.id, 'diy');
  const skinsFile = C.parseConfigPayload(ST.serializeSkinConfig({ skins: { chess_char_3_01_a: 'x' } }));
  assert.equal(skinsFile.id, 'skins');
  const preset = C.parseConfigPayload(P.serializeOperatorPreset({
    byChar: {}, ops: {}, notOwnedChars: [], diy: {}, skins: {}, portraits: {},
  }));
  assert.equal(preset.id, 'operator-preset');
  assert.equal(preset.parsed.scope, 'all');
  // the older bare shapes (no kind) are sniffed, as the old dialogs accepted them
  assert.equal(C.parseConfigPayload(['char_1026_gvial2']).id, 'ownership', 'a bare id array');
  assert.equal(C.parseConfigPayload(JSON.stringify({ picks: {} })).id, 'diy', 'a bare picks map');
  assert.equal(C.parseConfigPayload(JSON.stringify({ chess_char_1_01_a: { skill: 0 } })).id, 'loadout', 'a bare entries map');
});

test('bad JSON, an empty payload and an UNKNOWN kind fail with explicit reasons', () => {
  assert.equal(C.parseConfigPayload('not json').ok, false);
  assert.equal(C.parseConfigPayload('   ').ok, false);
  assert.equal(C.parseConfigPayload(42).ok, false);
  const unknown = C.parseConfigPayload('{"kind":"stronghold.nonsense","v":1}');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, '无法识别的配置类型（{kind}），未做任何改动');
  assert.deepEqual(unknown.params, { kind: 'stronghold.nonsense' });
  // the stats kind is known and routed to the stats path
  assert.equal(C.parseConfigPayload('{"kind":"local-stats","v":1,"records":[]}').id, 'stats');
});

test('applyConfig funnels the stronghold kinds through applyOperatorPreset and stats through its own merge', () => {
  seed();
  data.setContent({ id: 'def', values: new Map([['chess', CHESS]]) });
  // a complete preset round-trips through export → parse → apply
  const r = C.parseConfigPayload(C.exportConfigText('operator-preset'));
  const applied = C.applyConfig(r.id, r.parsed, deps());
  assert.equal(applied.ok, true);
  assert.equal(applied.scope, 'all');
  // a 皮肤 file applies without any game data
  const s = C.parseConfigPayload(ST.serializeSkinConfig({ skins: { chess_other: 'skin' } }));
  const appliedSkins = C.applyConfig(s.id, s.parsed, {});
  assert.equal(appliedSkins.ok, true);
  assert.deepEqual(skins.skinsStore.get().entries, { chess_other: 'skin' });
  data.setContent(null);
});

test('importStatsPayload reuses the 统计数据 page\'s merge and refusals, unchanged', () => {
  mem.clear();
  const ok = C.importStatsPayload(stats.exportStats({ records: [] }));
  assert.equal(ok.ok, true);
  assert.equal(ok.added, 0);
  assert.equal(C.importStatsPayload({ kind: 'local-stats', v: 1 }).ok, false, 'no records');
  assert.equal(C.importStatsPayload({ kind: 'local-stats', v: 1 }).error, '导入失败：不是有效的统计导出文件');
  const newer = C.importStatsPayload({ kind: 'local-stats', v: stats.STATS_VERSION + 1, records: [] });
  assert.equal(newer.error, '导入失败：这份文件由更新版本的客户端导出，请先升级客户端');
  assert.equal(C.importStatsPayload('junk').ok, false);
});

test('configImportRefusal follows the GitHub #173 rule: no sanitising against missing game data', () => {
  const status = (name) => (name === 'chess' ? 'missing' : 'ready');
  assert.equal(C.configImportRefusal('skins', status), null, '皮肤 needs no game data');
  assert.equal(C.configImportRefusal('stats', status), null, '统计 needs no game data');
  const refused = C.configImportRefusal('loadout', status);
  assert.equal(refused.tone, 'error');
  assert.match(refused.text, /游戏数据没有载入/);
  const preset = C.configImportRefusal('operator-preset', (name) => (name === 'backups' ? 'missing' : 'ready'));
  assert.equal(preset.tone, 'error', 'a complete preset needs backups.json too (潜能 / 练度 / 自选)');
});

test('the settings modal mounts the unified panel (the old entries stay in the 干员调配 overlay)', () => {
  const settings = fs.readFileSync(path.join(ROOT, 'public/js/ui/settings.js'), 'utf8');
  assert.match(settings, /import \{ ConfigTransferSection \} from '\.\/configTransfer\.js';/);
  assert.match(settings, /<\$\{ConfigTransferSection\} \/>/);
  const loadout = fs.readFileSync(path.join(ROOT, 'public/js/screens/loadout.js'), 'utf8');
  assert.match(loadout, /data-testid="loadout-export"/, 'the old 干员调配 export stays');
  assert.match(loadout, /data-testid="skin-import"/, 'the old 皮肤配置 import stays');
  const statsScreen = fs.readFileSync(path.join(ROOT, 'public/js/screens/stats.js'), 'utf8');
  assert.match(statsScreen, /data-testid="stats-export"/, 'the old 统计数据 export stays');
  // every panel string goes through t() and every msgid is in the packs (tools/i18n.mjs check is the authority)
  assert.match(fs.readFileSync(path.join(ROOT, 'public/js/ui/configTransfer.js'), 'utf8'), /data-testid="config-transfer-section"/);
});
