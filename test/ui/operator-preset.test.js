// test/ui/operator-preset.test.js — the 干员预设 (operator preset, ui/operatorPresetModel.js + ui/loadoutSync.js
// applyOperatorPreset; 参考 Stardust fork 的同名模型, 按本仓 v2 存储与皮肤双轨重组): one portable file per player —
//   * envelope: kind 'stronghold.operator-preset' + v, a byte cap, every section through its own model's clean;
//   * a complete import validates ALL sections before one coherent store update (a section the current build cannot
//     use aborts the whole import without persistence); an explicitly empty section restores that section's defaults;
//   * the legacy single-section files (stronghold.loadout / ownership / diy / skins and the older bare shapes) keep
//     importing, scoped to the section they carry — a v1 loadout (第二期下半's chess ids) becomes the view of the data
//     on screen first (DESIGN §35.23).
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
const DATA = { chess: CHESS, backups: BACKUPS };
const lookup = (id) => (Object.hasOwn(CHESS, id) ? CHESS[id] : null);

const { KITTED_CHARS } = await import('../../server/sim/content/kits/index.js');
const P = await import('../../public/js/ui/operatorPresetModel.js');
const LM = await import('../../public/js/ui/loadoutModel.js');
const OM = await import('../../public/js/ui/ownershipModel.js');
const DM = await import('../../public/js/ui/diyModel.js');
const ST = await import('../../public/js/ui/skinTransfer.js');
const S = await import('../../public/js/ui/loadoutSync.js');
const skins = await import('../../public/js/ui/skins.js');
const { data } = await import('../../public/js/data.js');

const SLOT = 'chess_char_5_diy1_a';
const PROTO = 'char_601_cguard'; // a tier-5 prototype (backups.diy.prototypes[5]) — no kit needed
const YAK = 'char_199_yak'; // 角峰: chess_char_1_02_a here, chess_char_2_03_a in 第一期
const ANGEL_CHESS = 'chess_char_3_01_a';
const SKIN = 'char_103_angel_wild_1';
const state = () => ({
  byChar: { char_498_inside: { skill: 0 } },
  ops: { char_498_inside: { potential: 5 } },
  notOwnedChars: ['char_1026_gvial2'],
  diy: { [SLOT]: DM.defaultPick(PROTO, SLOT, DATA) },
  skins: { [ANGEL_CHESS]: SKIN },
  portraits: { [ANGEL_CHESS]: 'e2' },
});
const deps = () => ({ lookup, data: DATA, kitted: KITTED_CHARS });
const show = () => data.setContent({ id: 'def', values: new Map([['chess', CHESS]]) });
const sectionsOf = (raw) => ({ byChar: raw.byChar, ops: raw.ops, notOwnedChars: raw.notOwnedChars, diy: raw.diy, skins: raw.skins, portraits: raw.portraits });
const resetStores = () => {
  mem.clear();
  S.loadoutStore.set({ byChar: {}, ops: {}, notOwnedChars: [], diy: {}, entries: {}, notOwned: [] });
  skins.setSkins({});
  skins.setPortraits({});
};

test('one portable preset round-trips gameplay and display without shared references', () => {
  const s = state();
  const raw = P.operatorPresetPayload(s, { now: 0 });
  assert.equal(raw.kind, P.OPERATOR_PRESET_KIND);
  assert.equal(raw.v, 1);
  assert.equal(raw.exportedAt, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(Object.keys(raw).sort(), ['byChar', 'diy', 'exportedAt', 'kind', 'notOwnedChars', 'ops', 'portraits', 'skins', 'v']);
  const parsed = P.parseOperatorPreset(P.serializeOperatorPreset(s));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.scope, 'all');
  assert.deepEqual(parsed.patch, sectionsOf(raw), 'parse(serialize(x)) is the cleaned payload');
  // purity: parsing never sanitises nor changes the supplied state
  const copy = structuredClone(raw);
  P.parseOperatorPreset(raw);
  assert.deepEqual(raw, copy);
  const prepared = P.prepareOperatorPreset(parsed, { ...deps(), map: LM.charKeyMap(Object.values(CHESS)) });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.dropped, 0);
  assert.equal(prepared.counts.entries, 1);
  assert.equal(prepared.counts.diy, 1);
});

test('a complete import replaces every section through one coherent store update', () => {
  show();
  resetStores();
  S.setEntries({ chess_char_3_01_a: { skill: 1 } }); // an old choice, by the view of the data on screen
  S.setOpsMap({ char_103_angel: { cultivate: 1 } });
  S.setNotOwned([YAK === 'char_199_yak' ? 'chess_char_1_02_a' : YAK]);
  const result = S.applyOperatorPreset(P.parseOperatorPreset(P.serializeOperatorPreset(state())), deps());
  assert.equal(result.ok, true);
  assert.equal(result.scope, 'all');
  assert.deepEqual(result.counts, { entries: 1, ops: 1, notOwned: 1, diy: 1 });
  assert.equal(result.dropped, 0);
  const st = S.loadoutStore.get();
  assert.deepEqual(st.byChar, { char_498_inside: { skill: 0 } }, 'the old choice replaced');
  assert.deepEqual(st.entries, { chess_char_1_01_a: { skill: 0 } }, 'the view of the data on screen');
  assert.deepEqual(st.ops, { char_498_inside: { potential: 5 } });
  assert.deepEqual(st.notOwned, ['chess_char_4_23_a'], 'char_1026_gvial2 is chess_char_4_23_a here');
  assert.deepEqual(st.notOwnedChars, ['char_1026_gvial2']);
  assert.equal(st.diy[SLOT].charId, PROTO, 'the prototype pick survived its sanitising');
  assert.deepEqual(skins.skinsStore.get().entries, { [ANGEL_CHESS]: SKIN }, 'the whole display half replaced');
  assert.deepEqual(skins.skinsStore.get().portraits, { [ANGEL_CHESS]: 'e2' });
  assert.deepEqual(JSON.parse(mem.get('sp.pref.loadout')).byChar, { char_498_inside: { skill: 0 } }, 'persisted through its own key');
  assert.deepEqual(JSON.parse(mem.get('sp.pref.ownership')).notOwnedChars, ['char_1026_gvial2']);
  assert.deepEqual(JSON.parse(mem.get('sp.pref.skins')), { char_103_angel: SKIN }, 'the skins pref is the charId-keyed mirror');
});

for (const [name, mutate] of [
  ['an unavailable loadout', (raw) => { raw.byChar.char_498_inside = { skill: 99 }; }],
  ['junk 潜能 / 练度', (raw) => { raw.ops = { char_1026_gvial2: { potential: 99 } }; }],
  ['an unavailable 自选编队', (raw) => { raw.diy = { [SLOT]: { charId: 'char_002_amiya' } }; }],
]) test(`${name} section aborts the entire preset without persistence or store changes`, () => {
  show();
  resetStores();
  const before = structuredClone(S.loadoutStore.get());
  const beforeSkins = structuredClone(skins.skinsStore.get());
  const raw = P.operatorPresetPayload(state());
  mutate(raw);
  const result = S.applyOperatorPreset(P.parseOperatorPreset(raw), deps());
  assert.equal(result.ok, false);
  assert.deepEqual(S.loadoutStore.get(), before);
  assert.deepEqual(skins.skinsStore.get(), beforeSkins);
  assert.equal(mem.has('sp.pref.loadout'), false, 'nothing persisted');
});

test('an operator the data on screen does not show is silently ignored (version portability), not an abort', () => {
  show();
  resetStores();
  const raw = P.operatorPresetPayload(state());
  raw.byChar.char_x_from_another_version = { skill: 3 };
  raw.notOwnedChars.push('char_x_from_another_version');
  const result = S.applyOperatorPreset(P.parseOperatorPreset(raw), deps());
  assert.equal(result.ok, true);
  assert.equal(result.dropped, 0, 'the unknown operator was never on offer here');
  assert.deepEqual(Object.keys(S.loadoutStore.get().byChar), ['char_498_inside']);
});

test('an explicit empty complete preset restores every default, while an empty legacy loadout is still refused', () => {
  show();
  resetStores();
  S.applyOperatorPreset(P.parseOperatorPreset(P.serializeOperatorPreset(state())), deps());
  const empty = { byChar: {}, ops: {}, notOwnedChars: [], diy: {}, skins: {}, portraits: {} };
  const result = S.applyOperatorPreset(P.parseOperatorPreset(P.serializeOperatorPreset(empty)), deps());
  assert.equal(result.ok, true);
  const st = S.loadoutStore.get();
  assert.deepEqual(st.byChar, {});
  assert.deepEqual(st.ops, {});
  assert.deepEqual(st.notOwned, []);
  assert.deepEqual(st.diy, {});
  assert.deepEqual(skins.skinsStore.get().entries, {});
  // a legacy 调配 envelope with nothing in it would silently wipe the loadout: its parser refuses it, as before
  assert.equal(P.parseOperatorPreset(LM.serializeExport({}, { ops: {} })).ok, false);
});

for (const [name, encode] of [
  ['loadout', (s) => LM.serializeExport(s.byChar, { ops: s.ops })],
  ['ownership', (s) => OM.serializeOwnership(s.notOwnedChars)],
  ['diy', (s) => DM.serializeDiy(s.diy)],
  ['skins', (s) => ST.serializeSkinConfig({ skins: s.skins, portraits: s.portraits })],
]) test(`a legacy ${name} file imports through the preset parser and updates only its own section`, () => {
  show();
  resetStores();
  const result = S.applyOperatorPreset(P.parseOperatorPreset(encode(state())), deps());
  assert.equal(result.ok, true);
  assert.notEqual(result.scope, 'all');
  // exactly one of the four surfaces changed
  const st = S.loadoutStore.get();
  const surfaces = [Object.keys(st.byChar).length, st.notOwnedChars.length, Object.keys(st.diy).length, Object.keys(skins.skinsStore.get().entries).length];
  assert.equal(surfaces.filter((n) => n > 0).length, 1, JSON.stringify(surfaces));
});

test('a v1 调配 file (第二期下半\'s chess ids) is filed under its operator', async () => {
  show();
  resetStores();
  await S.loadDefaultCharMap({ fetch: async (url) => {
    assert.equal(url, '/data/chess.json');
    return { ok: true, json: async () => CHESS };
  } });
  const v1 = JSON.stringify({ v: 1, entries: { chess_char_1_02_a: { skill: 0 } } }); // 角峰, no kind
  const result = S.applyOperatorPreset(P.parseOperatorPreset(v1), deps());
  assert.equal(result.ok, true);
  assert.equal(result.scope, 'loadout');
  assert.deepEqual(S.loadoutStore.get().byChar, { [YAK]: { skill: 0 } });
});

test('missing game data or kit data rejects the complete preset before any persistence or store change', () => {
  resetStores();
  data.setContent(null);
  const before = structuredClone(S.loadoutStore.get());
  const noData = S.applyOperatorPreset(P.parseOperatorPreset(P.serializeOperatorPreset(state())), deps());
  assert.equal(noData.ok, false);
  assert.deepEqual(S.loadoutStore.get(), before);
  show();
  const beforeShown = structuredClone(S.loadoutStore.get());
  const noKit = S.applyOperatorPreset(P.parseOperatorPreset(P.serializeOperatorPreset(state())), { ...deps(), kitted: null });
  assert.equal(noKit.ok, false);
  assert.deepEqual(S.loadoutStore.get(), beforeShown);
  assert.equal(noKit.error, '自选编队数据尚未就绪，请稍后重试');
});

test('a legacy 皮肤配置 file imports without any game data and leaves the gameplay sections alone', () => {
  resetStores();
  data.setContent(null);
  S.loadoutStore.set({ byChar: { char_498_inside: { skill: 0 } }, entries: {}, ops: {} });
  const result = S.applyOperatorPreset(P.parseOperatorPreset(ST.serializeSkinConfig({ skins: { [ANGEL_CHESS]: SKIN } })), {});
  assert.equal(result.ok, true);
  assert.equal(result.scope, 'skins');
  assert.deepEqual(skins.skinsStore.get().entries, { [ANGEL_CHESS]: SKIN });
  assert.deepEqual(S.loadoutStore.get().byChar, { char_498_inside: { skill: 0 } }, 'the loadout untouched');
});

test('hostile, missing, oversized and newer envelopes are rejected without prototype changes', () => {
  const full = P.serializeOperatorPreset(state());
  for (const x of ['{', '', '   ', null, true, 42, { kind: P.OPERATOR_PRESET_KIND, v: 2 },
    { kind: P.OPERATOR_PRESET_KIND, v: 1, byChar: {} }, { kind: 'stronghold.stats', v: 1 },
    { ...JSON.parse(full), skins: 3 }, { kind: 'local-stats', v: 1, records: [] },
    '中'.repeat(Math.floor(P.OPERATOR_PRESET_MAX_BYTES / 3) + 1)]) {
    const r = P.parseOperatorPreset(x);
    assert.equal(r.ok, false, JSON.stringify(x)?.slice(0, 40));
  }
  // a `__proto__` key never reaches the stores (the section sanitisers drop it)
  show();
  resetStores();
  const raw = JSON.parse(full);
  raw.byChar = JSON.parse('{"__proto__":{"skill":0},"constructor":{"skill":0},"char_498_inside":{"skill":0}}');
  raw.skins = JSON.parse('{"__proto__":"x","chess_char_3_01_a":"skin"}');
  const result = S.applyOperatorPreset(P.parseOperatorPreset(raw), deps());
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(S.loadoutStore.get().byChar), ['char_498_inside']);
  assert.deepEqual(Object.keys(skins.skinsStore.get().entries), [ANGEL_CHESS]);
  assert.equal({}.skill, undefined);
});
