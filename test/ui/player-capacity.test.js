// The capacity contracts behind the 扩展同盟人数 UI (移植自 Stardust fork 的 player-capacity / experimental 测试，按本仓
// 模块与命名适配): the room derives its seats from room.state experimental (shared/playerCapacity.js roomCapacity), the
// host's option set for room.setExperimental keeps the shared isExperimental shape, and the draft / 机变 normalisers
// consume m.public draft.allowRepeat / concurrent / free and the 22-card deck (MAX_DRAFT_CARDS). Pure functions only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeSeats, roomFacts, capacityOption, duckLordOption, capacityExperimental, duckLordExperimental } from '../../public/js/screens/room.js';
import { allowedBands, teammateBands, draftTip, draftInfoStatus, freeBandAction, DEFAULT_TIMEOUT_BAND } from '../../public/js/screens/bandDraft.js';
import { normalizeDraft, normalizeSp, draftMyTurn } from '../../public/js/ui/gameLogic.js';
import { MAX_DRAFT_CARDS, isPlayerCapacity } from '../../shared/playerCapacity.js';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const rules = (capacity) => ({ revivalEnabled: false, disableSharedPool: false, ...(capacity > 4 ? { playerCapacity: capacity } : {}) });
const seat = (i, ready = true) => ({ seat: i, playerId: `p${i}`, name: `Capacity${i}`, ready, connected: true, isBot: false });
const room = (capacity, seatsN = capacity) => ({ mode: 'coop', hostId: 'p0', code: 'ABCD12', experimental: rules(capacity), seats: Array.from({ length: seatsN }, (_, i) => seat(i)) });

test('room rendering derives the admitted seats without losing the last member', () => {
  for (const capacity of [4, 8, 12, 16, 20]) {
    const r = room(capacity);
    const seats = normalizeSeats(r), facts = roomFacts(r, `p${capacity - 1}`);
    assert.equal(seats.length, capacity);
    assert.equal(seats.at(-1).playerId, `p${capacity - 1}`);
    assert.equal(facts.mine.seat, capacity - 1);
    assert.equal(facts.humans.length, capacity);
    assert.equal(roomFacts(r, 'p0').canStart, true);
    r.seats.at(-1).ready = false;
    assert.equal(roomFacts(r, 'p0').canStart, false);
  }
  assert.equal(normalizeSeats({ ...room(4), mode: 'solo' }).length, 1);
  // a standard room's state carries no experimental at all
  assert.equal(normalizeSeats({ mode: 'coop', hostId: 'p0', seats: [seat(0)] }).length, 4);
});

test('the option set for room.setExperimental keeps the shared shape and never mutates the room\'s', () => {
  const before = rules(4);
  const next = capacityExperimental(8, before);
  assert.deepEqual(next, rules(8));
  assert.deepEqual(before, rules(4), 'the room\'s options are read, not written');
  assert.deepEqual(capacityExperimental(16, { revivalEnabled: true, disableSharedPool: true, playerCapacity: 8, disableDuckLord: true }),
    { revivalEnabled: true, disableSharedPool: true, playerCapacity: 16, disableDuckLord: true });
  // back to the official four: a standard two-flag payload, 禁用鸭爵策略 goes with the capacity
  assert.deepEqual(capacityExperimental(4, { revivalEnabled: false, disableSharedPool: false, playerCapacity: 20, disableDuckLord: true }), rules(4));
  assert.deepEqual(capacityExperimental(21, rules(4)), rules(4), 'a non-capacity number is refused');
  // 禁用鸭爵策略 only rides an expanded room
  assert.deepEqual(duckLordExperimental(true, rules(4)), rules(4));
  assert.deepEqual(duckLordExperimental(true, rules(8)), { ...rules(8), disableDuckLord: true });
  assert.deepEqual(duckLordExperimental(false, { ...rules(8), disableDuckLord: true }), rules(8));
  assert.ok(isPlayerCapacity(4) && isPlayerCapacity(20) && !isPlayerCapacity(6));
  assert.equal(MAX_DRAFT_CARDS, 22);
});

test('capacity controls are host-only in a private co-op room, and hidden or read-only otherwise', () => {
  assert.equal(capacityOption(room(4), 'p0')?.editable, true);
  assert.equal(capacityOption(room(8), 'p0')?.expanded, true);
  assert.equal(capacityOption(room(8), 'p1')?.editable, false, 'not the host');
  assert.equal(capacityOption({ ...room(8), source: 'matchmaking' }, 'p0'), null, 'a queue-allocated room never widens');
  assert.equal(capacityOption({ ...room(8), mode: 'solo' }, 'p0'), null);
  assert.deepEqual(duckLordOption(room(4), 'p0'), null, 'an ordinary room has no duck-lord switch');
  assert.deepEqual(duckLordOption(room(8), 'p0'), { on: false, editable: true });
  assert.deepEqual(duckLordOption({ ...room(8), experimental: { ...rules(8), disableDuckLord: true } }, 'p0'), { on: true, editable: true });
  // the screen sends the whole option set through room.setExperimental
  assert.match(source('../../public/js/screens/room.js'), /net\.request\('room\.setExperimental', \{ experimental: capacityExperimental\(capacity, room\.experimental\) \}\)/);
  assert.match(source('../../public/js/screens/room.js'), /net\.request\('room\.setExperimental', \{ experimental: duckLordExperimental\(on, room\.experimental\) \}\)/);
});

test('draft contracts: allowRepeat stands the 队友已选 guard down, 禁用鸭爵策略 drops the strategy from the wall', () => {
  const bands = [
    { bandId: 'band_ducklord', sortId: 1, modeTypeList: ['MULTI'] },
    { bandId: 'band_bldsk', sortId: 2, modeTypeList: ['MULTI'] },
    { bandId: 'band_other', sortId: 3, modeTypeList: ['SINGLE'] },
  ];
  assert.deepEqual(allowedBands(bands, 'MULTI').map((b) => b.bandId), ['band_ducklord', 'band_bldsk']);
  assert.deepEqual(allowedBands(bands, 'MULTI', true).map((b) => b.bandId), ['band_bldsk']);
  assert.deepEqual(allowedBands(bands, 'MULTI', false).map((b) => b.bandId), ['band_ducklord', 'band_bldsk']);
  const picks = new Map([['p1', 'band_bldsk'], ['p2', 'band_other']]);
  assert.deepEqual([...teammateBands(picks, 'p0', true).keys()], [], 'allowRepeat: nothing counts as taken');
  assert.deepEqual([...teammateBands(picks, 'p0').keys()], ['band_bldsk', 'band_other']);
});

test('draft tips: a concurrent draft has no skip and one clock; a free draft names the lock', () => {
  const classic = draftTip({ timed: true, turnSeconds: 30, autoName: '华法琳' });
  assert.match(classic, /跳过/);
  assert.doesNotMatch(classic, /同时选择|锁定/);
  const concurrent = draftTip({ timed: true, turnSeconds: 30, autoName: '华法琳', concurrent: true });
  assert.match(concurrent, /所有博士同时选择/);
  assert.doesNotMatch(concurrent, /跳过/);
  assert.match(concurrent, /限时 30 秒/);
  const free = draftTip({ timed: true, turnSeconds: 30, autoName: '华法琳', concurrent: true, free: true });
  assert.match(free, /锁定前可以取消或改选/);
  assert.match(free, /自动选择「华法琳」/);
  assert.match(draftTip({ timed: false, concurrent: true }), /所有博士同时选择；本局不限时/, 'untimed keeps its clock-free line, without the skip');
  // the status line of 本局信息: a hold is said, a pick unchanged
  assert.match(draftInfoStatus({ myTurn: false, secs: 30, heldName: '华法琳' }).text, /尚未锁定/);
  assert.equal(draftInfoStatus({ myPick: 'x', pickName: '华法琳' }).text, draftInfoStatus({ myPick: 'x', pickName: '华法琳', heldName: null }).text);
});

test('freeBandAction: the detail pane offers hold / switch / cancel+lock by what is held', () => {
  const taken = new Map([['band_a', ['p1']]]);
  assert.equal(freeBandAction({ sel: 'band_a', myHold: null, myPick: null, taken, drafting: true }), 'taken');
  assert.equal(freeBandAction({ sel: 'band_b', myHold: 'band_b', myPick: null, taken, drafting: true }), 'held');
  assert.equal(freeBandAction({ sel: 'band_b', myHold: 'band_a', myPick: null, taken, drafting: true }), 'switch');
  assert.equal(freeBandAction({ sel: 'band_b', myHold: null, myPick: null, taken, drafting: true }), 'hold');
  assert.equal(freeBandAction({ sel: 'band_b', myHold: 'band_b', myPick: 'band_b', taken, drafting: true }), 'locked');
  assert.equal(freeBandAction({ sel: null, myHold: null, myPick: null, taken, drafting: true }), 'none');
  assert.equal(freeBandAction({ sel: 'band_b', myHold: null, myPick: null, taken, drafting: false }), 'none', 'a spectator drafts nothing');
});

test('normalizeDraft: holds, concurrent and free ride the normalised shape; solo and turns keep working', () => {
  const players = Array.from({ length: 8 }, (_, i) => ({ playerId: `p${i + 1}` }));
  const d = normalizeDraft({ order: players.map((p) => p.playerId), turn: 'p3', picks: { p1: 'band_a', p2: 'band_b' }, concurrent: true, free: true, allowRepeat: true,
    holds: { p3: 'band_c', p1: 'band_x', p4: 'band_a' } }, players);
  assert.equal(d.concurrent, true);
  assert.equal(d.free, true);
  assert.equal(d.allowRepeat, true);
  assert.deepEqual([...d.holds.entries()], [['p3', 'band_c'], ['p4', 'band_a']], 'a seat that locked is never in the holds');
  assert.equal(d.turnPid, 'p3');
  assert.deepEqual(normalizeDraft({ order: ['p1'], picks: {} }, players), { order: ['p1'], turnPid: null, picks: new Map(), skipsLeft: new Map(), done: false, holds: new Map() }, 'a classic draft grows no flags');
  // draftMyTurn: concurrent — everyone in the order without a pick; classic — the turn's seat
  assert.equal(draftMyTurn(d, 'p3'), true);
  assert.equal(draftMyTurn(d, 'p4'), true);
  assert.equal(draftMyTurn(d, 'p1'), false, 'already picked');
  assert.equal(draftMyTurn(d, 'pX'), false);
  assert.equal(draftMyTurn(normalizeDraft({ order: ['p1', 'p2'], turn: 'p2', picks: {} }), 'p1'), false);
  assert.equal(draftMyTurn(normalizeDraft({ order: ['p1', 'p2'], turn: 'p2', picks: {} }), 'p2'), true);
  assert.equal(draftMyTurn(d, 'p3', true), true, 'solo is always to pick');
});

test('normalizeSp keeps MAX_DRAFT_CARDS cards and lets an expanded 机变 share cards', () => {
  const players = Array.from({ length: 20 }, (_, i) => ({ playerId: `p${i + 1}` }));
  const cards = Array.from({ length: 24 }, (_, i) => ({ id: `card${i}` }));
  const picks = Object.fromEntries(players.slice(0, 6).map((p, i) => [p.playerId, i]));
  const sp = normalizeSp({ family: 'bounty', cards, picks, turn: 'p7' }, players);
  assert.equal(sp.cards.length, MAX_DRAFT_CARDS, 'the deck is the 22-card contract, not six');
  assert.equal(sp.cards.at(-1).idx, MAX_DRAFT_CARDS - 1);
  assert.equal(sp.pickOf.size, 6);
  assert.equal(sp.turnPid, 'p7');
  // allowRepeat: two seats may hold one card; the pick echo (taken / card.takenBy) never steals the pick of a seat
  const shared = normalizeSp({ family: 'bounty', cards: cards.slice(0, 4), allowRepeat: true, concurrent: true,
    picks: { a: 0, b: 0 }, taken: { 0: 'z' } }, players);
  assert.equal(shared.allowRepeat, true);
  assert.equal(shared.concurrent, true);
  assert.equal(shared.takenBy.get(0), 'a', 'the first pick keeps the card');
  assert.equal(shared.pickOf.get('a'), 0);
  assert.equal(shared.pickOf.get('b'), 0, 'both seats picked');
  // classic behaviour is unchanged: six cards at most, one seat per card
  const classic = normalizeSp({ family: 'bounty', cards, picks: { a: 0 }, taken: { 0: 'b' } }, players.slice(0, 4));
  assert.equal(classic.cards.length, MAX_DRAFT_CARDS);
  assert.equal(classic.takenBy.get(0), 'b', 'the taken echo wins without allowRepeat');
  assert.equal(classic.allowRepeat, undefined);
  assert.equal(classic.concurrent, undefined);
});

test('the settle team page and the expanded room screen carry their wide-room pieces', () => {
  const settle = source('../../public/js/screens/settle.js');
  assert.match(settle, /const wide = r\.players\.length > 4;/);
  assert.match(settle, /wide && 'is-wide'/);
  const css = source('../../public/css/screens/settle.css');
  assert.match(css, /\.steam__cards\.is-wide \{ justify-content: flex-start; overflow-x: auto;/);
  const roomJs = source('../../public/js/screens/room.js');
  assert.match(roomJs, /rs--big/);
  assert.match(source('../../public/css/screens/room.css'), /\.rs--big \.rseat \{ --w: max\(1\.7rem, 32px, calc\(120px \* var\(--sp-ui, 1\)\)\);/);
  // the default timeout band is untouched by the capacity work
  assert.equal(DEFAULT_TIMEOUT_BAND, 'band_bldsk');
});
