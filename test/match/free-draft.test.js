// 自由选策略（维护者决定 2026-11-08，移植自用户分支 rel33; server/match/match/phases.js freeDraft）——
// the free strategy draft: every co-op match with two or more humans drafts at once under one BAND_TURN_SECONDS
// countdown — a tentative choice (g.bandHold) that can be switched or cancelled (g.bandCancel) until it is locked
// (g.bandLock, final); no duplicates between teammates (first come, first served) except in an expanded-capacity room;
// every seat locked ends the step early; the countdown fixes every hold and gives a doctor holding nothing its
// highlighted strategy, else the default. AI seats lock at once, with 「AI 队友最后选择」 once no human is left deciding.
// g.band (a page that predates the flow) holds and locks at once. Checkpoints keep holds and locks; a checkpoint of the
// turn-based draft goes on with turns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, PHASE } from '../../shared/constants.js';
import { DATA, makeMatch, checkInvariants } from './harness.js';
import { BAND_TURN_SECONDS } from '../../server/match/Match.js';
import { createRngFromState } from '../../server/sim/rng.js';
import { snapshotMatch, restoreMatch } from '../../server/match/snapshot.js';

const TURN_MS = BAND_TURN_SECONDS * 1000;
const OK = { ok: true };
const CAP8 = { revivalEnabled: false, disableSharedPool: false, playerCapacity: 8 };

/** A match driven to BAND_DRAFT (every human confirms the briefing). */
function toDraft(o) {
  const h = makeMatch({ mode: 'coop', seed: 3, ...o }).start();
  for (const ps of h.m.players.values()) if (!ps.isBot) h.m.handle(ps.playerId, { t: 'g.infoReady' });
  h.run(() => h.m.phase !== PHASE.INFO_CHECK);
  assert.equal(h.m.phase, PHASE.BAND_DRAFT);
  return h;
}
const bands = (h) => h.m.gd.bandIds();
const view = (h) => h.m.publicView().draft;

test('a co-op match with two or more humans drafts freely: one countdown, no turn, no skip; a single human keeps the turns', () => {
  const h = toDraft({ humans: 3 });
  const m = h.m, d = m.draft;
  assert.equal(d.free, true);
  assert.equal(d.concurrent, true);
  assert.deepEqual(d.holds, {});
  assert.equal(m.draftTurn(), null);
  const v = view(h);
  assert.equal(v.free, true);
  assert.equal(v.concurrent, true, 'a page without the flow renders it as everybody at once');
  assert.equal(v.turn, null);
  assert.deepEqual(v.holds, {});
  assert.equal(v.turnSeconds, BAND_TURN_SECONDS);
  assert.ok(m.deadline - m.sched.now() === TURN_MS, 'one countdown for the step');
  assert.equal(m.deadline, d.turnDeadline);
  for (const pid of d.order) assert.deepEqual(m.handle(pid, { t: 'g.bandSkip' }).error, ERR.WRONG_PHASE, 'no skip');
  assert.ok(m.publicView().players.filter((p) => p.playerId.startsWith('p_')).every((p) => p.status === 'deciding'));
  m.dispose();
  // a single human with AI teammates, and solo: today's turns (untimed)
  for (const o of [{ humans: 1, bots: 2 }, { mode: 'solo', humans: 1 }]) {
    const s = toDraft(o);
    assert.equal(s.m.draft.free, undefined);
    assert.equal(view(s).free, undefined);
    assert.equal(s.m.deadline, 0);
    assert.equal(s.m.handle('p_0', { t: 'g.bandHold', bandId: bands(s)[0] }).error, ERR.WRONG_PHASE);
    s.m.dispose();
  }
});

test('hold, switch, cancel, lock: a held strategy is 队友已选 for the others; the lock is final (strategy, LP); g.band locks at once', () => {
  const h = toDraft({ humans: 3, seed: 5 });
  const m = h.m, t0 = h.sched.now();
  const [A, B, C] = ['band_amiya', 'band_sarkazb', 'band_lisa'];
  assert.deepEqual(m.handle('p_0', { t: 'g.bandHold', bandId: A }), OK);
  assert.deepEqual(view(h).holds, { p_0: A });
  assert.equal(h.ps('p_0').bandId, null, 'a hold is not the strategy yet');
  assert.equal(m.handle('p_1', { t: 'g.bandHold', bandId: A }).error, ERR.BAD_TARGET, 'first come, first served');
  assert.equal(m.handle('p_1', { t: 'g.band', bandId: A }).error, ERR.BAD_TARGET, 'nor through g.band');
  assert.equal(m.handle('p_1', { t: 'g.bandHold', bandId: 'band_nope' }).error, ERR.BAD_TARGET);
  // switching frees the old one at once
  assert.deepEqual(m.handle('p_0', { t: 'g.bandHold', bandId: B }), OK);
  assert.deepEqual(m.handle('p_0', { t: 'g.bandHold', bandId: B }), OK, 'holding it again changes nothing');
  assert.deepEqual(m.handle('p_1', { t: 'g.bandHold', bandId: A }), OK);
  assert.deepEqual(view(h).holds, { p_0: B, p_1: A });
  assert.equal(m.draft.focus.get('p_0'), B, 'the hold is the highlighted strategy too');
  // cancel
  assert.deepEqual(m.handle('p_0', { t: 'g.bandCancel' }), OK);
  assert.deepEqual(m.handle('p_0', { t: 'g.bandCancel' }), OK, 'nothing held: no error');
  assert.deepEqual(view(h).holds, { p_1: A });
  assert.equal(m.handle('p_0', { t: 'g.bandLock' }).error, ERR.BAD_TARGET, 'nothing to lock');
  assert.deepEqual(m.handle('p_2', { t: 'g.bandHold', bandId: B }), OK, 'the cancelled one is free');
  // lock
  assert.deepEqual(m.handle('p_1', { t: 'g.bandLock' }), OK);
  assert.equal(m.draft.picks.p_1, A);
  assert.equal(h.ps('p_1').bandId, A);
  assert.equal(h.ps('p_1').lp, DATA.bands[A].totalHp);
  assert.deepEqual(view(h).picks, { p_1: A });
  assert.deepEqual(view(h).holds, { p_2: B }, 'a locked seat is no longer in holds');
  for (const msg of [{ t: 'g.bandHold', bandId: C }, { t: 'g.bandCancel' }, { t: 'g.bandLock' }, { t: 'g.band', bandId: C }, { t: 'g.bandFocus', bandId: C }]) {
    assert.equal(m.handle('p_1', msg).error, ERR.ALREADY, `${msg.t} after the lock`);
  }
  assert.equal(m.publicView().players.find((p) => p.playerId === 'p_1').status, 'ready');
  assert.equal(m.publicView().players.find((p) => p.playerId === 'p_2').status, 'deciding', 'a hold is still deciding');
  // g.band (an older page): hold + lock at once, its own earlier hold released
  assert.deepEqual(m.handle('p_0', { t: 'g.bandHold', bandId: C }), OK);
  assert.deepEqual(m.handle('p_0', { t: 'g.band', bandId: 'band_orchid' }), OK);
  assert.equal(m.draft.picks.p_0, 'band_orchid');
  assert.equal(m.draft.holds.p_0, undefined);
  assert.equal(m.phase, PHASE.BAND_DRAFT, 'p_2 has not locked');
  assert.deepEqual(m.handle('p_2', { t: 'g.bandLock' }), OK);
  h.sched.advance(1);
  assert.equal(m.phase, PHASE.BATTLE_CHECK, 'every seat locked: the step ends at once');
  assert.ok(h.sched.now() - t0 < 1000);
  checkInvariants(m);
  m.dispose();
});

test('the countdown fixes every hold; a human holding nothing gets the highlighted strategy, else the default; no duplicates; AI seats lock at once', () => {
  const h = toDraft({ humans: 3, bots: 1, seed: 9 });
  const m = h.m, t0 = h.sched.now();
  h.sched.advance(1);
  assert.ok(m.draft.picks.ai_0, 'the AI seat locked at once');
  const ai = m.draft.picks.ai_0;
  const free = bands(h).filter((b) => b !== ai && b !== 'band_bldsk');
  assert.deepEqual(m.handle('p_0', { t: 'g.bandHold', bandId: free[0] }), OK);
  assert.deepEqual(m.handle('p_1', { t: 'g.bandFocus', bandId: free[0] }), OK, 'highlighting a held strategy');
  assert.deepEqual(m.handle('p_2', { t: 'g.bandFocus', bandId: free[1] }), OK);
  h.run(() => m.phase !== PHASE.BAND_DRAFT, { maxTime: 3 * TURN_MS });
  assert.equal(m.phase, PHASE.BATTLE_CHECK);
  const took = h.sched.now() - t0;
  assert.ok(took >= TURN_MS - 5 && took <= TURN_MS + 50, `one countdown (${took} ms)`);
  assert.equal(h.ps('p_0').bandId, free[0], 'the hold is fixed');
  assert.equal(h.ps('p_2').bandId, free[1], 'the highlighted strategy');
  const want = ai === 'band_bldsk' ? bands(h).find((b) => ![ai, free[0], free[1]].includes(b)) : 'band_bldsk';
  assert.equal(h.ps('p_1').bandId, want, 'its highlight was held by a teammate: the default nobody holds');
  assert.equal(new Set([...m.players.values()].map((ps) => ps.bandId)).size, 4);
  for (const ps of m.players.values()) assert.equal(ps.lp, DATA.bands[ps.bandId].totalHp);
  m.dispose();
});

test('「AI 队友最后选择」: the AI seats lock once every human has locked, or at the countdown\'s end after the humans', () => {
  {
    const h = toDraft({ humans: 2, bots: 2, seed: 4, aiPicksLast: true });
    const m = h.m, t0 = h.sched.now();
    h.sched.advance(1);
    assert.deepEqual(Object.keys(m.draft.picks), [], 'no AI pick while a human decides');
    assert.deepEqual(m.handle('p_0', { t: 'g.bandHold', bandId: 'band_amiya' }), OK);
    assert.deepEqual(m.handle('p_0', { t: 'g.bandLock' }), OK);
    assert.deepEqual(m.handle('p_1', { t: 'g.bandHold', bandId: 'band_lisa' }), OK);
    h.sched.advance(1);
    assert.deepEqual(Object.keys(m.draft.picks), ['p_0'], 'a held, unlocked human still decides');
    assert.deepEqual(m.handle('p_1', { t: 'g.bandLock' }), OK);
    h.run(() => m.phase !== PHASE.BAND_DRAFT, { maxTime: 1000 });
    assert.equal(m.phase, PHASE.BATTLE_CHECK, 'the AI seats locked right after, the step ended early');
    assert.ok(h.sched.now() - t0 < 1000);
    assert.equal(new Set(Object.values(m.draft.picks)).size, 4);
    for (const id of ['ai_0', 'ai_1']) assert.ok(!['band_amiya', 'band_lisa'].includes(m.draft.picks[id]));
    m.dispose();
  }
  {
    const h = toDraft({ humans: 2, bots: 2, seed: 4, aiPicksLast: true });
    const m = h.m;
    assert.deepEqual(m.handle('p_0', { t: 'g.bandHold', bandId: 'band_amiya' }), OK);
    h.run(() => m.phase !== PHASE.BAND_DRAFT, { maxTime: 3 * TURN_MS });
    assert.equal(m.phase, PHASE.BATTLE_CHECK);
    assert.equal(h.ps('p_0').bandId, 'band_amiya');
    assert.equal(h.ps('p_1').bandId, 'band_bldsk', 'the default');
    assert.equal(new Set(Object.values(m.draft.picks)).size, 4, 'the AI seats picked after the humans, nothing repeated');
    m.dispose();
  }
});

test('an expanded-capacity room drafts freely too and allows repeats: the same strategy held and locked by two', () => {
  const h = toDraft({ humans: 2, bots: 2, seed: 6, experimental: CAP8 });
  const m = h.m;
  assert.equal(m.draft.free, true);
  assert.equal(view(h).allowRepeat, true);
  assert.deepEqual(m.handle('p_0', { t: 'g.bandHold', bandId: 'band_amiya' }), OK);
  assert.deepEqual(m.handle('p_1', { t: 'g.bandHold', bandId: 'band_amiya' }), OK, 'repeats allowed');
  assert.deepEqual(m.handle('p_0', { t: 'g.bandLock' }), OK);
  assert.deepEqual(m.handle('p_1', { t: 'g.bandLock' }), OK);
  h.run(() => m.phase !== PHASE.BAND_DRAFT, { maxTime: 1000 });
  assert.equal(m.phase, PHASE.BATTLE_CHECK);
  assert.equal(h.ps('p_0').bandId, 'band_amiya');
  assert.equal(h.ps('p_1').bandId, 'band_amiya');
  m.dispose();
  // a single human there keeps today's untimed concurrent draft (pick = final)
  const s = toDraft({ humans: 1, bots: 3, seed: 6, experimental: CAP8 });
  assert.equal(s.m.draft.concurrent, true);
  assert.equal(s.m.draft.free, undefined);
  assert.equal(s.m.deadline, 0);
  s.m.dispose();
});

test('a departing doctor keeps the strategy it held (else the default); AI 托管 locks the held one; neither stalls the step', () => {
  const h = toDraft({ humans: 3, seed: 7 });
  const m = h.m;
  assert.deepEqual(m.handle('p_0', { t: 'g.bandHold', bandId: 'band_amiya' }), OK);
  assert.deepEqual(m.handle('p_1', { t: 'g.bandHold', bandId: 'band_lisa' }), OK);
  m.onLeave('p_0');
  assert.equal(m.draft.picks.p_0, 'band_amiya', 'the departed seat keeps its hold');
  assert.equal(m.draft.holds.p_0, undefined);
  assert.deepEqual(m.handle('p_1', { t: 'g.autoplay', on: true }), OK);
  h.sched.advance(1);
  assert.equal(m.draft.picks.p_1, 'band_lisa', 'AI 托管 locks what the doctor held');
  assert.deepEqual(m.handle('p_2', { t: 'g.bandHold', bandId: 'band_orchid' }), OK);
  assert.deepEqual(m.handle('p_2', { t: 'g.bandLock' }), OK);
  h.sched.advance(1);
  assert.equal(m.phase, PHASE.BATTLE_CHECK);
  m.dispose();
  // holding nothing: the default; an offline doctor (no AI 托管 yet) waits for the countdown
  const g = toDraft({ humans: 3, seed: 7 });
  g.m.onLeave('p_0');
  assert.equal(g.m.draft.picks.p_0, 'band_bldsk');
  g.m.onDisconnect('p_1');
  assert.deepEqual(g.m.handle('p_2', { t: 'g.bandHold', bandId: 'band_amiya' }), OK);
  assert.deepEqual(g.m.handle('p_2', { t: 'g.bandLock' }), OK);
  g.sched.advance(1);
  assert.equal(g.m.phase, PHASE.BAND_DRAFT, 'the offline doctor is still deciding');
  g.run(() => g.m.phase !== PHASE.BAND_DRAFT, { maxTime: 3 * TURN_MS });
  assert.equal(g.m.phase, PHASE.BATTLE_CHECK, 'the countdown fixes it');
  assert.ok(g.m.draft.picks.p_1 && !['band_bldsk', 'band_amiya'].includes(g.m.draft.picks.p_1));
  g.m.dispose();
});

/** A fresh match built from a checkpoint (the platform's restore path); the seats come from the checkpoint's players. */
function restored(doc, o = {}) {
  const json = JSON.parse(JSON.stringify(doc));
  const seats = json.players.map((p) => ({ seat: p.seat, playerId: p.playerId, name: p.name, isBot: p.isBot, connected: p.connected }));
  const r = makeMatch({ mode: 'coop', seats, seed: json.seed, ...o });
  assert.equal(restoreMatch(r.m, json, { createRngFromState, log: { warn: () => {} } }), true);
  return r;
}

test('a checkpoint mid-way keeps the holds and the locks, starts the countdown over and plays on', () => {
  const h = toDraft({ humans: 3, bots: 1, seed: 11 });
  const m = h.m;
  h.sched.advance(1);
  assert.deepEqual(m.handle('p_0', { t: 'g.bandHold', bandId: 'band_amiya' }), OK);
  assert.deepEqual(m.handle('p_1', { t: 'g.bandHold', bandId: 'band_lisa' }), OK);
  assert.deepEqual(m.handle('p_1', { t: 'g.bandLock' }), OK);
  h.sched.advance(20_000);
  const doc = snapshotMatch(m);
  assert.ok(doc);
  const r = restored(doc);
  const d = r.m.draft;
  assert.equal(d.free, true);
  assert.deepEqual(d.holds, { p_0: 'band_amiya' });
  assert.deepEqual(d.picks, m.draft.picks);
  assert.equal(r.m.deadline - r.m.sched.now(), TURN_MS, 'a full countdown again');
  assert.equal(r.m.handle('p_2', { t: 'g.bandHold', bandId: 'band_amiya' }).error, ERR.BAD_TARGET, 'the restored hold is taken');
  assert.deepEqual(r.m.handle('p_0', { t: 'g.bandLock' }), OK);
  assert.deepEqual(r.m.handle('p_2', { t: 'g.bandHold', bandId: 'band_orchid' }), OK);
  assert.deepEqual(r.m.handle('p_2', { t: 'g.bandLock' }), OK);
  r.run(() => r.m.phase !== PHASE.BAND_DRAFT, { maxTime: 1000 });
  assert.equal(r.m.phase, PHASE.BATTLE_CHECK);
  assert.equal(r.ps('p_0').bandId, 'band_amiya');
  m.dispose(); r.m.dispose();
});

test('a checkpoint of the turn-based draft (before the free draft) restores and finishes with its turns', () => {
  // the rel32 shape: no `free`, no `concurrent`, a turn order with skips
  const h = makeMatch({ mode: 'coop', humans: 3, seed: 12 });
  h.m.freeDraft = () => false;
  h.start();
  for (const ps of h.m.players.values()) h.m.handle(ps.playerId, { t: 'g.infoReady' });
  h.run(() => h.m.phase !== PHASE.INFO_CHECK);
  const m = h.m;
  assert.equal(m.draft.free, undefined);
  assert.equal(m.draft.concurrent, undefined);
  const first = m.draftTurn();
  assert.deepEqual(m.handle(first, { t: 'g.band', bandId: 'band_amiya' }), OK);
  const doc = snapshotMatch(m);
  const r = restored(doc);
  assert.equal(r.m.draft.free, undefined, 'it goes on as it was taken');
  assert.equal(r.m.publicView().draft.free, undefined);
  const turn = r.m.draftTurn();
  assert.ok(turn && turn !== first, 'the next turn');
  assert.equal(r.m.handle(turn, { t: 'g.bandHold', bandId: 'band_lisa' }).error, ERR.WRONG_PHASE, 'no holds there');
  r.run(() => r.m.phase !== PHASE.BAND_DRAFT, { maxTime: 3 * TURN_MS });
  assert.equal(r.m.phase, PHASE.BATTLE_CHECK, 'the turns that run out finish it');
  assert.equal(r.ps(first).bandId, 'band_amiya');
  assert.equal(new Set([...r.m.players.values()].map((ps) => ps.bandId)).size, 3);
  m.dispose(); r.m.dispose();
});

test('a page that predates the flow: m.public reads as a concurrent draft whose picks are the locks; its g.band locks', () => {
  const h = toDraft({ humans: 2, seed: 13 });
  const m = h.m;
  assert.deepEqual(m.handle('p_1', { t: 'g.bandHold', bandId: 'band_amiya' }), OK);
  const v = view(h);
  // what today's client reads (public/js/ui/gameLogic/draft.js normalizeDraft before the flow): concurrent, no turn, picks
  assert.equal(v.concurrent, true);
  assert.equal(v.turn, null);
  assert.deepEqual(v.picks, {});
  assert.deepEqual(m.handle('p_0', { t: 'g.band', bandId: 'band_lisa' }), OK, 'its 确认选择');
  assert.deepEqual(view(h).picks, { p_0: 'band_lisa' });
  assert.equal(m.handle('p_0', { t: 'g.band', bandId: 'band_orchid' }).error, ERR.ALREADY);
  m.dispose();
});
