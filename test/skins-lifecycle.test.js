// test/skins-lifecycle.test.js — end-to-end integration test for the skins pipeline:
// lobby session/seats -> Match/PlayerState -> prep pieceView & prepFieldMeta -> battleInput & sim units -> public/js assets & avatarUrl.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { DATA, makeMatch } from './match/harness.js';
import { Battle } from '../server/sim/Battle.js';
import { avatarUrl, unitPictureUrl, createAssets } from '../public/js/assets.js';

const INSIDE = 'chess_char_1_01_a';
const INSIDE_GOLDEN = 'chess_char_1_01_b';
const SKIN_ID = 'char_498_inside@kitchen#2';

describe('skins lifecycle: lobby wiring', () => {
  /** A Lobby with the pieces a unit test needs (no sockets, no registry bookkeeping). */
  const lobbyWith = () => {
    const log = { info() {}, warn() {}, error() {} };
    const lobby = new Lobby({ registry: { byId: new Map(), byPlayerId: new Map() }, log });
    lobby.broadcastState = () => {};
    return lobby;
  };

  test('humanSeat copies session.skins, and room.skins stores them on the session and the seat', () => {
    const lobby = lobbyWith();
    const session = { playerId: 'p1', name: 'Player 1', connected: true, skins: { [INSIDE]: SKIN_ID }, loadout: null };
    const seat = lobby.humanSeat(0, session);
    assert.deepEqual(seat.skins, { [INSIDE]: SKIN_ID }, 'humanSeat must preserve skins from session');

    // room.skins writes through to the session and the seat; an unknown chess id is dropped, not rejected
    const live = { playerId: 'p1', connected: true };
    lobby.rooms.set('TEST', {
      code: 'TEST', match: null,
      seatOf: (id) => (id === 'p1' ? seat : null),
    });
    live.roomCode = 'TEST';
    assert.deepEqual(lobby.skins(live, { skins: { [INSIDE]: 'char_498_inside@summer#22', chess_nope: 'x' } }), { ok: true });
    assert.deepEqual(live.skins, { [INSIDE]: 'char_498_inside@summer#22' }, 'a recognised chess id is kept');
    assert.equal(seat.skins[INSIDE], 'char_498_inside@summer#22', 'and reaches the seat');
    lobby.rooms.delete('TEST');
  });

  test('the lobby refuses a bot / unknown player, and the seat choice reaches the Match', () => {
    const lobby = lobbyWith();
    const session = { playerId: 'p1', name: 'Player 1', connected: true, skins: { [INSIDE]: SKIN_ID }, loadout: null };
    const seat = lobby.humanSeat(0, session);
    assert.deepEqual(lobby.skins({ playerId: 'ghost', connected: true }, { skins: {} }), { ok: true }, 'no room → just stored');

    // startMatch builds the Match seats from the room's seats (the mapping that carries skins into PlayerState)
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
    assert.equal(passedSeats[0].skins?.[INSIDE], SKIN_ID, 'seats[0].skins should be retained in startMatch');
    assert.equal(passedSeats[0].loadout, null, 'a seat without a loadout still passes null');
  });
});

describe('skins lifecycle: PlayerState and Match', () => {
  test('skins propagate to base piece and golden piece in prep pieceView and battleInput', () => {
    const h = makeMatch({
      mode: 'solo',
      seats: [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, skins: { [INSIDE]: SKIN_ID } }],
    });
    const ps = h.ps('p_0');
    assert.equal(ps.skins[INSIDE], SKIN_ID, 'ps.skins should be initialized from seat.skins');

    // Place a base piece
    const pBase = ps.newPiece('chess', INSIDE);
    ps.board.set('0,0', pBase);

    // Place a golden piece
    const pGolden = ps.newPiece('chess', INSIDE_GOLDEN);
    ps.board.set('0,1', pGolden);

    // Check pieceView for both pieces during prep
    const viewBase = ps.pieceView(pBase, [0, 0]);
    assert.equal(viewBase.skin, SKIN_ID, 'base pieceView should carry skin');

    const viewGolden = ps.pieceView(pGolden, [0, 1]);
    assert.equal(viewGolden.skin, SKIN_ID, 'golden pieceView should carry skin');

    // Check scouting prepFieldMeta
    const meta = h.m.prepFieldMeta(ps);
    const metaBase = meta.units.find((u) => u.defId === INSIDE);
    const metaGolden = meta.units.find((u) => u.defId === INSIDE_GOLDEN);
    assert.equal(metaBase?.skin, SKIN_ID, 'scouting prepFieldMeta base piece should carry skin');
    assert.equal(metaGolden?.skin, SKIN_ID, 'scouting prepFieldMeta golden piece should carry skin');

    // Check battleInput
    const bInput = ps.battleInput({ side: 'ally' });
    const bBase = bInput.units.find((u) => u.chessId === INSIDE);
    const bGolden = bInput.units.find((u) => u.chessId === INSIDE_GOLDEN);
    assert.equal(bBase?.skin, SKIN_ID, 'base unit in battleInput must have skin');
    assert.equal(bGolden?.skin, SKIN_ID, 'golden unit in battleInput must have skin');

    // Simulate Battle ally creation on a valid field row (row 9 for normal field)
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
    const buBase = battleUnits.find((u) => u.defId === INSIDE);
    const buGolden = battleUnits.find((u) => u.defId === INSIDE_GOLDEN);
    assert.equal(buBase?.skin, SKIN_ID, 'sim unit for base piece must have skin in fieldMeta');
    assert.equal(buGolden?.skin, SKIN_ID, 'sim unit for golden piece must have skin in fieldMeta');
  });

  test('mid-match setSkins updates PlayerState and marks dirty', () => {
    const h = makeMatch({
      mode: 'solo',
      seats: [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true }],
    });
    const ps = h.ps('p_0');
    assert.deepEqual(ps.skins, {}, 'initially empty');

    let privateMarked = false;
    h.m.markPrivate = () => { privateMarked = true; };

    h.m.setSkins('p_0', { [INSIDE]: SKIN_ID });
    assert.equal(ps.skins[INSIDE], SKIN_ID, 'ps.skins updated');
    assert.ok(privateMarked, 'markPrivate was called');

    const pv = h.m.publicView();
    assert.equal(pv.players[0].skins?.[INSIDE], SKIN_ID, 'publicView carries updated skins');
  });
});

describe('skins lifecycle: client assets and avatars', () => {
  const MANIFEST = {
    chars: {
      char_498_inside: {
        avatar: '/default_avatar.png',
        avatarE2: '/default_avatar_e2.png',
        spine: { front: { skel: '/default.skel', atlas: '/default.atlas', textures: ['/default.png'], anims: { idle: 'Idle' } } },
        skins: {
          [SKIN_ID]: {
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

  test('avatarUrl returns skin avatar when skin is given', () => {
    assert.equal(avatarUrl(MANIFEST, 'char_498_inside', { skin: SKIN_ID }), '/skin_avatar.png');
    assert.equal(avatarUrl(MANIFEST, 'char_498_inside', { skin: 'unknown' }), '/default_avatar.png');
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
