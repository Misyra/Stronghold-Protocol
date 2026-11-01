// 伤害/治疗结算板 (fork feature, server/match/damageBoard.js): the match-lifecycle ledger of every finished field's
// result — cumulative damage AND healing across fields / rounds / phases, exposed as m.public.damage (views.js) so
// every viewer (reconnect, spectator seat included) reads the same authoritative numbers. The ledger is pure
// additional metadata: no sim / settlement path reads it, so no battle result moves (golden stays).
//
// Data sources per combat mode (the point of the design): BOTH deliver the same perPlayer shape with a final result —
//   server-run fields: Battle._buildResult (bots / takeovers / SP_COMBAT=server);
//   client-run fields: the authority's validated b.result (implausible ones are replaced by the server's simulation
//   before they are ever recorded).
// FakeBattle stands in for both sides here: its result carries damageDealt 1000 / unitStats (dmg 100 per chess unit)
// per player, and the SimClient tamper knob adds the healing a browser result would carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { DamageBoard } from '../../server/match/damageBoard.js';
import { makeMatch, give, chessOfTier, legalTileFor } from './harness.js';

const boardOf = (h) => {
  h.m.flush(true);
  const pub = h.lastBc('m.public');
  return pub && pub.damage ? pub.damage : null;
};

const rowOf = (board, playerId) => board && board.players.find((p) => p.playerId === playerId) || null;

// ---- the ledger itself -------------------------------------------------------------------------------------------------

test('ledger: fields accumulate per player (damage and healing), one row per operator across fields, summons by defId', () => {
  const b = new DamageBoard();
  assert.equal(b.empty, true);
  assert.equal(b.view().players.length, 0);
  b.record(1, {
    perPlayer: {
      p_0: { damageDealt: 1000, healingDone: 0, unitStats: [
        { uid: 7, defId: 'chess_a', name: '阿米娅', kind: 'op', dmg: 100, heal: 0 },
        { uid: null, defId: 'token_medic', name: '医疗探机', kind: 'token', dmg: 0, heal: 30 },
      ] },
      p_1: { damageDealt: 400, healingDone: 50, unitStats: [] },
    },
  });
  assert.equal(b.empty, false);
  assert.equal(b.round, 1);
  b.record(2, {
    perPlayer: {
      p_0: { damageDealt: 500, healingDone: 120, unitStats: [
        { uid: 7, defId: 'chess_a', name: '阿米娅', kind: 'op', dmg: 60, heal: 10 },
        { uid: null, defId: 'token_medic', name: '医疗探机', kind: 'token', dmg: 0, heal: 12 },
        { uid: null, defId: 'token_medic', name: '医疗探机', kind: 'token', dmg: 5, heal: 0 },
      ] },
    },
  });
  const view = b.view();
  assert.equal(view.round, 2);
  assert.deepEqual(view.players.map((p) => p.playerId), ['p_0', 'p_1'], 'first-seen (seat) order preserved');
  const p0 = view.players[0];
  assert.equal(p0.damage, 1500);
  assert.equal(p0.healing, 120);
  // the board operator merged across fields by uid; the two summons (no uid) merged by defId
  assert.deepEqual(p0.operators.map((o) => [o.key, o.damage, o.healing]), [['u:7', 160, 10], ['d:token_medic', 5, 42]]);
  assert.equal(p0.operators[0].name, '阿米娅');
  const p1 = view.players[1];
  assert.equal(p1.damage, 400);
  assert.equal(p1.healing, 50);
  assert.equal(p1.operators.length, 0);
});

test('ledger: bad shapes and garbage numbers are ignored, never fabricated and never thrown', () => {
  const b = new DamageBoard();
  assert.doesNotThrow(() => { b.record(1, null); b.record(1, {}); b.record('x', { perPlayer: null }); });
  b.record(1, { perPlayer: { p_0: null, p_1: { damageDealt: 'lots', healingDone: -5, unitStats: [null, {}, { uid: 'x', defId: 3, dmg: Infinity, heal: NaN }] } } });
  const view = b.view();
  assert.deepEqual(view.players.map((p) => [p.playerId, p.damage, p.healing]), [['p_1', 0, 0]], 'no row for a null perPlayer, no number from garbage');
  assert.deepEqual(view.players[0].operators, []);
  // the board stays off m.public entirely before the first real result (views.js `empty`)
  assert.equal(b.empty, false);
  assert.equal(new DamageBoard().empty, true);
});

// ---- the match wiring: server-run fields -------------------------------------------------------------------------------

test('server mode: every field result folds in, cumulative across rounds; fields clearing at settle keeps the board; a new match starts empty', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 9301, fake: true });
  h.autoHumans();
  const m = h.m;
  m.start();
  m.flush(true);
  assert.equal(boardOf(h), null, 'no board before the first battle (m.public unchanged)');
  h.toPrep(1);
  m.handle('p_0', { t: 'g.ready', ready: true });
  m.handle('p_1', { t: 'g.ready', ready: true });
  h.run(() => [PHASE.SETTLE, PHASE.UNITE].includes(m.phase));
  let board = boardOf(h);
  assert.ok(board, 'm.public.damage after the first round');
  assert.equal(board.round, 1);
  // FakeBattle: damageDealt 1000 per player per field; the bot field ran on the server at combat start
  for (const pid of ['p_0', 'p_1', 'ai_0']) {
    const row = rowOf(board, pid);
    assert.ok(row && row.damage >= 1000 && row.healing === 0, `${pid} recorded from its field result`);
  }
  const first = board.players.map((p) => p.damage);
  // settle() cleared this.fields — the board is a ledger of its own, not the round's field list
  assert.equal(m.fields.length, 0);
  h.toPrep(2);
  m.handle('p_0', { t: 'g.ready', ready: true });
  m.handle('p_1', { t: 'g.ready', ready: true });
  h.run(() => [PHASE.SETTLE, PHASE.UNITE].includes(m.phase) && m.round === 2);
  board = boardOf(h);
  assert.equal(board.round, 2);
  assert.deepEqual(board.players.map((p) => p.playerId), ['p_0', 'p_1', 'ai_0']);
  assert.ok(board.players[0].damage > first[0], 'round 2 folded into the same rows (cumulative, not replaced)');
  assert.ok(board.players.every((p) => p.damage >= 2 * first[0]), 'every surviving seat accumulated both rounds');
  m.dispose();
  // 下一局重置: the ledger lives on the Match instance — the next match of the room starts from zero
  const h2 = makeMatch({ mode: 'coop', humans: 2, seed: 9302, fake: true });
  h2.m.start();
  h2.m.flush(true);
  assert.equal(boardOf(h2), null);
  h2.m.dispose();
});

// ---- the match wiring: client-run fields -------------------------------------------------------------------------------

test('client mode: the authority\'s validated b.result feeds the board (healing included); the server-run bot field does too', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 9303, fake: true, clientCombat: true,
    perPlayer: {
      // like a browser's own 作战统计: the result the authority reports carries per-unit healing — every board
      // operator's row reports 250 (the totals stay independent of the rows)
      p_0: { tamper: (r) => { r.perPlayer.p_0.healingDone = 500; for (const u of r.perPlayer.p_0.unitStats || []) u.heal = 250; return r; } },
    } });
  h.autoHumans();
  const m = h.m;
  m.start();
  h.toPrep(1);
  // a known board operator, so the authority's unitStats (FakeBattle: one row per input chess) is non-empty
  give(m, m.players.get('p_0'), chessOfTier(3)[0], 'board', legalTileFor(m, m.players.get('p_0'), chessOfTier(3)[0]));
  m.handle('p_0', { t: 'g.ready', ready: true });
  m.handle('p_1', { t: 'g.ready', ready: true });
  let source = null;
  h.run(() => {
    const f = m.fields.find((x) => x.players.includes('p_0'));
    if (f && f.resultSource) source = f.resultSource;
    return [PHASE.SETTLE, PHASE.UNITE].includes(m.phase);
  });
  const board = boardOf(h);
  assert.ok(board, 'm.public.damage after the first client-run round');
  assert.equal(source, 'client', 'the recorded result is the authority\'s own report');
  const p0 = rowOf(board, 'p_0');
  assert.equal(p0.healing, 500, 'healing counted from the client report');
  assert.equal(p0.damage, 1000);
  assert.ok(p0.operators.length >= 1, 'the board operator\'s row reached the board');
  assert.ok(p0.operators.every((o) => o.healing === 250 && o.damage === 100), 'per-operator healing from unitStats');
  const p1 = rowOf(board, 'p_1');
  assert.equal(p1.damage, 1000);
  assert.equal(p1.healing, 0, 'an untampered authority heals 0 (no fabrication)');
  const bot = rowOf(board, 'ai_0');
  assert.ok(bot && bot.damage >= 1000, 'the server-run bot field fed the same board');
  m.dispose();
});

// ---- the views: reconnect and spectator seats --------------------------------------------------------------------------

test('a reconnecting player and a spectator seat both receive the current board (resync publicView)', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 9304, fake: true, spectators: ['spec_0'] });
  h.autoHumans();
  const m = h.m;
  m.start();
  h.toPrep(1);
  m.handle('p_0', { t: 'g.ready', ready: true });
  m.handle('p_1', { t: 'g.ready', ready: true });
  h.run(() => [PHASE.SETTLE, PHASE.UNITE].includes(m.phase));
  assert.ok(boardOf(h), 'the broadcast board exists');
  // reconnect: the full resync (publicView) carries the board
  m.onDisconnect('p_1');
  m.onReconnect('p_1');
  const resync = h.lastTo('p_1', 'm.public');
  assert.ok(resync && resync.damage, 'the reconnect resync carries m.public.damage');
  assert.ok(resync.damage.players.length >= 3);
  // a spectator seat that joined mid-match is resynced the same way
  m.addSpectator('spec_1');
  const spec = h.lastTo('spec_1', 'm.public');
  assert.ok(spec && spec.damage, 'the spectator resync carries m.public.damage');
  // spectator seats get every broadcast: the last m.public they received holds the same board
  const seen = h.sent.filter(([pid, msg]) => pid === 'spec_0' && msg.t === 'm.public');
  assert.equal(seen.length, 0, 'broadcasts reach the seat through broadcast(), not unicast');
  assert.ok(h.lastBc('m.public').damage, 'the shared broadcast frame holds the board for every viewer alike');
  m.dispose();
});

// ---- the boss path -----------------------------------------------------------------------------------------------------

test('最终攻势: the boss fields fold in too (the fight happens in a boss round, outside settle())', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 2, seed: 9305, fake: true,
    script: (b) => (['boss', 'hidden'].includes(b.kind) ? { bossDps: 1e9 } : {}) });
  h.autoHumans();
  const m = h.m;
  m.start();
  h.drive(() => m.phase === PHASE.PREP && m.round === 14);
  for (const p of m.order) { p.bondCountBonus.yanShip = 3; p.layers.yanShip = 400; p.recompute(); }
  h.drive(() => m.phase === PHASE.FINAL_ASSAULT);
  h.drive(() => h.ended != null || m.phase === PHASE.HIDDEN_CORE, { maxSteps: 3e6 });
  const board = boardOf(h);
  assert.ok(board, 'the Final Assault\'s board');
  assert.equal(board.round, 14);
  // a boss field's FakeBattle reports damageDealt for both players of the pair
  assert.ok(board.players.length >= 2, 'both seats recorded');
  assert.ok(board.players.every((p) => p.damage > 0), 'boss damage counted');
  m.dispose();
});
