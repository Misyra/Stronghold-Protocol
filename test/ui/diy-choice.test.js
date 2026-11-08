// 自选候补 — client side (Stardust fork rel26 2d3ec08e, feedback #114; the owner's decision of 2026-11-02: four equal
// candidates per tier, any two play): the 自选编队 tab's four equal cards per tier (ui/diyModel.js diyPositions;
// positions 3–4 are bench keys the picker and the cards read as picks of their tier), the banned-bond hints once a
// match's bans are known (diyMatchOff / diyBanHint), and the briefing's 自选上场 section (ui/diyChoice.js:
// m.private.diyChoice, a draft per tier sent as g.diyChoose once complete; a candidate with banned bonds names them,
// every bond banned marked more strongly than some) — since feedback #127 (rel28 94d736da) drawn as the dock pinned
// above 准备就绪.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
globalThis.fetch = async (url) => {
  const name = String(url).split('/').pop();
  try {
    const body = readFileSync(path.join(ROOT, 'data', name), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  } catch {
    return { ok: false, status: 404, json: async () => ({}) };
  }
};

const M = await import('../../public/js/ui/diyModel.js');
const C = await import('../../public/js/ui/diyChoice.js');
const { DiyPanelView } = await import('../../public/js/screens/diy.js');
const { data } = await import('../../public/js/data.js');
const { DATA } = await import('../match/harness.js');
const { KITTED_CHARS } = await import('../../server/sim/content/kits/index.js');
const { diyBenchId } = await import('../../shared/diy.js');

await data.loadAll('chess', 'bonds', 'assets', 'backups');

const D = { chess: DATA.chess, backups: DATA.backups };
const KIT = [...KITTED_CHARS];
const T5A = 'chess_char_5_diy1_a', T6A = 'chess_char_6_diy1_a';
const B51 = diyBenchId(5, 1), B52 = diyBenchId(5, 2), B61 = diyBenchId(6, 1), B62 = diyBenchId(6, 2);
const SIEGE = 'char_112_siege', KALTS = 'char_003_kalts', IFRIT = 'char_134_ifrit', MGLLAN = 'char_248_mgllan', CHEN = 'char_010_chen';
const HUANG = 'char_017_huang'; // 煌: 炎 + 维多利亚
const own = (charId) => ({ charId, skillIndex: 2, uniEquipId: null });

function* walk(v) {
  if (Array.isArray(v)) { for (const x of v) yield* walk(x); return; }
  if (!v || typeof v !== 'object') return;
  yield v;
  yield* walk(v.props?.children);
}
const hasClass = (v, c) => typeof v?.props?.class === 'string' && v.props.class.split(/\s+/).includes(c);
function expand(v, depth = 6) {
  if (Array.isArray(v)) return v.map((x) => expand(x, depth));
  if (!v || typeof v !== 'object') return v;
  if (typeof v.type === 'function' && depth > 0) {
    try { return expand(v.type(v.props || {}), depth - 1); } catch { return v; }
  }
  const children = v.props?.children;
  return children === undefined ? v : { ...v, props: { ...v.props, children: expand(children, depth) } };
}
const textOf = (v) => [...walk(v)].flatMap((n) => (Array.isArray(n.props?.children) ? n.props.children : [n.props?.children])).filter((x) => typeof x === 'string' || typeof x === 'number').join('');

describe('four equal positions per tier in the 自选编队 tab', () => {
  test('per tier: its two slots, then two bench keys — positions 1–4; eight picks in all', () => {
    assert.deepEqual(M.diyPositions(D).map((s) => [s.slotId, s.tier, s.n]), [[T5A, 5, 1], ['chess_char_5_diy2_a', 5, 2], [B51, 5, 3], [B52, 5, 4],
      [T6A, 6, 1], ['chess_char_6_diy2_a', 6, 2], [B61, 6, 3], [B62, 6, 4]]);
    assert.deepEqual(M.diyBenchList(D).map((s) => [s.slotId, s.tier]), [[B51, 5], [B52, 5], [B61, 6], [B62, 6]]);
    assert.equal(M.diyCapacity(D), 8);
  });

  test('the bans of a match: none outside one; drawn and the mode\'s static ones in one; a pick\'s off bonds, all or some', () => {
    const config = { modes: { m1: { inactiveBondIds: ['lateranoShip'] } } };
    assert.equal(M.diyMatchOff(null, config), null);
    assert.equal(M.diyMatchOff({ phase: 'LOBBY' }, config), null);
    const off = M.diyMatchOff({ phase: 'INFO_CHECK', modeId: 'm1', drawnDisabledBonds: ['yanShip'], disabledBonds: ['yanShip', 'lateranoShip'] }, config);
    assert.deepEqual([...off].sort(), ['lateranoShip', 'yanShip']);
    assert.deepEqual(M.diyBanHint(CHEN, D, off), { bonds: ['yanShip'], all: true });
    assert.deepEqual(M.diyBanHint(HUANG, D, off), { bonds: ['yanShip'], all: false }, '煌: 炎 + 维多利亚');
    assert.equal(M.diyBanHint(KALTS, D, off), null, '协防 is never banned');
    assert.equal(M.diyBanHint(CHEN, D, null), null);
  });

  test('a bench key is a pick of its tier: options, the record, the taken mark across slots and bench', () => {
    const opts = M.pickOptions(B51, { [T5A]: own(SIEGE), [B62]: own(KALTS) }, D, KIT);
    assert.ok(opts.length > 0);
    assert.equal(opts.find((o) => o.charId === SIEGE).taken, T5A, 'held by the tier-5 slot');
    assert.equal(opts.find((o) => o.charId === KALTS).taken, B62, 'an owned operator once in the whole preset');
    assert.equal(opts.find((o) => o.charId === IFRIT).taken, null);
    assert.equal(M.slotRecord(B52, own(IFRIT), D)?.charId, IFRIT);
    assert.equal(M.slotRecord(B61, own(IFRIT), D, { elite: true })?.tier, 6);
    assert.deepEqual(M.sanitizeDiyPicks({ [T5A]: own(SIEGE), [B51]: own(SIEGE), [B52]: own(IFRIT) }, D, KIT), { [T5A]: own(SIEGE), [B52]: own(IFRIT) });
    assert.equal(M.defaultPick(MGLLAN, B61, D).charId, MGLLAN);
  });

  test('the tab draws four equal cards per tier in one grid (no 候补 row); in a match a card names its banned bonds', () => {
    const picks = { [T5A]: own(SIEGE), [B51]: own(CHEN), [B52]: own(HUANG) };
    const tree = expand(DiyPanelView({ m: data.get('assets'), picks, legal: picks, kitted: KIT, onSet() {}, picking: null, onPicking() {} }));
    const tier5 = [...walk(tree)].find((v) => hasClass(v, 'diy-tier') && v.props['data-tier'] === 5);
    const grids = [...walk(tier5)].filter((v) => hasClass(v, 'diy-grid'));
    assert.equal(grids.length, 1, 'one grid per tier');
    const cards = [...walk(grids[0])].filter((v) => hasClass(v, 'diy-slot'));
    assert.deepEqual(cards.map((v) => v.props['data-slot']), [T5A, 'chess_char_5_diy2_a', B51, B52]);
    assert.ok(hasClass(cards[1], 'is-empty') && textOf(cards[1]).includes('选择干员'));
    assert.equal(cards[3].props['data-char'], HUANG);
    assert.ok(textOf(cards[3]).includes('5阶 自选 · 4'));
    assert.equal([...walk(tree)].filter((v) => hasClass(v, 'diy-ban')).length, 0, 'outside a match: no hint');
    // opened during a match: 陈 has every bond banned (it never reaches the shop), 煌 one of two
    const inMatch = expand(DiyPanelView({ m: data.get('assets'), picks, legal: picks, kitted: KIT, onSet() {}, picking: null, onPicking() {}, off: new Set(['yanShip']) }));
    const hint = (slot) => [...walk([...walk(inMatch)].find((v) => hasClass(v, 'diy-slot') && v.props['data-slot'] === slot))].find((v) => hasClass(v, 'diy-ban'));
    assert.equal(hint(B51)?.props['data-ban'], 'all');
    assert.ok(textOf(hint(B51)).includes('盟约全部禁用'));
    assert.equal(hint(B52)?.props['data-ban'], 'some');
    assert.ok(textOf(hint(B52)).includes('本局禁用'));
    assert.equal(hint(T5A), undefined, '推进之王 (维多利亚) keeps its bond');
    const card = (slot) => [...walk(inMatch)].find((v) => hasClass(v, 'diy-slot') && v.props['data-slot'] === slot);
    assert.ok(hasClass(card(B51), 'is-banned') && hasClass(card(B52), 'is-partban'));
  });

  test('a 候补 opens the picker of its tier', () => {
    const tree = expand(DiyPanelView({ m: data.get('assets'), picks: {}, legal: {}, kitted: KIT, onSet() {}, picking: B61, onPicking() {} }), 2);
    const picker = [...walk(tree)].find((v) => v.props?.slot?.slotId === B61);
    assert.ok(picker, 'the picker gets the bench slot');
    assert.equal(picker.props.slot.tier, 6);
  });
});

describe('the briefing\'s 自选上场 (ui/diyChoice.js)', () => {
  const tier = { tier: 5, slots: 2, candidates: [{ ...own(CHEN), banned: ['yanShip'], off: true }, own(KALTS), own(IFRIT), { ...own(HUANG), banned: ['yanShip'] }], chosen: [KALTS, IFRIT], picked: false };
  const priv = { diyChoice: { tiers: [tier] } };

  test('drafts: a tap toggles, a full draft takes nobody more, a complete changed draft is ready to send', () => {
    assert.deepEqual(C.toggleDiyDraft(tier, null, KALTS), [IFRIT]);
    assert.deepEqual(C.toggleDiyDraft(tier, null, HUANG), [KALTS, IFRIT], 'full: take one out first');
    assert.deepEqual(C.toggleDiyDraft(tier, [IFRIT], HUANG), [IFRIT, HUANG]);
    assert.equal(C.diyDraftReady(tier, [IFRIT, HUANG]), true);
    assert.equal(C.diyDraftReady(tier, [IFRIT, KALTS]), false, 'the fielded ones again: nothing to send');
    assert.equal(C.diyDraftReady(tier, [IFRIT]), false);
    assert.deepEqual(C.diyChoiceTiers({ diyChoice: { tiers: [tier, { tier: 'x' }, null] } }), [tier]);
    assert.deepEqual(C.diyChoiceTiers({}), []);
  });

  test('the view: one row per tier, the fielded marked 上场, an all-banned one marked, the hints', () => {
    assert.equal(C.DiyChoiceView({ priv: {}, onTap() {} }), null);
    const taps = [];
    const tree = expand(C.DiyChoiceView({ priv, onTap: (t, id) => taps.push([t, id]) }), 4);
    const cands = [...walk(tree)].filter((v) => hasClass(v, 'diychoice__c'));
    assert.deepEqual(cands.map((v) => v.props['data-char']), [CHEN, KALTS, IFRIT, HUANG]);
    assert.deepEqual(cands.map((v) => v.props['aria-pressed']), ['false', 'true', 'true', 'false']);
    // every bond banned: the strong mark; some: the amber one; both name the banned bonds
    assert.ok(hasClass(cands[0], 'is-off') && textOf(cands[0]).includes('盟约全部禁用') && textOf(cands[0]).includes('本局禁用'));
    assert.ok(hasClass(cands[3], 'is-part') && textOf(cands[3]).includes('部分盟约禁用') && textOf(cands[3]).includes('本局禁用'));
    assert.ok(!hasClass(cands[1], 'is-off') && !hasClass(cands[1], 'is-part') && !textOf(cands[1]).includes('禁用'));
    const flag = (c) => [...walk(c)].find((v) => hasClass(v, 'diychoice__flag'));
    assert.ok(hasClass(flag(cands[0]), 'is-all') && hasClass(flag(cands[3]), 'is-some'));
    assert.ok(textOf(tree).includes('未选择：默认上场'));
    cands[3].props.onClick();
    assert.deepEqual(taps, [[5, HUANG]]);
    const draft = expand(C.DiyChoiceView({ priv, drafts: { 5: [IFRIT] }, onTap() {} }), 4);
    assert.ok(textOf(draft).includes('再选 1 名后生效'));
    assert.deepEqual([...walk(draft)].filter((v) => hasClass(v, 'diychoice__c')).map((v) => v.props['aria-pressed']), ['false', 'false', 'true', 'false']);
  });
});

// feedback #127 (Stardust fork rel28 94d736da, planned by the owner on 2026-11-03; 「开局选自选的界面需要滚动，太不显眼了」):
// the briefing draws 自选上场 as a strip pinned above 准备就绪 — the same candidates and taps — calling for a choice while
// a tier is on the default
describe('the briefing\'s 自选上场 dock (feedback #127)', () => {
  const tier = (t, picked) => ({ tier: t, slots: 2, candidates: [own(CHEN), own(KALTS), own(IFRIT), own(HUANG)], chosen: [CHEN, KALTS], picked });
  const dock = (tiers, o = {}) => expand(C.DiyChoiceView({ priv: { diyChoice: { tiers } }, onTap: o.onTap || (() => {}), dock: true, ...o }), 4);
  test('one strip: both tiers, 4 选 2, the candidates and their taps as in the section', () => {
    const taps = [];
    const tree = dock([tier(5, false), tier(6, false)], { onTap: (t, id) => taps.push([t, id]) });
    assert.ok(hasClass(tree, 'diychoice--dock') && hasClass(tree, 'is-todo'));
    assert.equal(tree.props['data-testid'], 'diy-choice');
    assert.ok(textOf(tree).includes('4 选 2'));
    assert.deepEqual([...walk(tree)].filter((v) => hasClass(v, 'diychoice__tier')).map((v) => v.props['data-tier']), [5, 6]);
    const cands = [...walk(tree)].filter((v) => hasClass(v, 'diychoice__c'));
    assert.equal(cands.length, 8);
    cands[6].props.onClick();
    assert.deepEqual(taps, [[6, IFRIT]]);
  });
  test('it calls for a choice only while a tier is on the default (no choice, no draft) and the player is not ready', () => {
    assert.ok(hasClass(dock([tier(5, true), tier(6, false)]), 'is-todo'));
    assert.ok(!hasClass(dock([tier(5, true), tier(6, true)]), 'is-todo'));
    assert.ok(textOf(dock([tier(5, true), tier(6, true)])).includes('已选好本局上场的自选干员'));
    assert.ok(!hasClass(dock([tier(5, false)], { ready: true }), 'is-todo'), 'ready: no call');
    assert.ok(!hasClass(dock([tier(5, false)], { drafts: { 5: [IFRIT] } }), 'is-todo'), 'a draft under way');
    assert.equal(C.DiyChoiceView({ priv: {}, onTap() {}, dock: true }), null);
  });
});

// the 甄选干员 card closing a tier in 干员调配's card view counts the tier's four positions (slots + 候补, feedback #114)
describe('干员调配: the 甄选干员 card counts the four positions', async () => {
  const { DiyDeckCard } = await import('../../public/js/screens/loadout.js');
  const positions = M.diyPositions(D);
  // the text in document order (textOf collects a node's own strings before its children's)
  const flat = (v) => (Array.isArray(v) ? v.map(flat).join('') : v == null || typeof v === 'boolean' ? '' : typeof v !== 'object' ? String(v) : flat(v.props?.children));
  const card = (picks) => {
    const tree = DiyDeckCard({ m: null, tier: 6, slots: positions, picks, onOpen() {} });
    const all = [...walk(tree)];
    return { n: flat(all.find((x) => hasClass(x, 'lo-diy__n'))), faces: all.find((x) => hasClass(x, 'lo-diy__faces')) || null };
  };
  test('empty → 0/4 and the glyph; two slots and one 候补 → 3/4; all four → 4/4', () => {
    assert.equal(card({}).n, '0/4');
    assert.equal(card({}).faces, null);
    const three = card({ [T6A]: own(SIEGE), chess_char_6_diy2_a: own(IFRIT), [B61]: own(MGLLAN) });
    assert.equal(three.n, '3/4');
    assert.equal(three.faces.props.children.length, 3);
    const two = card({ [T6A]: own(SIEGE), [B62]: own(KALTS) });
    assert.equal(two.n, '2/4', 'a 候补 counts like a slot');
    assert.equal(card({ [T6A]: own(SIEGE), chess_char_6_diy2_a: own(IFRIT), [B61]: own(MGLLAN), [B62]: own(KALTS) }).n, '4/4');
  });
  test('the tier-5 card is the tier-5 positions only', () => {
    const tree = DiyDeckCard({ m: null, tier: 5, slots: positions, picks: { [T6A]: own(SIEGE), [B51]: own(CHEN) }, onOpen() {} });
    assert.equal(flat([...walk(tree)].find((x) => hasClass(x, 'lo-diy__n'))), '1/4');
  });
});
