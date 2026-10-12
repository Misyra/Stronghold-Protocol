// test/ui/deploy-replay.test.js — PR #416 by @Cromemadnd, ported in 0.2.6 (DESIGN §31.8): the round start replays the own
// board's Start clips in deployment order (ui/gameLogic deployOrder / roundStartReplay — the maintainer's confirmation from
// official play, 2026-10-13), and a landing sounds like the piece's battle deployment through the SFX channel
// (public/js/audio.js deployCue). The view side is test/render/deploy-replay.test.js, the browser check
// test/ui/deploy-replay.e2e.test.js.
// Run: node --test test/ui/deploy-replay.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployOrder, roundStartReplay } from '../../public/js/ui/gameLogic.js';
import { AudioManager, deploySfxUrl } from '../../public/js/audio.js';
import { PHASE } from '../../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'data', 'assets.json'), 'utf8'));
const chess = (uid, row, col, extra = {}) => ({ uid, kind: 'chess', id: `chess_${uid}`, row, col, ...extra });

describe('deployOrder — the order the battle deploys the board (Battle.start)', () => {
  test('operators by column from the left, top to bottom within a column, then the summons the same way; no items', () => {
    // board rows 9 (bottom) … 12 (top), cols 2 … 10; given in reading order, as m.private sends it (server board.js boardOrder)
    const board = [
      chess(1, 12, 5), chess(2, 12, 2), { uid: 3, kind: 'token', id: 'token_a', row: 12, col: 3 }, chess(4, 11, 2),
      { uid: 5, kind: 'item', id: 'chess_item_6_03_m', row: 10, col: 4 }, chess(6, 10, 5), chess(7, 9, 3),
      { uid: 8, kind: 'token', id: 'token_b', row: 9, col: 2 },
    ];
    assert.deepEqual(deployOrder(board), [2, 4, 7, 1, 6, 8, 3]);
    // the same rule the client's merge target uses (gameLogic mergeTarget: col asc, then row desc)
    assert.deepEqual(deployOrder([chess(1, 9, 4), chess(2, 12, 4), chess(3, 10, 3)]), [3, 2, 1]);
  });

  test('junk and missing fields are left out; an empty or absent board is no order', () => {
    assert.deepEqual(deployOrder(null), []);
    assert.deepEqual(deployOrder([]), []);
    assert.deepEqual(deployOrder([null, 'x', { uid: 1, kind: 'chess', row: 10 }, { kind: 'chess', row: 10, col: 3 }, chess(9, 10, 3)]), [9]);
  });
});

describe('roundStartReplay — once per round, in 回合开始, on the own board', () => {
  const board = [chess(11, 12, 6), chess(12, 9, 2)];
  const base = { phase: PHASE.ROUND_START, round: 7, replayed: 6, ownBoard: true, board };

  test('due in 回合开始 of a round not replayed yet: its pieces in deployment order', () => {
    assert.deepEqual(roundStartReplay(base), { round: 7, uids: [12, 11] });
  });

  test('not again for the same round (a reconnect, a re-render); not in another phase', () => {
    assert.equal(roundStartReplay({ ...base, replayed: 7 }), null);
    for (const phase of [PHASE.PREP, PHASE.SP_DRAFT, PHASE.SETTLE, PHASE.COMBAT, PHASE.BATTLE_CHECK, null]) {
      assert.equal(roundStartReplay({ ...base, phase }), null, String(phase));
    }
    assert.equal(roundStartReplay({ ...base, round: null }), null);
  });

  test('only the viewer\'s own board: a scouted teammate, a spectator seat or an eliminated player gets none', () => {
    assert.equal(roundStartReplay({ ...base, ownBoard: false }), null);
  });

  test('an empty board (or a private state not here yet) schedules nothing — and marks nothing, so a board that arrives later in 回合开始 still plays', () => {
    assert.equal(roundStartReplay({ ...base, board: [] }), null);
    assert.equal(roundStartReplay({ ...base, board: undefined }), null);
    assert.deepEqual(roundStartReplay({ ...base, replayed: null }), { round: 7, uids: [12, 11] });
  });

  test('screens/game.js asks after the wiring effect and marks the round only once the view took the sequence', () => {
    const src = readFileSync(path.join(ROOT, 'public/js/screens/game.js'), 'utf8');
    const wiring = src.indexOf('}, [view, showPrep, priv, editable, field, combat, mode, watchingOther, watching, holdSeq]);');
    const replay = src.indexOf('const plan = roundStartReplay(');
    assert.ok(wiring > 0 && replay > wiring, 'the replay effect runs after setPrep in the same commit');
    assert.match(src, /roundStartReplay\(\{ phase, round: pub\?\.round, replayed: replayedRef\.current, ownBoard: showPrep && alive && !spectator, board: priv\?\.board \}\)/);
    assert.match(src, /if \(plan && view && view\.replayDeploys\?\.\(plan\.uids\) > 0\) replayedRef\.current = plan\.round;/);
    assert.doesNotMatch(src, /deployPiece|deploySequence/, 'no landing at the wheel\'s confirm: the state that shows the move lands the piece once');
    const host = readFileSync(path.join(ROOT, 'public/js/ui/fieldHost.js'), 'utf8');
    assert.match(host, /'stripesUnder', 'replayDeploys'\]/, 'an optional view method (the simplified board has none)');
  });
});

describe('AudioManager.deployCue — the landing sound', () => {
  const OWN = Object.keys(manifest.audio.sfx.units).find((k) => k.startsWith('char_') && typeof manifest.audio.sfx.units[k].born === 'string');
  const PLAIN = Object.keys(manifest.chars).find((k) => !manifest.audio.sfx.units[k]?.born);
  const rig = (o = {}) => {
    const a = new AudioManager({ win: null, getManifest: () => manifest, random: () => 0, ...o });
    a.ctx = {};                                    // unlocked
    const played = [];
    a._play = (url, opt) => { played.push({ url, ...opt }); };
    return { a, played };
  };

  test('the sound of the piece\'s battle deployment: its own ON_UNIT_BORN file, else b_char_set / b_char_tokenset, limited per piece', () => {
    assert.ok(OWN && PLAIN, 'the manifest has operators with and without an own deploy sound');
    const { a, played } = rig();
    assert.equal(a.deployCue({ def: OWN, defId: 'chess_x', kind: 'op' }, 'p:3'), true);
    assert.equal(a.deployCue({ def: PLAIN, defId: 'chess_y', kind: 'op' }, 'p:4'), true);
    assert.equal(a.deployCue({ def: 'token_10000_silent_healrb', defId: 'token_10000_silent_healrb', kind: 'token' }, 'p:5'), true);
    assert.deepEqual(played.map((p) => p.url), [
      manifest.audio.sfx.units[OWN].born, manifest.audio.sfx.battle.deploy,
      deploySfxUrl(manifest, { def: 'token_10000_silent_healrb', defId: 'token_10000_silent_healrb', kind: 'token', side: 'ally' }),
    ]);
    assert.equal(played[2].url, manifest.audio.sfx.units.token_10000_silent_healrb?.born ?? manifest.audio.sfx.battle.tokenDeploy, 'a summon: the token sound');
    assert.deepEqual(played.map((p) => [p.limited, p.unitKey]), [[true, 'land:p:3'], [true, 'land:p:4'], [true, 'land:p:5']], 'the battle limiter: ≤ 2 copies of one sound, a cooldown per piece');
    assert.equal(played[1].volume, 0.5, 'the generic file at the battle deploy\'s gain');
    assert.ok(played[0].volume > 0 && played[0].volume <= 0.8, 'an own file at its bank gain');
  });

  test('a piece without a sound, an enemy model, no manifest: nothing, never a throw', () => {
    const { a, played } = rig({ getManifest: () => ({ audio: { sfx: { battle: {}, units: {} } } }) });
    assert.equal(a.deployCue({ def: 'char_x', kind: 'op' }, 1), false);
    const none = rig({ getManifest: () => null });
    assert.equal(none.a.deployCue({ def: 'char_x', kind: 'op' }, 1), false);
    assert.equal(none.a.deployCue(null, 1), false);
    assert.equal(played.length + none.played.length, 0);
  });

  test('the SFX volume and mute apply: muted or at 0 nothing is even fetched', () => {
    const a = new AudioManager({ win: null, getManifest: () => manifest, random: () => 0 });
    a.ctx = {};
    const fetched = [];
    a._buffer = (url) => { fetched.push(url); return Promise.resolve(null); };
    a.setVolumes({ sfx: 0.8, muted: true });
    a.deployCue({ def: PLAIN, kind: 'op' }, 'p:1');
    a.setVolumes({ sfx: 0, muted: false });
    a.deployCue({ def: PLAIN, kind: 'op' }, 'p:2');
    assert.deepEqual(fetched, []);
    a.setVolumes({ sfx: 0.8, muted: false });
    a.deployCue({ def: PLAIN, kind: 'op' }, 'p:3');
    assert.deepEqual(fetched, [manifest.audio.sfx.battle.deploy]);
  });
});
