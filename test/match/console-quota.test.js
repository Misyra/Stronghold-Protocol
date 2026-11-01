// test/match/console-quota.test.js — the developer console's quota (room.console.enable, intents.js consoleGrant):
// m.private carries the counters the client's console modal shows (console.roundUses/totalUses/roundLimit/totalLimit,
// ui/console.js), the per-round quota resets with the round (PlayerRound.startRound) while the match total keeps
// counting until CONSOLE_TOTAL_LIMIT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, CONSOLE_ROUND_LIMIT, CONSOLE_TOTAL_LIMIT } from '../../shared/constants.js';
import { DATA, makeMatch } from './harness.js';

const BONDS = Object.keys(DATA.bonds);

test('m.private carries the console quota; grants move it, the round quota resets with the round, the match total does not', () => {
  const h = makeMatch({ mode: 'solo', fake: true, seed: 7 });
  h.m.consoleEnabled = true;
  h.start();
  h.toPrep(1);
  const ps = h.ps('p_0');
  const bondId = BONDS[0];

  // untouched: 0/0 with the shared limits riding along
  let view = ps.privateView();
  assert.deepEqual(view.console, { roundUses: 0, totalUses: 0, roundLimit: CONSOLE_ROUND_LIMIT, totalLimit: CONSOLE_TOTAL_LIMIT });

  // a successful grant moves both counters in the private view
  assert.ok(h.m.consoleGrant(ps, 'bond', bondId, 1).ok, 'the grant lands');
  view = ps.privateView();
  assert.equal(view.console.roundUses, 1);
  assert.equal(view.console.totalUses, 1);

  // the per-round quota: CONSOLE_ROUND_LIMIT grants per round, then RATE
  while (ps.consoleRoundUses < CONSOLE_ROUND_LIMIT) assert.ok(h.m.consoleGrant(ps, 'bond', bondId, 1).ok);
  view = ps.privateView();
  assert.equal(view.console.roundUses, CONSOLE_ROUND_LIMIT);
  assert.equal(view.console.totalUses, CONSOLE_ROUND_LIMIT);
  assert.equal(h.m.consoleGrant(ps, 'bond', bondId, 1).error, ERR.RATE, 'the round quota holds');
  assert.equal(ps.privateView().console.roundUses, CONSOLE_ROUND_LIMIT, 'a refused grant moves nothing');

  // the next round: the per-round quota is back, the match total keeps counting
  h.toPrep(2);
  assert.equal(ps.consoleRoundUses, 0, 'startRound resets the per-round quota');
  view = ps.privateView();
  assert.equal(view.console.roundUses, 0);
  assert.equal(view.console.totalUses, CONSOLE_ROUND_LIMIT);
  assert.ok(h.m.consoleGrant(ps, 'bond', bondId, 1).ok, 'granting works again in the new round');
  assert.equal(ps.consoleTotalUses, CONSOLE_ROUND_LIMIT + 1);
  assert.equal(ps.privateView().console.totalUses, CONSOLE_ROUND_LIMIT + 1);
});

test('a disabled match never grants and its private view still reports the untouched quota', () => {
  const h = makeMatch({ mode: 'solo', fake: true, seed: 7 });
  h.start();
  h.toPrep(1);
  const ps = h.ps('p_0');
  assert.equal(h.m.consoleGrant(ps, 'bond', BONDS[0], 1).error, ERR.BAD_MSG, 'console is disabled for this match');
  assert.deepEqual(ps.privateView().console, { roundUses: 0, totalUses: 0, roundLimit: CONSOLE_ROUND_LIMIT, totalLimit: CONSOLE_TOTAL_LIMIT });
});
