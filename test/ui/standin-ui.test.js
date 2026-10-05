// 0.2.0 补位 — client side (the approved plan, owner's decision 2026-10-05): the 干员持有 tab's model (storage, toggles,
// the roster by tier, export / import) and its server sync (room.ownership), and the match UI of a not-owned chess —
// the shop / reward card keeps the chess (name, bonds, price) with a 「替补：X」 badge and the stand-in's skill, the own
// pieces' tags, the board / deploy rules of the stand-in's body (position, range), and the detail card's body (portrait,
// class, skill, talents) from the stand-in for the player's own pieces (m.private.standIns) and any unit carrying
// UnitInfo `standInFor`.
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

const M = await import('../../public/js/ui/ownershipModel.js');
const { installOwnershipSync, SYNC_DEBOUNCE_MS } = await import('../../public/js/ui/loadoutSync.js');
const { createStore } = await import('../../public/js/store.js');
const G = await import('../../public/js/ui/gameLogic.js');
const { ChessCard } = await import('../../public/js/ui/shopBar.js');
const { ChessDetail, resolveDetail } = await import('../../public/js/ui/detailPanel.js');
const { standInPieces } = await import('../../public/js/screens/game/standInTags.js');
const { OwnCard } = await import('../../public/js/screens/ownership.js');
const { data } = await import('../../public/js/data.js');
const { DATA } = await import('../match/harness.js');

await data.loadAll('chess', 'bonds', 'assets', 'garrisons', 'items', 'backups');

const getChess = (id) => (Object.hasOwn(DATA.chess, id) ? DATA.chess[id] : null);
const BACKUPS = DATA.backups;
const SILVER = 'chess_char_4_22_a'; // 银灰 → Sharp (S2 亮剑)
const MLYSS = 'chess_char_6_11_a'; // 缪尔赛思 (RANGED) → 郁金香 (MELEE)
const SARIA = 'chess_char_5_11_a'; // 塞雷娅 (MELEE) → Touch (RANGED)
const CATHY = 'chess_char_4_11_a'; // 凯瑟琳 (PRESET)

function* walk(v) {
  if (Array.isArray(v)) { for (const x of v) yield* walk(x); return; }
  if (!v || typeof v !== 'object') return;
  yield v;
  yield* walk(v.props?.children);
}
const hasClass = (v, c) => typeof v?.props?.class === 'string' && v.props.class.split(/\s+/).includes(c);
const textOf = (v) => [...walk(v)].flatMap((n) => (Array.isArray(n.props?.children) ? n.props.children : [n.props?.children])).filter((x) => typeof x === 'string' || typeof x === 'number').join('');

describe('干员持有 model (ui/ownershipModel.js)', () => {
  test('storage: tolerant parse, clean sorted ids, round trip; hostile keys dropped', () => {
    assert.deepEqual(M.parseStoredOwnership(null), []);
    assert.deepEqual(M.parseStoredOwnership({ v: 1, notOwned: [SILVER, 'bad id', SILVER, '__proto__', 7, SARIA] }), [SILVER, SARIA].sort());
    assert.deepEqual(M.parseStoredOwnership([MLYSS]), [MLYSS], 'a bare array of an older build');
    assert.deepEqual(M.toStoredOwnership([SARIA, SILVER]), { v: M.OWNERSHIP_VERSION, notOwned: [SILVER, SARIA].sort() });
    assert.deepEqual(M.sanitizeNotOwned([SILVER, CATHY, 'chess_char_9_99_a', getChess(SILVER).goldenId], getChess), [SILVER], 'droppable chess only');
  });
  test('toggles: setOwned / isOwned return new sorted lists', () => {
    let list = [];
    list = M.setOwned(list, SARIA, false);
    list = M.setOwned(list, SILVER);
    assert.deepEqual(list, [SILVER, SARIA].sort());
    assert.equal(M.isOwned(list, SILVER), false);
    assert.equal(M.isOwned(list, MLYSS), true);
    assert.deepEqual(M.setOwned(list, SILVER, true), [SARIA]);
    assert.deepEqual(list, [SILVER, SARIA].sort(), 'input unchanged');
  });
  test('roster: the 53 NORMAL chess of the shop by tier (6 / 13 / 17 / 17); each has its stand-in summary', () => {
    const roster = M.ownershipRoster(data.list('chess'));
    assert.equal(roster.length, 53);
    assert.ok(!roster.some((c) => c.chessType !== 'NORMAL' || c.isGolden || !c.visible));
    assert.deepEqual(M.rosterByTier(roster).map((g) => [g.tier, g.list.length]), [[3, 6], [4, 13], [5, 17], [6, 17]]);
    for (const c of roster) {
      const si = M.standInSummary(c, BACKUPS);
      assert.ok(si && si.charId === c.backup.charId && si.skill.index === c.backup.skillIndex, c.chessId);
    }
    assert.equal(M.standInSummary(getChess(SILVER), BACKUPS).name, 'Sharp');
    assert.equal(M.notOwnedCount([SILVER, CATHY, 'chess_char_6_10_a'], roster), 1, 'PRESET / retired ids do not count');
  });
  test('export / import: versioned envelope, bare arrays and text; junk, newer versions and other kinds refused', () => {
    const text = M.serializeOwnership([SARIA, SILVER], { now: 0 });
    const env = JSON.parse(text);
    assert.deepEqual([env.kind, env.v, env.count, env.notOwned], [M.OWNERSHIP_EXPORT_KIND, 1, 2, [SILVER, SARIA].sort()]);
    assert.deepEqual(M.parseOwnershipImport(text), { ok: true, notOwned: [SILVER, SARIA].sort() });
    assert.deepEqual(M.parseOwnershipImport([MLYSS]), { ok: true, notOwned: [MLYSS] });
    assert.deepEqual(M.parseOwnershipImport({ v: 1, notOwned: [] }), { ok: true, notOwned: [] }, 'an empty list = everything owned');
    assert.equal(M.parseOwnershipImport('').ok, false);
    assert.equal(M.parseOwnershipImport('{nope').ok, false);
    assert.equal(M.parseOwnershipImport({ v: 9, notOwned: [] }).ok, false);
    assert.equal(M.parseOwnershipImport({ kind: 'stronghold.loadout', v: 1, entries: {} }).ok, false);
    assert.equal(M.parseOwnershipImport('x'.repeat(M.OWNERSHIP_IMPORT_MAX_BYTES + 1)).ok, false);
  });
  test('the 干员持有 card is a switch: operator → stand-in; a tap asks for the other state', () => {
    const calls = [];
    const card = OwnCard({ m: data.get('assets'), chess: getChess(SILVER), backups: BACKUPS, owned: true, onToggle: (id, owned) => calls.push([id, owned]) });
    assert.equal(card.props.role, 'switch');
    assert.equal(card.props['aria-checked'], 'true');
    assert.ok(textOf(card).includes('银灰') && textOf(card).includes('Sharp') && textOf(card).includes('S2'));
    card.props.onClick();
    assert.deepEqual(calls, [[SILVER, false]]);
    const off = OwnCard({ m: null, chess: getChess(SILVER), backups: BACKUPS, owned: false, onToggle() {} });
    assert.ok(hasClass(off, 'is-off'));
    assert.equal(off.props['aria-checked'], 'false');
  });
});

// ---- sync -------------------------------------------------------------------------------------------------------------

function fakeNet() {
  const listeners = new Map();
  const net = {
    status: 'online', sent: [], replies: [],
    on(t, fn) { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(fn); return () => listeners.get(t).delete(fn); },
    emit(t, msg) { for (const fn of listeners.get(t) || []) fn(msg); },
    request(t, fields) {
      net.sent.push({ t, ...fields });
      const r = net.replies.shift();
      return r && r.error ? Promise.reject(Object.assign(new Error(r.error), { code: r.error })) : Promise.resolve({ t: 'ok' });
    },
  };
  return net;
}
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const q = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; q.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => q.delete(id),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...q.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        q.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      now = end;
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}

test('ownership sync: room.ownership after welcome and after edits (debounced); in a match stored for the next one (told once)', async () => {
  const net = fakeNet();
  const T = fakeTimers();
  const told = [];
  const target = createStore({ notOwned: [SILVER], open: false, ownSync: 'idle' });
  const s = installOwnershipSync({ net, timers: T, target, notify: (t) => told.push(t) });
  net.emit('welcome', {});
  await T.advance(100);
  assert.deepEqual(net.sent, [{ t: 'room.ownership', notOwned: [SILVER] }]);
  assert.equal(target.get().ownSync, 'synced');
  target.set({ notOwned: [SILVER, SARIA].sort() });
  await T.advance(SYNC_DEBOUNCE_MS + 10);
  assert.deepEqual(net.sent[1], { t: 'room.ownership', notOwned: [SILVER, SARIA].sort() });
  // a running match: ROOM_STARTED = stored for the next match, not an error; the edit is told once
  net.replies.push({ error: 'ROOM_STARTED' });
  target.set({ notOwned: [] });
  await T.advance(SYNC_DEBOUNCE_MS + 10);
  assert.equal(target.get().ownSync, 'locked');
  assert.equal(told.length, 1);
  assert.match(told[0], /下一局生效/);
  // back in the lobby: sent again (accepted)
  net.emit('room.state', { inMatch: false });
  await T.advance(SYNC_DEBOUNCE_MS + 10);
  assert.deepEqual(net.sent.at(-1), { t: 'room.ownership', notOwned: [] });
  assert.equal(target.get().ownSync, 'synced');
  s.dispose();
});

// ---- match UI -------------------------------------------------------------------------------------------------------------

describe('match UI of a not-owned chess', () => {
  const priv = { standIns: [SILVER, MLYSS, SARIA], loadout: {}, board: [], hand: [], temp: [] };
  test('gameLogic: own pieces by m.private.standIns (normal + elite); the composed record keeps the identity', () => {
    assert.deepEqual(G.standInIds(priv), [SILVER, MLYSS, SARIA]);
    assert.equal(G.fieldsStandIn(priv, getChess(SILVER)), true);
    assert.equal(G.fieldsStandIn(priv, getChess(getChess(SILVER).goldenId)), true, 'the elite too');
    assert.equal(G.fieldsStandIn({ standIns: [] }, getChess(SILVER)), false);
    assert.equal(G.fieldsStandIn(null, getChess(SILVER)), false);
    const si = G.standInOf(getChess(SILVER), BACKUPS);
    assert.deepEqual([si.charId, si.name, si.standInFor, si.chessId, si.price, si.bonds], ['char_609_acguad', 'Sharp', getChess(SILVER).charId, SILVER, getChess(SILVER).price, getChess(SILVER).bonds]);
    assert.equal(G.standInOf(getChess(SILVER), BACKUPS), si, 'cached');
    assert.equal(G.standInOf(getChess(CATHY), BACKUPS), null, 'PRESET');
    assert.equal(G.standInLabel(si), '替补：Sharp');
    const lo = G.standInLoadout(si, getChess, BACKUPS);
    assert.equal(lo.skill.skillId, 'skchr_acguad_2', 'its backup skill (S2), never the player\'s loadout');
    // the deployed record: the stand-in's for a dropped chess, the loadout's otherwise
    assert.equal(G.deployedRecord(getChess(SILVER), priv, getChess, BACKUPS).charId, 'char_609_acguad');
    assert.equal(G.deployedRecord(getChess(SILVER), { standIns: [] }, getChess, BACKUPS).charId, getChess(SILVER).charId);
    const eg = getChess(getChess(MLYSS).goldenId);
    assert.equal(G.deployedModuleId(eg, priv, getChess, BACKUPS), eg.backup.uniEquipId, 'the backup module (SOL-X)');
  });

  test('placement: a dropped chess is placed by its stand-in\'s position (缪尔赛思 → 郁金香 melee, 塞雷娅 → Touch ranged)', () => {
    const stage = null; // (the deploy tiles are not needed for the placement class)
    const ctx = G.placementContext({ priv, stage, editable: true, getChess, backups: BACKUPS });
    assert.equal(G.piecePosition(ctx, { kind: 'chess', id: MLYSS }), 'MELEE');
    assert.equal(G.piecePosition(ctx, { kind: 'chess', id: SARIA }), 'RANGED');
    const own = G.placementContext({ priv: { standIns: [] }, stage, editable: true, getChess, backups: BACKUPS });
    assert.equal(G.piecePosition(own, { kind: 'chess', id: MLYSS }), 'RANGED');
    assert.equal(G.piecePosition(own, { kind: 'chess', id: SARIA }), 'MELEE');
  });

  test('shop / reward card: the chess\'s name, price and bonds stay, the 「替补：X」 badge and the stand-in\'s skill show', () => {
    const slot = { kind: 'chess', id: SILVER, price: 3, basePrice: 3 };
    const card = ChessCard({ slot, idx: 0, priv, onBuy() {}, onDetail() {} });
    const nodes = [...walk(card)];
    const badge = nodes.find((v) => hasClass(v, 'scard__standin'));
    assert.ok(badge, 'badge');
    assert.equal(badge.props['data-standin'], 'char_609_acguad');
    assert.equal(badge.props.children, '替补：Sharp');
    assert.equal(nodes.find((v) => hasClass(v, 'scard__name')).props.children, '银灰', 'the card keeps the chess\'s name');
    const skill = nodes.find((v) => v?.type && v.props?.lo);
    assert.equal(skill.props.lo.skill.skillId, 'skchr_acguad_2');
    const owned = ChessCard({ slot, idx: 0, priv: { standIns: [] }, onBuy() {}, onDetail() {} });
    assert.equal([...walk(owned)].find((v) => hasClass(v, 'scard__standin')), undefined, 'owned: no badge');
  });

  test('detail card: own piece / card → the stand-in\'s body under the chess\'s name; a unit with standInFor likewise', () => {
    const piece = { uid: 41, kind: 'chess', id: SILVER, golden: false, items: [] };
    const pieces = new Map([[41, { piece, area: 'hand', idx: 0 }]]);
    const r = resolveDetail({ kind: 'piece', uid: 41 }, pieces, { priv, backups: BACKUPS });
    assert.equal(r.standIn?.charId, 'char_609_acguad');
    assert.equal(resolveDetail({ kind: 'piece', uid: 41 }, pieces, { priv: { standIns: [] }, backups: BACKUPS }).standIn, null);
    assert.equal(resolveDetail({ kind: 'chess', id: SILVER }, new Map(), { priv, backups: BACKUPS }).standIn?.charId, 'char_609_acguad', 'a shop card');
    const u = resolveDetail({ kind: 'unit', unit: { id: 9, uid: 99, side: 'ally', kind: 'op', defId: SARIA, standInFor: getChess(SARIA).charId } }, new Map(), { priv: null, backups: BACKUPS });
    assert.equal(u.standIn?.charId, 'char_613_acmedc', 'a teammate\'s unit says it itself');
    const blocks = ChessDetail({ chess: r.chess, piece, editable: false, bonds: [], loadout: null, standIn: r.standIn });
    const head = blocks.find((b) => b.key === 'head');
    const tag = [...walk(head)].find((v) => hasClass(v, 'dtag-standin'));
    assert.equal(tag?.props.children, '替补：Sharp');
    assert.equal([...walk(head)].find((v) => hasClass(v, 'dhead__name')).props.children, '银灰');
    const skill = blocks.find((b) => b.key === 'skill');
    assert.ok(JSON.stringify(skill.props).includes(r.standIn.skill.name), 'the stand-in\'s skill');
    const talents = blocks.find((b) => b.key === 'talents');
    for (const t of r.standIn.talents.filter((x) => x.name && !x.hidden)) assert.ok(JSON.stringify(talents.props).includes(t.name), `talent ${t.name}`);
    assert.ok(!JSON.stringify(blocks).includes(getChess(SILVER).skill.name), 'not the replaced operator\'s skill');
  });

  test('own prep pieces with stand-ins get a tag (hand, temp, board); others none', () => {
    const p = {
      standIns: [SILVER],
      hand: [{ uid: 1, kind: 'chess', id: SILVER }, { uid: 2, kind: 'chess', id: CATHY }, null],
      temp: [{ uid: 3, kind: 'chess', id: getChess(SILVER).goldenId }],
      board: [{ uid: 4, kind: 'chess', id: SILVER, row: 10, col: 4 }, { uid: 5, kind: 'token', id: 'x', row: 9, col: 4 }],
    };
    assert.deepEqual(standInPieces(p, getChess, BACKUPS).map((x) => [x.uid, x.area, x.label]), [[1, 'hand', '替补：Sharp'], [3, 'temp', '替补：Sharp'], [4, 'board', '替补：Sharp']]);
    assert.deepEqual(standInPieces({ ...p, standIns: [] }, getChess, BACKUPS), []);
  });

  test('the board model of a dropped chess is the stand-in\'s (render/app.js pieceInfo reads m.private.standIns; the view is rebuilt when its model changes)', () => {
    const src = readFileSync(path.join(ROOT, 'public/js/render/app.js'), 'utf8');
    assert.match(src, /area === 'board' && chess && standInList\.includes\(chess\.baseId \|\| chess\.chessId\) \? data\.standIn\(piece\.id\) : null/);
    assert.match(src, /standInList = Array\.isArray\(src\.standIns\)/);
    assert.match(src, /const sig = `\$\{info\.kind\}\|\$\{info\.defId\}\|\$\{info\.golden \? 1 : 0\}\|\$\{info\.spine \|\| ''\}`/);
    assert.match(readFileSync(path.join(ROOT, 'public/js/render/app/info.js'), 'utf8'), /standInFor: typeof u\.standInFor === 'string'/);
  });
});
