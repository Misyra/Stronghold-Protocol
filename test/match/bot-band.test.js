// test/match/bot-band.test.js — AI 指定策略 (room.setBotBand): the strategy a room designates for an AI seat.
//
// The Match takes the seat's `band` (opts.seats[].band) into botBands; the draft holds that strategy for the seat
// (bandTaken / reservedBands / designatedBand, m.public draft.reserved) until it picks it, and the seat takes it on its
// turn (phases.js scheduleBandBot) or when the draft ends (finishBandDraft). A human can never pick it meanwhile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';
import { ERR, PHASE } from '../../shared/constants.js';

const BAND = 'band_bldsk';

function seatsWith(band) {
  return [
    { seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true },
    { seat: 1, playerId: 'p_1', name: 'P1', isBot: false, connected: true },
    { seat: 2, playerId: 'ai_0', name: 'AI0', isBot: true, connected: true, ...(band ? { band } : {}) },
  ];
}

/** Advance the draft until it ends, humans picking the first free strategy each turn. */
function runDraft(h) {
  const m = h.m;
  for (let guard = 0; guard < 40 && m.phase === PHASE.BAND_DRAFT; guard++) {
    const turn = m.draftTurn();
    const ps = turn ? m.players.get(turn) : null;
    if (ps && !ps.isBot && !m.draft.picks[ps.playerId]) {
      const id = m.gd.bandIds().find((b) => !m.bandTaken(b, ps.playerId));
      assert.deepEqual(m.handle(ps.playerId, { t: 'g.band', bandId: id }), { ok: true });
    } else h.sched.advance(0);
  }
}

test('the seat band rides into botBands, is held for the AI seat and shows in the draft view', (t) => {
  const h = makeMatch({ seats: seatsWith(BAND), aiPicksLast: true }).start();
  t.after(() => h.m.dispose());
  const m = h.m;
  assert.equal(m.botBands.get('ai_0'), BAND);
  assert.deepEqual(m.reservedBands(), { [BAND]: 'ai_0' });
  assert.equal(m.bandTaken(BAND, 'p_0'), true, 'held for the AI seat');
  assert.equal(m.bandTaken(BAND, 'ai_0'), false, 'its own strategy is free for it');
  assert.equal(m.designatedBand(m.players.get('ai_0')), BAND);
  assert.equal(m.designatedBand(m.players.get('p_0')), null);
  m.enterBandDraft();
  const pub = m.publicView();
  assert.equal(pub.draft.reserved[BAND], 'ai_0');
  // a human turn cannot take it (队友已选)
  const first = m.draftTurn();
  const ps = m.players.get(first);
  if (!ps.isBot) assert.equal(m.handle(first, { t: 'g.band', bandId: BAND }).error, ERR.BAD_TARGET);
  runDraft(h);
  assert.equal(m.draft.picks.ai_0, BAND, 'the AI seat took its designated strategy');
  assert.equal(m.players.get('ai_0').bandId, BAND);
  assert.deepEqual(m.publicView().draft?.reserved || {}, {}, 'nothing is held any more');
});

test('a designated strategy the mode does not offer is ignored (the seat picks by itself)', (t) => {
  const h = makeMatch({ seats: seatsWith('band_does_not_exist') }).start();
  t.after(() => h.m.dispose());
  const m = h.m;
  assert.equal(m.designatedBand(m.players.get('ai_0')), null);
  m.enterBandDraft();
  runDraft(h);
  assert.ok(m.draft.picks.ai_0);
  assert.notEqual(m.draft.picks.ai_0, 'band_does_not_exist');
});

test('a seat without a band holds nothing (the room designated no strategy)', (t) => {
  const h = makeMatch({ seats: seatsWith(null) }).start();
  t.after(() => h.m.dispose());
  const m = h.m;
  assert.equal(m.botBands.size, 0);
  assert.deepEqual(m.reservedBands(), {});
  assert.equal(m.publicView().draft?.reserved, undefined);
});
