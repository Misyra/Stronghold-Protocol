// test/skins-lifecycle.test.js — the skins pipeline end to end: lobby session/seats -> Match/PlayerState ->
// prep pieceView & prepFieldMeta -> battleInput & sim units -> public/js assets & avatarUrl.
//
// The model is the catalogue's (docs/SKINS.md): one choice per OPERATOR (`{ [charId]: skinId }`), so a normal chess,
// its elite and a 自选 slot fielding the same operator share one entry, and the value is the catalogue id
// (shared/skin-catalogue.js) — data/assets.json is keyed by the official id, and shared/skins.js manifestSkinKey is the
// one place that translates between them.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { DATA, makeMatch } from './match/harness.js';
import { Battle } from '../server/sim/Battle.js';
import { avatarUrl, unitPictureUrl, createAssets } from '../public/js/assets.js';

const INSIDE = 'chess_char_1_01_a';
const INSIDE_GOLDEN = 'chess_char_1_01_b';
const INSIDE_CHAR = 'char_498_inside';
const SKIN_ID = 'char_498_inside_kitchen_2';        // 隐现 · 甜品大奖 (catalogue id)
const SKIN_OFFICIAL = 'char_498_inside@kitchen#2';  // the same outfit as data/assets.json keys it

describe('skins lifecycle: lobby wiring', () => {
  /**
   * A Lobby with the pieces a unit test needs (no sockets, no registry bookkeeping). The registry is the real
   * SessionRegistry — this fork's lobby reaches into it (`registry.byId`, the room limiter's `session.limitKey`),
   * so a hand-rolled `{ byId: new Map() }` stub is not enough.
   */
  const lobbyWith = () => {
    const log = { info() {}, warn() {}, error() {} };
    const lobby = new Lobby({ registry: new SessionRegistry(), log });
    lobby.broadcastState = () => {};
    return lobby;
  };

  test('humanSeat copies session.skins, and room.skins stores them on the session and the seat', () => {
    const lobby = lobbyWith();
    const session = { playerId: 'p1', name: 'Player 1', connected: true, skins: { [INSIDE_CHAR]: SKIN_ID }, loadout: null };
    const seat = lobby.humanSeat(0, session);
    assert.deepEqual(seat.skins, { [INSIDE_CHAR]: SKIN_ID }, 'humanSeat must preserve skins from session');

    const live = { playerId: 'p1', connected: true };
    lobby.rooms.set('TEST', {
      code: 'TEST', match: null,
      seatOf: (id) => (id === 'p1' ? seat : null),
    });
    live.roomCode = 'TEST';
    const CHOICE = { [INSIDE_CHAR]: 'char_498_inside_summer_22' };
    assert.deepEqual(lobby.skins(live, { choices: CHOICE }), { ok: true });
    assert.deepEqual(live.skins, CHOICE, 'the catalogue choice is kept as sent');
    assert.deepEqual(seat.skins, CHOICE, 'and reaches the seat');
    lobby.rooms.delete('TEST');
  });

  test('the lobby refuses a map the catalogue does not admit, whole', () => {
    const lobby = lobbyWith();
    const seat = lobby.humanSeat(0, { playerId: 'p1', name: 'P', connected: true, loadout: null });
    lobby.rooms.set('TEST', { code: 'TEST', match: null, seatOf: (id) => (id === 'p1' ? seat : null) });
    const live = { playerId: 'p1', connected: true, roomCode: 'TEST' };
    // a chess id key, another operator's outfit, the official id instead of the catalogue id, a made-up id
    for (const choices of [
      { [INSIDE]: SKIN_ID },
      { [INSIDE_CHAR]: 'char_103_angel_wild_1' },
      { [INSIDE_CHAR]: SKIN_OFFICIAL },
      { [INSIDE_CHAR]: 'char_498_inside@made_up#9' },
      { [INSIDE_CHAR]: 42 },
    ]) {
      assert.equal(lobby.skins(live, { choices }).error, 'BAD_MSG', JSON.stringify(choices));
    }
    assert.equal(live.skins, undefined, 'nothing was stored');
    lobby.rooms.delete('TEST');
  });

  test('the lobby refuses a bot / unknown player, and the seat choice reaches the Match', () => {
    const lobby = lobbyWith();
    const session = { playerId: 'p1', name: 'Player 1', connected: true, skins: { [INSIDE_CHAR]: SKIN_ID }, loadout: null };
    const seat = lobby.humanSeat(0, session);
    assert.deepEqual(lobby.skins({ playerId: 'ghost', connected: true }, { choices: {} }), { ok: true }, 'no room → just stored');

    const room = {
      code: 'TEST', hostId: 'p1', mode: 'solo', difficulty: 'NORMAL', aiPicksLast: false,
      seats: [seat], spectators: [], matchCount: 0,
      seatOf: (id) => (id === 'p1' ? seat : null),
      activeHumans: () => [seat],
    };
    let passedSeats = null;
    class MockMatch {
      constructor(opts) { passedSeats = opts.seats; }
      start() {}
    }
    lobby.MatchClass = MockMatch;
    lobby.startMatch(room);
    assert.ok(passedSeats, 'seats should be passed to Match');
    assert.equal(passedSeats[0].skins?.[INSIDE_CHAR], SKIN_ID, 'seats[0].skins should be retained in startMatch');
    assert.equal(passedSeats[0].loadout, null, 'a seat without a loadout still passes null');
  });
});

describe('skins lifecycle: PlayerState and Match', () => {
  test('one entry covers the operator: base and golden piece alike, in pieceView, prepFieldMeta, battleInput and the sim', () => {
    const h = makeMatch({
      mode: 'solo',
      seats: [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, skins: { [INSIDE_CHAR]: SKIN_ID } }],
    });
    const ps = h.ps('p_0');
    assert.equal(ps.skins[INSIDE_CHAR], SKIN_ID, 'ps.skins should be initialized from seat.skins');
    assert.equal(ps.skinIdFor(ps.gd.chess(INSIDE)), SKIN_ID, 'the base chess resolves through its operator');
    assert.equal(ps.skinIdFor(ps.gd.chess(INSIDE_GOLDEN)), SKIN_ID, 'and so does its elite — same operator');
    assert.equal(ps.skinIdFor(ps.gd.chess('chess_char_2_01_a')), null, 'another operator keeps its own model');

    const pBase = ps.newPiece('chess', INSIDE);
    ps.board.set('0,0', pBase);
    const pGolden = ps.newPiece('chess', INSIDE_GOLDEN);
    ps.board.set('0,1', pGolden);

    assert.equal(ps.pieceView(pBase, [0, 0]).skin, SKIN_ID, 'base pieceView should carry skin');
    assert.equal(ps.pieceView(pGolden, [0, 1]).skin, SKIN_ID, 'golden pieceView should carry skin');

    const meta = h.m.prepFieldMeta(ps);
    assert.equal(meta.units.find((u) => u.defId === INSIDE)?.skin, SKIN_ID, 'scouting prepFieldMeta base piece');
    assert.equal(meta.units.find((u) => u.defId === INSIDE_GOLDEN)?.skin, SKIN_ID, 'scouting prepFieldMeta golden piece');

    const bInput = ps.battleInput({ side: 'ally' });
    const bBase = bInput.units.find((u) => u.chessId === INSIDE);
    const bGolden = bInput.units.find((u) => u.chessId === INSIDE_GOLDEN);
    assert.equal(bBase?.skin, SKIN_ID, 'base unit in battleInput must have skin');
    assert.equal(bGolden?.skin, SKIN_ID, 'golden unit in battleInput must have skin');

    const b = new Battle({
      fieldId: 'n:p_0',
      kind: 'normal',
      players: [{
        playerId: 'p_0',
        units: [
          { kind: 'chess', chessId: INSIDE, row: 9, col: 0, skin: bBase.skin },
          { kind: 'chess', chessId: INSIDE_GOLDEN, row: 9, col: 1, skin: bGolden.skin },
        ],
      }],
      spawns: [],
      data: DATA,
      log: { warn() {}, error() {}, info() {} },
    });
    b.start();
    const battleUnits = b.fieldMeta().units;
    assert.equal(battleUnits.find((u) => u.defId === INSIDE)?.skin, SKIN_ID, 'sim unit for base piece');
    assert.equal(battleUnits.find((u) => u.defId === INSIDE_GOLDEN)?.skin, SKIN_ID, 'sim unit for golden piece');
  });

  test('a 自选 slot wears the outfit of the operator PICKED for it (skinIdFor reads the body, never the slot)', () => {
    // A 自选 slot's own record has `charId: null` — the slot is not an operator. What it fields is its pick, and
    // PlayerState.fieldRecord is what resolves one to the other; stubbed here so the rule is visible without a legal
    // roster (checkDiyPicks needs the tier pools, which a unit test's data does not carry).
    const h = makeMatch({
      mode: 'solo',
      seats: [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, skins: { char_103_angel: 'char_103_angel_wild_1' } }],
    });
    const ps = h.ps('p_0');
    const slot = { isDiy: true, chessId: 'chess_char_6_diy1_a', baseId: 'chess_char_6_diy1_a', charId: null };
    assert.equal(ps.skinIdFor(slot), null, 'an unfilled slot wears nothing');
    const saved = ps.fieldRecord;
    ps.fieldRecord = () => ({ charId: 'char_103_angel' });
    try {
      assert.equal(ps.skinIdFor(slot), 'char_103_angel_wild_1', 'a slot filled with 能天使 wears her outfit');
    } finally { ps.fieldRecord = saved; }
  });

  test('setSkins is accepted in the briefing only, refuses bots, and marks the public view', () => {
    const h = makeMatch({
      mode: 'solo',
      seats: [
        { seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true },
        { seat: 1, playerId: 'b_1', name: 'B1', isBot: true, connected: true },
      ],
    });
    const ps = h.ps('p_0');
    assert.deepEqual(ps.skins, {}, 'initially empty');
    // A fresh match is still in the LOBBY: the lobby stores the choice on the seat and the briefing is where a MATCH
    // takes it (Match.setSkins), so both phases are exercised here.
    assert.equal(h.m.phase, 'LOBBY');
    assert.equal(h.m.setSkins('p_0', { [INSIDE_CHAR]: SKIN_ID }).error, 'WRONG_PHASE', 'the lobby stores, the briefing applies');

    const phase0 = h.m.phase;
    h.m.phase = 'INFO_CHECK';
    let privateMarked = false;
    h.m.markPrivate = () => { privateMarked = true; };
    assert.deepEqual(h.m.setSkins('p_0', { [INSIDE_CHAR]: SKIN_ID }), { ok: true });
    assert.equal(ps.skins[INSIDE_CHAR], SKIN_ID, 'ps.skins updated');
    assert.ok(privateMarked, 'markPrivate was called');
    assert.equal(h.m.publicView().players[0].skins?.[INSIDE_CHAR], SKIN_ID, 'publicView carries updated skins');

    assert.equal(h.m.setSkins('b_1', { [INSIDE_CHAR]: SKIN_ID }).error, 'NOT_IN_ROOM', 'a bot has no choice to make');
    assert.equal(h.m.setSkins('p_0', { [INSIDE_CHAR]: 'char_103_angel_wild_1' }).error, 'BAD_MSG', 'not this operator\'s outfit');

    h.m.phase = 'PREP';
    try {
      assert.equal(h.m.setSkins('p_0', {}).error, 'WRONG_PHASE', 'display choices close with the briefing');
      assert.equal(ps.skins[INSIDE_CHAR], SKIN_ID, 'and the briefing choice stands');
    } finally { h.m.phase = phase0; }
  });

  test('a restored checkpoint keeps the choices it can still verify', () => {
    const h = makeMatch({
      mode: 'solo',
      seats: [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true,
        skins: { [INSIDE_CHAR]: SKIN_ID, char_103_angel: 'char_gone@nope#1' } }],
    });
    assert.deepEqual(h.ps('p_0').skins, {}, 'a map the catalogue does not admit is refused whole, not half-applied');
  });
});

describe('skins lifecycle: client assets and avatars', () => {
  // keyed the way our data/assets.json is: per operator, then by OFFICIAL id
  const MANIFEST = {
    chars: {
      char_498_inside: {
        avatar: '/default_avatar.png',
        avatarE2: '/default_avatar_e2.png',
        spine: { front: { skel: '/default.skel', atlas: '/default.atlas', textures: ['/default.png'], anims: { idle: 'Idle' } } },
        skins: {
          [SKIN_OFFICIAL]: {
            avatar: '/skin_avatar.png',
            spine: {
              front: { skel: '/skin.skel', atlas: '/skin.atlas', textures: ['/skin.png'], anims: { idle: 'Idle' } },
              back: { skel: '/skin_back.skel', atlas: '/skin_back.atlas', textures: ['/skin_back.png'], anims: { idle: 'Idle' } },
            },
          },
        },
      },
    },
  };

  test('avatarUrl resolves the catalogue id (and the official one) through the manifest key', () => {
    assert.equal(avatarUrl(MANIFEST, 'char_498_inside', { skin: SKIN_ID }), '/skin_avatar.png');
    assert.equal(avatarUrl(MANIFEST, 'char_498_inside', { skin: SKIN_OFFICIAL }), '/skin_avatar.png');
    assert.equal(avatarUrl(MANIFEST, 'char_498_inside', { skin: 'char_498_inside_gone_9' }), '/default_avatar.png');
    assert.equal(avatarUrl(MANIFEST, 'char_498_inside'), '/default_avatar.png');
  });

  test('unitPictureUrl forwards opts to avatarUrl', () => {
    assert.equal(unitPictureUrl(MANIFEST, 'char_498_inside', { skin: SKIN_ID }), '/skin_avatar.png');
  });

  test('createAssets forwards skinId to hasBack and opts to picture', () => {
    const assets = createAssets({ manifest: MANIFEST });
    assert.equal(assets.hasBack('char_498_inside', SKIN_ID), true, 'skin has back spine');
    assert.equal(assets.hasBack('char_498_inside'), false, 'default model has no back spine');
    assert.equal(assets.picture('char_498_inside', { skin: SKIN_ID }), '/skin_avatar.png');
  });
});
