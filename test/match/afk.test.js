// 挂机移出 (the AFK rule, 移植自用户分支; server/match/Match.js afkRemoveRounds): a human seat of a match that started
// with ≥ 2 humans and sends no accepted substantive intent (common.js AFK_ACTIONS) for that many rounds in a row is
// removed as the prep that completes them ends — before the round's battle — exactly like a g.leave: m.removed to it,
// m.notice afkRemoved to everyone else in the match, then onLeave (copies back to the pool, status 'left', no battle,
// no boss-pool share).
// 本仓的互斥口径: 掉线由 AI 接管 (OFFLINE_TAKEOVER_ROUNDS, 移植自用户分支) marks the seat botControlled at the same prep
// end, and the AFK rule exempts a botControlled seat — the takeover therefore wins an offline seat at equal limits,
// and the AFK rule only removes it when its own limit is below the takeover's (or when it went idle before dropping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE, ERR, EMOTES } from '../../shared/constants.js';
import { Match, AFK_REMOVE_ROUNDS } from '../../server/match/Match.js';
import { AFK_ACTIONS, OFFLINE_TAKEOVER_ROUNDS } from '../../server/match/match/common.js';
import { VirtualScheduler } from '../../server/match/scheduler.js';
import { C2S } from '../../shared/protocol.js';
import { LOBBY_DEFAULTS } from '../../server/lobby.js';
import { bossPoolHp } from '../../server/match/finalAssault.js';
import { DATA, makeMatch, checkInvariants } from './harness.js';

/**
 * Drive the humans until `pred` holds. A human `acts(ps)` confirms, picks in both drafts, toggles the shop freeze (a
 * substantive intent) once per prep and readies; any other one only sends what never counts — g.infoReady, g.bandFocus,
 * g.emote, g.unitStats, g.watch, g.ready — so its draft turns and preps run out on their timers. Seats the AI plays
 * (AI 托管) are left to the bot, disconnected ones send nothing.
 */
function drive(h, pred, acts = () => false, { maxSteps = 3e6 } = {}) {
  const m = h.m, done = new Set();
  for (let i = 0; i < maxSteps; i++) {
    if (pred() || h.ended) return pred();
    for (const ps of m.players.values()) {
      if (ps.isBot || ps.left || ps.botControlled || !ps.connected) continue;
      const id = ps.playerId, active = acts(ps), key = `${m.phase}:${m.round}:${id}`;
      if (m.phase === PHASE.INFO_CHECK && !ps.infoReady) m.handle(id, { t: 'g.infoReady' });
      if (m.phase === PHASE.BAND_DRAFT && m.draftTurn() === id && !done.has(key)) {
        done.add(key);
        const band = m.gd.bandIds().find((b) => m.gd.bandAllowed(b) && !m.bandTaken(b, id));
        assert.deepEqual(m.handle(id, { t: active ? 'g.band' : 'g.bandFocus', bandId: band }), { ok: true });
      }
      if (m.phase === PHASE.SP_DRAFT && m.spTurn() === id && active) {
        const idx = m.sp.cards.find((c) => m.spCardAvailable(c))?.idx;
        if (idx != null) m.handle(id, { t: 'g.choice', idx });
      }
      if (m.phase === PHASE.PREP && ps.alive && !ps.ready) {
        if (!done.has(key)) {
          done.add(key);
          if (active) assert.deepEqual(m.handle(id, { t: 'g.freeze' }), { ok: true });
          else {
            m.handle(id, { t: 'g.emote', id: EMOTES[0] });
            m.handle(id, { t: 'g.unitStats', seq: 1 });
            m.handle(id, { t: 'g.watch', fieldId: `n:${id}` });
          }
        }
        if (active && ps.personalChoice) m.handle(id, { t: 'g.choice', idx: 0, choiceId: ps.personalChoice.id });
        if (!ps.tempEmpty) ps.resolveTemp(); // what the deadline does, not an intent
        m.handle(id, { t: 'g.ready', ready: true });
      }
    }
    if (pred()) return true;
    if (!h.sched.runNext()) return pred();
  }
  return pred();
}
const reach = (h, phase, round, acts) => {
  assert.ok(drive(h, () => h.m.phase === phase && h.m.round === round, acts), `expected ${phase} R${round}, got ${h.m.phase} R${h.m.round}${h.ended ? ' (ended)' : ''}`);
};
/** Record the match state at every m.removed / m.notice frame. */
const watchRemovals = (h) => {
  const seen = [];
  h.onSend.push((id, msg) => {
    if (msg.t === 'm.removed' || msg.t === 'm.notice') seen.push({ id, msg, phase: h.m.phase, round: h.m.round, fields: h.m.fields.length });
  });
  return seen;
};

test('the substantive intents are exactly the ones named by the rule, all of them real C2S intents', () => {
  assert.equal(AFK_REMOVE_ROUNDS, 2);
  assert.equal(LOBBY_DEFAULTS.afkRemoveRounds, AFK_REMOVE_ROUNDS, 'real rooms get the default');
  assert.deepEqual([...AFK_ACTIONS].sort(), ['g.band', 'g.bandCancel', 'g.bandHold', 'g.bandLock', 'g.bandSkip', 'g.buy', 'g.choice', 'g.destroy', 'g.equip', 'g.freeze', 'g.levelUp',
    'g.move', 'g.refresh', 'g.reward', 'g.sell', 'g.unequip']);
  for (const t of AFK_ACTIONS) assert.ok(Object.hasOwn(C2S, t), t);
  for (const t of ['g.ready', 'g.emote', 'g.watch', 'g.unitStats', 'g.pause', 'g.infoReady', 'g.art', 'g.bandFocus', 'g.autoplay',
    'g.rerollVote', 'g.bondPlan', 'g.leave', 'b.progress', 'b.result']) assert.ok(!AFK_ACTIONS.has(t), t);
  // the Match option: default 2, 0 turns the rule off, anything else keeps the default
  const base = { mode: 'coop', difficulty: 'NORMAL', seats: [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true }], data: DATA,
    scheduler: new VirtualScheduler(), send: () => true, broadcast: () => {}, onEnd: () => {} };
  for (const [value, want] of [[undefined, 2], [0, 0], [1, 1], [3, 3], [-1, 2], [1.5, 2], ['2', 2]]) {
    const m = new Match({ ...base, afkRemoveRounds: value });
    assert.equal(m.afkRemoveRounds, want, String(value));
    m.dispose();
  }
});

test('idle for two rounds: removed as the second prep ends, before its battle — m.removed to it, m.notice to the rest', () => {
  const h = makeMatch({ mode: 'coop', humans: 3, spectators: ['s_0'], seed: 41, fake: true, afkRemoveRounds: 2 }).start();
  const m = h.m, idle = h.ps('p_2'), acts = (ps) => ps.playerId !== 'p_2';
  const seen = watchRemovals(h);
  reach(h, PHASE.COMBAT, 1, acts);
  assert.equal(idle.afkRounds, 1, 'confirming, the highlighted strategy, emotes, stats, watching and Ready do not count');
  assert.deepEqual([h.ps('p_0').afkRounds, h.ps('p_1').afkRounds], [0, 0]);
  assert.ok(!idle.left && m.fields.some((f) => f.fieldId === 'n:p_2'), 'one idle round: the seat still fights');
  reach(h, PHASE.PREP, 2, acts);
  assert.equal(seen.length, 0);
  reach(h, PHASE.COMBAT, 2, acts);
  const removed = seen.filter((s) => s.msg.t === 'm.removed');
  assert.deepEqual(removed.map((s) => [s.id, s.msg]), [['p_2', { t: 'm.removed', reason: 'afk', rounds: 2 }]]);
  assert.deepEqual([removed[0].phase, removed[0].round, removed[0].fields], [PHASE.PREP, 2, 0], 'removed while the prep ends, before any battle exists');
  const notices = seen.filter((s) => s.msg.t === 'm.notice');
  assert.deepEqual(notices.map((s) => s.id).sort(), ['p_0', 'p_1', 's_0'], 'everyone else in the match, the spectator seat included');
  for (const s of notices) assert.deepEqual(s.msg, { t: 'm.notice', kind: 'afkRemoved', playerId: 'p_2', name: 'P2', rounds: 2 });
  // like a quitter: out of the match, status left, no battle, intents refused
  assert.ok(idle.left && !idle.alive);
  assert.equal(idle.eliminatedRound, 2);
  assert.equal(m.publicView().players.find((p) => p.playerId === 'p_2').status, 'left');
  assert.deepEqual(m.fields.map((f) => f.fieldId).sort(), ['n:p_0', 'n:p_1']);
  assert.deepEqual(m.handle('p_2', { t: 'g.ready', ready: true }), { error: ERR.NOT_IN_ROOM });
  assert.ok(h.bc.some((x) => x.t === 'm.ticker' && x.text.includes('P2')), 'the quit ticker line');
  assert.equal(h.ended, null, 'the others play on');
  checkInvariants(m);
  reach(h, PHASE.PREP, 4, acts);
  assert.equal(seen.filter((s) => s.msg.t === 'm.removed').length, 1, 'removed once');
  m.dispose();
});

test('an accepted substantive intent resets the count; refused ones do not', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 42, fake: true, afkRemoveRounds: 2 }).start();
  const m = h.m, p1 = h.ps('p_1');
  const seen = watchRemovals(h);
  // p_1 acts only in the prep of round 2
  const acts = (ps) => ps.playerId === 'p_0' || (m.round === 2 && m.phase === PHASE.PREP);
  reach(h, PHASE.COMBAT, 1, acts);
  assert.equal(p1.afkRounds, 1);
  reach(h, PHASE.COMBAT, 2, acts);
  assert.equal(p1.afkRounds, 0, 'the shop freeze of round 2 reset it');
  reach(h, PHASE.PREP, 3, acts);
  assert.ok(m.handle('p_1', { t: 'g.sell', uid: 987654 }).error, 'an unknown piece is refused');
  assert.equal(m.handle('p_1', { t: 'g.band', bandId: 'band_bldsk' }).error, ERR.WRONG_PHASE);
  reach(h, PHASE.COMBAT, 3, acts);
  assert.equal(p1.afkRounds, 1, 'refused intents do not count');
  assert.ok(!p1.left);
  reach(h, PHASE.COMBAT, 4, acts);
  assert.ok(p1.left, 'the second idle round in a row');
  assert.deepEqual(seen.filter((s) => s.msg.t === 'm.removed').map((s) => [s.id, s.phase, s.round]), [['p_1', PHASE.PREP, 4]]);
  assert.deepEqual(seen.filter((s) => s.msg.t === 'm.notice').map((s) => s.id), ['p_0'], 'never to the bot');
  assert.equal(h.ps('ai_0').afkRounds, 0, 'AI seats are never counted');
  assert.ok(!h.ps('ai_0').left);
  m.dispose();
});

test('a seat under AI 托管 is never idle; the offline takeover outranks the rule at equal limits', () => {
  assert.equal(OFFLINE_TAKEOVER_ROUNDS, AFK_REMOVE_ROUNDS, 'the two remake rules meet at the same count');
  // a seat under AI 托管 (its own choice or the offline takeover) resets the count
  const h = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 43, fake: true, afkRemoveRounds: 2 }).start();
  const m = h.m, p0 = h.ps('p_0'), p1 = h.ps('p_1');
  // p_0 drops at once and plays the whole match under AI 托管
  m.onDisconnect('p_0');
  assert.deepEqual(m.handle('p_0', { t: 'g.autoplay', on: true }), { ok: true });
  reach(h, PHASE.PREP, 2);
  assert.equal(p1.afkRounds, 1);
  // AI 托管 at the check resets the count (g.autoplay itself is not a substantive intent)
  assert.deepEqual(m.handle('p_1', { t: 'g.autoplay', on: true }), { ok: true });
  reach(h, PHASE.PREP, 3);
  assert.equal(p1.afkRounds, 0);
  assert.deepEqual(m.handle('p_1', { t: 'g.autoplay', on: false }), { ok: true });
  m.onDisconnect('p_1');
  // one idle offline round is warned; the second is the 掉线由 AI 接管's, and a botControlled seat is exempt
  reach(h, PHASE.PREP, 4);
  assert.equal(p1.afkRounds, 1);
  reach(h, PHASE.PREP, 5);
  assert.ok(p1.offlineAutoplay && p1.autoplay, 'the AI plays the offline seat');
  assert.equal(p1.afkRounds, 0, 'a botControlled seat is never idle');
  assert.ok(!p0.left && p0.afkRounds === 0, 'the AI 托管 seat never counts');
  assert.equal(h.ended, null);
  m.dispose();
  // one idle round before the takeover is enough: the AFK rule removes the seat while it is still offline
  const h2 = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 43, fake: true, afkRemoveRounds: 1 }).start();
  const m2 = h2.m, off = h2.ps('p_1');
  m2.onDisconnect('p_1');
  reach(h2, PHASE.COMBAT, 1, (ps) => ps.playerId === 'p_0');
  assert.ok(off.left && !off.autoplay, 'removed before the takeover could take it');
  assert.deepEqual(h2.lastTo('p_1', 'm.removed'), { t: 'm.removed', reason: 'afk', rounds: 1 });
  m2.dispose();
});

test('solo, a lone human with AI teammates and afkRemoveRounds 0 never remove anyone', () => {
  for (const o of [{ mode: 'solo', humans: 1 }, { mode: 'coop', humans: 1, bots: 2 }, { mode: 'coop', humans: 2, afkRemoveRounds: 0 }]) {
    const h = makeMatch({ seed: 44, fake: true, afkRemoveRounds: 2, ...o }).start();
    // untimed phases wait for the lone human's picks; in its preps it only readies
    const acts = (ps) => h.m.soloUntimed && (h.m.phase !== PHASE.PREP || !!ps.personalChoice);
    reach(h, PHASE.PREP, 4, acts);
    for (const ps of h.m.players.values()) {
      assert.ok(!ps.left, `${o.mode} ${ps.playerId}`);
      assert.equal(ps.afkRounds, 0, 'not even counted');
    }
    assert.ok(!h.sent.some(([, x]) => x.t === 'm.removed' || x.t === 'm.notice'));
    h.m.dispose();
  }
});

test('every human idle: each is removed like a quitter, the last one ends the match as abandoned before the battle', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 45, fake: true, afkRemoveRounds: 2 }).start();
  const seen = watchRemovals(h);
  const ended = drive(h, () => h.ended != null);
  assert.ok(ended);
  assert.equal(h.ended.reason, 'abandoned');
  assert.equal(h.endedCount, 1);
  assert.equal(h.m.round, 2);
  assert.ok(!h.m.fields.length, 'no round-2 battle was built');
  assert.deepEqual(seen.map((s) => [s.msg.t, s.id]), [['m.removed', 'p_0'], ['m.notice', 'p_1'], ['m.removed', 'p_1']]);
  h.m.dispose();
});

test('a seat removed in the boss round prep has no place in the Final Assault pairing or the boss pool', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'FUNNY', humans: 3, seed: 5, fake: true, afkRemoveRounds: 2,
    script: (b) => (b.kind === 'boss' ? { bossDps: 1e9 } : {}) }).start();
  const m = h.m;
  h.autoHumans();
  h.drive(() => m.phase === PHASE.PREP && m.round === 12);
  // from round 12 on p_2 plays itself: one shop freeze, then nothing; p_0 / p_1 stay under AI 托管
  assert.deepEqual(m.handle('p_2', { t: 'g.autoplay', on: false }), { ok: true });
  assert.deepEqual(m.handle('p_2', { t: 'g.freeze' }), { ok: true });
  const seen = watchRemovals(h);
  reach(h, PHASE.PREP, 14);
  assert.equal(h.ps('p_2').afkRounds, 1);
  assert.equal(m.bossWaves.length, 2, 'three players: a pair and a lone half');
  reach(h, PHASE.FINAL_ASSAULT, 14);
  assert.deepEqual(seen.filter((s) => s.msg.t === 'm.removed').map((s) => [s.id, s.phase, s.round]), [['p_2', PHASE.PREP, 14]]);
  assert.deepEqual(m.fields.map((f) => f.players), [['p_0', 'p_1']], 'one boss field for the two players left');
  assert.equal(m.bossPool.maxHp, bossPoolHp(m.gd, m.bossId, 2), 'the boss pool of the two players left');
  assert.equal(h.ps('p_2').eliminatedRound, 14);
  const end = h.runToEnd();
  assert.equal(end.victory, true);
  assert.equal(end.players.find((p) => p.playerId === 'p_2').roundsPassed, 13);
  m.dispose();
});

test('one idle round short of the limit: a warn toast now, m.private afkWarn through the next prep, cleared by any real move', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 43, fake: true, afkRemoveRounds: 2 }).start();
  const m = h.m, idle = h.ps('p_1');
  const toasts = [];
  h.onSend.push((id, msg) => { if (msg.t === 'm.toast' && id === 'p_1') toasts.push(msg); });
  reach(h, PHASE.COMBAT, 1, (ps) => ps.playerId !== 'p_1');
  assert.equal(idle.afkRounds, 1);
  assert.equal(toasts.length, 1, 'warned once, as the idle prep ends');
  assert.equal(toasts[0].kind, 'warn');
  assert.equal(h.ps('p_0').privateView().afkWarn, undefined, 'the active seat is never flagged');
  reach(h, PHASE.PREP, 2, (ps) => ps.playerId !== 'p_1');
  assert.equal(idle.privateView().afkWarn, true, 'the next prep shows the warning');
  assert.deepEqual(m.handle('p_1', { t: 'g.freeze' }), { ok: true });
  assert.equal(idle.privateView().afkWarn, undefined, 'a substantive intent clears it at once');
  m.dispose();
});

test('no warning when the rule is off or only one idle round removes', () => {
  for (const afkRemoveRounds of [0, 1]) {
    const h = makeMatch({ mode: 'coop', humans: 2, seed: 44, fake: true, afkRemoveRounds }).start();
    const toasts = [];
    h.onSend.push((id, msg) => { if (msg.t === 'm.toast' && id === 'p_1') toasts.push(msg); });
    reach(h, PHASE.COMBAT, 1, (ps) => ps.playerId !== 'p_1');
    assert.equal(toasts.length, 0, String(afkRemoveRounds));
    assert.equal(h.ps('p_1').privateView().afkWarn, undefined);
    h.m.dispose();
  }
});
