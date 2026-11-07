// test/match/twenty-player-rules.test.js — 多人同盟容量规则（移植自用户分支 test/match/twenty-player-rules.test.js）：
// 配置出的容量、而非存活阈值，决定固定二十席分块与可重复的扩编招募。与本仓的差异（见报告）：
//   * 断线/托管重入并发机变草稿（intents.js kickBot 的 concurrent 分支）不在本代理边界——机变用例仍按
//     一步倒计时到点统一发卡断言（strategy 草稿的退出重入已由 platform.js _quit 落地）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ERR } from '../../shared/constants.js';
import { generateDraft } from '../../server/match/choices.js';
import { createRng } from '../../server/sim/rng.js';
import { createRegistry } from '../../server/match/effectsMeta.js';
import { botPickBand } from '../../server/match/bot.js';
import { attachAudit } from '../../server/match/audit.js';
import { collectViolations } from '../../server/match/invariants.js';
import { GameData } from '../../server/match/gamedata.js';
import { makeMatch, DATA, checkInvariants } from './harness.js';
import { makeBattle, chessRec } from '../helpers/battleHarness.js';

const rules = (capacity = 20, extra = {}) => ({ revivalEnabled: false, disableSharedPool: false, playerCapacity: capacity, ...extra });
const forced = family => ({ ...DATA, choices: { ...DATA.choices, schedule: { ...DATA.choices.schedule,
  mode_multi_normal: { ...DATA.choices.schedule.mode_multi_normal, rounds: { ...DATA.choices.schedule.mode_multi_normal.rounds,
    3: { ...DATA.choices.schedule.mode_multi_normal.rounds[3], families: [{ family, weight: 1 }] } } } } } });
const make = (t, count = 20, extra = {}) => {
  const h = makeMatch({ humans: count, experimental: rules(), fake: true, seed: 713, ...extra });
  t.after(() => h.m.dispose()); return h;
};
const enterBand = h => {
  h.start(); for (const ps of h.m.order) if (!ps.isBot) assert.deepEqual(h.m.handle(ps.playerId, { t: 'g.infoReady' }), { ok: true });
  h.sched.advance(0); assert.equal(h.m.phase, 'BAND_DRAFT');
};

for (let count = 1; count <= 20; count++) test(`twenty target with ${count} participants keeps consecutive four-seat chunks at ordinary copy caps`, t => {
  const h = make(t, count), m = h.m;
  const sizes = Array.from({ length: Math.ceil(count / 4) }, (_, i) => Math.min(4, count - i * 4));
  assert.deepEqual(m.poolGroups.map(g => g.playerIds.length), sizes);
  assert.deepEqual(m.poolGroups.flatMap(g => g.playerIds), m.order.map(p => p.playerId));
  for (const group of m.poolGroups) for (const [id, e] of group.pool.entries) assert.equal(e.cap, m.gd.poolCopies(id));
  const groups = m.poolGroups.map(g => g.playerIds.slice()), pools = m.order.map(p => p.pool);
  m.order.at(-1).eliminate(1);
  assert.deepEqual(m.poolGroups.map(g => g.playerIds), groups); assert.deepEqual(m.order.map(p => p.pool), pools);
  assert.deepEqual(collectViolations(m), []);
});

test('twenty sparse/reversed seat input groups by actual seat order, not pid or occupied-seat modulo', t => {
  const roster = [0, 2, 4, 6, 8, 10, 12, 14, 19].map((seat, i) => ({ seat, playerId: `reverse_${9 - i}`, name: `Seat${seat}`, isBot: false, connected: true })).reverse();
  const h = make(t, 9, { seats: roster });
  assert.deepEqual(h.m.poolGroups.map(g => g.playerIds), [['reverse_9', 'reverse_8', 'reverse_7', 'reverse_6'], ['reverse_5', 'reverse_4', 'reverse_3', 'reverse_2'], ['reverse_1']]);
});

test('twenty partial tail cannot borrow first-group copies; promotion, sale and departure keep exact pool accounting', t => {
  const h = make(t, 9), m = h.m; m.phase = 'PREP'; m.round = 1;
  for (const ps of m.order) ps.lp = 28;
  const [a, b] = [m.order[0], m.order[8]], base = [...a.pool.entries].find(([, e]) => e.tier === 1)[0];
  const cap = a.pool.cap(base);
  for (let i = 0; i < 3; i++) assert.ok(a.acquireChess(base));
  const elite = [...a.hand, ...a.temp].find(p => p && m.gd.isGolden(p.id)); assert.ok(elite);
  assert.equal(elite.poolCopies, 3); assert.equal(a.pool.left(base), cap - 3); assert.equal(b.pool.left(base), cap);
  assert.deepEqual(a.sell(elite.uid), { ok: true }); assert.equal(a.pool.left(base), cap);
  assert.ok(b.acquireChess(base)); assert.equal(b.pool.left(base), cap - 1); assert.equal(a.pool.left(base), cap);
  const pools = m.poolGroups.map(g => g.pool); b.eliminate(1);
  assert.equal(b.pool.left(base), cap); assert.deepEqual(m.poolGroups.map(g => g.pool), pools);
  assert.deepEqual(collectViolations(m), []);
});

for (const independent of [false, true]) test(`Mimic overdraw stays in its ${independent ? 'private' : 'four-seat'} pool and both grouped invariant checkers accept the signed balance`, t => {
  const h = make(t, 9, { experimental: rules(20, { disableSharedPool: independent }) }), m = h.m;
  m.phase = 'PREP'; m.round = 1;
  for (const ps of m.order) ps.lp = 28;
  const a = m.order[0], tail = m.order[8], base = [...a.pool.entries].find(([, e]) => e.tier === 6)[0];
  const cap = a.pool.cap(base);
  assert.equal(cap, 10, 'the co-op shared tier VI capacity, including in a complete private pool');
  for (let i = 0; i <= cap; i++) assert.ok(a.acquireChess(base));
  assert.equal(a.pool.entries.get(base).left, -1, 'special grants retain full occupation beyond stock');
  const target = a.allChess().find(c => c.id === base);
  assert.ok(target);
  const mimic = a.acquireItem('chess_item_5_05_e_a'); assert.ok(mimic);
  assert.deepEqual(a.equip(mimic.uid, target.uid), { ok: true });
  assert.equal(a.pool.entries.get(base).left, -2, 'Mimic completes the third-copy branch beyond stock');
  assert.equal(a.pool.left(base), 0); assert.equal(a.pool.snapshot()[base], 0);
  assert.equal(a.pool.totalLeft(), [...a.pool.entries.values()].reduce((sum, e) => sum + Math.max(0, e.left), 0));
  assert.equal(tail.pool.left(base), tail.pool.cap(base), 'another group never pays for the overdraw');
  checkInvariants(m);
  const elite = a.allChess().find(c => m.gd.baseIdOf(c.id) === base && m.gd.isGolden(c.id)); assert.ok(elite);
  assert.deepEqual(a.sell(elite.uid), { ok: true });
  assert.equal(a.pool.left(base), 1, 'returning three occupied copies clears only the actual deficit');
  checkInvariants(m);
});

test('disableSharedPool takes precedence over fixed twenty chunks and grants each participant a complete private pool', t => {
  const h = make(t, 9, { experimental: rules(20, { disableSharedPool: true }) });
  assert.equal(h.m.poolGroups.length, 9); assert.equal(new Set(h.m.order.map(p => p.pool)).size, 9);
  for (const ps of h.m.order) for (const [id, e] of ps.pool.entries) assert.equal(e.cap, h.m.gd.poolCopies(id));
});

for (const [capacity, count, sizes, scale] of [[4, 4, [4], 1], [8, 2, [2], 1], [8, 5, [5], 1.25], [12, 9, [3, 3, 3], 1], [16, 13, [4, 3, 3, 3], 1]]) {
  test(`non-twenty ${capacity}-mode with ${count} participants retains prior pools and six-card draft RNG`, t => {
    const h = make(t, count, { experimental: rules(capacity) }), m = h.m, repeat = capacity > 4;
    assert.equal(m.twentyPlayerMode, false); assert.deepEqual(m.poolGroups.map(g => g.playerIds.length), sizes);
    for (const g of m.poolGroups) for (const [id, e] of g.pool.entries) assert.equal(e.cap, Math.ceil(m.gd.poolCopies(id) * scale));
    enterBand(h); assert.equal(m.publicView().draft.allowRepeat === true, repeat);
    // 扩编房间的两步草稿都是并发的（concurrentDraft）：turn 为 null，一步一个倒计时
    assert.equal(m.publicView().draft.concurrent === true, repeat);
    const nextBand = () => m.players.get(m.draft.order.find(pid => !m.draft.picks[pid]));
    const nextSp = () => m.players.get(repeat ? m.sp.order.find(pid => m.sp.picks[pid] == null) : m.spTurn());
    const first = nextBand(); assert.deepEqual(m.pickBand(first, 'band_bldsk'), { ok: true });
    const band = m.pickBand(nextBand(), 'band_bldsk');
    assert.deepEqual(repeat ? band : { error: band.error }, repeat ? { ok: true } : { error: ERR.BAD_TARGET });
    m.round = 3;
    const rng = createRng(m.rngDraft.state()), order = m.alivePlayers().map(p => p.playerId);
    const original = generateDraft(m.gd, rng, 3, { stageId: m.stageId, bondAvailable: id => m.bondLive(id) });
    rng.shuffle(order); m.enterSpDraft();
    assert.deepEqual(m.sp.cards, original.cards); assert.deepEqual(m.sp.order, order); assert.equal(m.rngDraft.state(), rng.state());
    assert.equal(m.sp.cards.length, 6); assert.equal(m.publicView().sp.allowRepeat === true, repeat);
    assert.equal(m.publicView().sp.concurrent === true, repeat);
    const picker = nextSp(); assert.deepEqual(m.pickCard(picker, 0), { ok: true });
    const choice = m.pickCard(nextSp(), 0);
    assert.deepEqual(repeat ? choice : { error: choice.error }, repeat ? { ok: true } : { error: ERR.SOLD_OUT });
  });
}

for (const capacity of [8, 12, 16, 20]) test(`${capacity}-mode humans may all choose the same legal band once, all at once under one countdown and without skips`, t => {
  const h = make(t, capacity, { experimental: rules(capacity) }), m = h.m, audit = attachAudit(m); enterBand(h);
  const view = m.publicView().draft;
  assert.equal(view.allowRepeat, true); assert.equal(view.concurrent, true); assert.equal(view.turn, null);
  assert.equal(m.draftTurn(), null);
  const deadline = m.deadline; assert.ok(deadline > 0); assert.equal(view.turnDeadline, deadline);
  assert.ok(m.order.every(ps => m.statusOf(ps) === 'deciding'));
  assert.equal(m.skipBand(m.players.get(m.draft.order[0])).error, ERR.WRONG_PHASE);
  for (const ps of m.order) assert.deepEqual(m.bandFocus(ps, 'band_bldsk'), { ok: true });
  // any seat at any time — the last of the order first — and the step keeps its one countdown until the last pick
  for (const pid of [...m.draft.order].reverse()) {
    const ps = m.players.get(pid); assert.deepEqual(m.pickBand(ps, 'band_bldsk'), { ok: true });
    assert.equal(m.pickBand(ps, 'band_bldsk').error, ERR.ALREADY);
    assert.equal(m.bandFocus(ps, 'band_bldsk').error, ERR.ALREADY);
    assert.equal(m.statusOf(ps), 'ready');
    if (Object.keys(m.draft.picks).length < capacity) assert.equal(m.deadline, deadline);
  }
  h.sched.advance(0); assert.equal(m.phase, 'BATTLE_CHECK');
  assert.equal(Object.keys(m.draft.picks).length, capacity); assert.equal(new Set(Object.values(m.draft.picks)).size, 1);
  assert.ok(m.order.every(ps => ps.bandId === 'band_bldsk' && ps.lp === m.gd.startLp('band_bldsk')));
  assert.equal(new Set(m.order.map(ps => ps.counters)).size, capacity);
  assert.deepEqual(audit.violations, []);
});

for (const capacity of [8, 12, 16, 20]) test(`${capacity}-mode repeated timeout defaults and duplicate-band handlers maintain separate counters`, t => {
  const registry = createRegistry({ log: { warn() {}, error() {}, info() {} } });
  registry.register('band:band_bldsk', { onRoundStart(ctx) { ctx.incCounter('same-band'); ctx.addFunds(2, 'band'); } });
  const h = make(t, 5, { registry, experimental: rules(capacity) }), m = h.m; enterBand(h);
  for (const pid of m.draft.order) assert.equal(m.defaultBand(pid), 'band_bldsk');
  // the step's one countdown gives every seat still deciding its default at once
  h.sched.advance(m.bandTurnMs()); h.sched.advance(0);
  assert.equal(m.phase, 'BATTLE_CHECK'); assert.equal(Object.keys(m.draft.picks).length, 5);
  assert.equal(new Set(Object.values(m.draft.picks)).size, 1);
  m.round = 1;
  m.dispatch(m.order[0], 'onRoundStart', { round: 1 });
  assert.equal(m.order[0].counters['same-band'], 1); assert.ok(m.order.slice(1).every(ps => !ps.counters['same-band']));
  for (const ps of m.order.slice(1)) m.dispatch(ps, 'onRoundStart', { round: 1 });
  assert.ok(m.order.every(ps => ps.counters['same-band'] === 1 && ps.funds === 2));
});

for (const [capacity, count] of [[8, 2], [8, 5], [8, 8], [12, 12], [16, 16], ...[1, 2, 4, 5, 6, 9, 17, 20].map(count => [20, count])]) for (const family of ['bounty', 'supply', 'shop', 'tactic']) {
  test(`${capacity}-mode ${count} living ${family}: six source options, repeat permission and one confirmation per player within stock`, t => {
    const h = make(t, count, { experimental: rules(capacity), data: forced(family) }), m = h.m; m.round = 3;
    for (const ps of m.order) ps.lp = 28;
    const audit = attachAudit(m); m.enterSpDraft(); const draft = m.sp;
    assert.equal(draft.cards.length, 6); assert.equal(draft.family, family); assert.equal(m.publicView().sp.allowRepeat, true);
    const options = structuredClone(draft.cards), first = draft.cards[0];
    // equipment stock is per chess-pool group (Match itemPoolFor): each group's seats can take card 0 up to its own stock
    const groups = new Map();
    for (const ps of m.order) {
      const g = groups.get(ps.itemPool) || { seats: 0, stock: first.kind === 'item' ? Math.floor(ps.itemPool.left(first.id) / ps.itemPool.need(first.id)) : Infinity };
      g.seats++; groups.set(ps.itemPool, g);
    }
    const firstPicks = [...groups.values()].reduce((n, g) => n + Math.min(g.seats, g.stock), 0);
    assert.ok(draft.cards.every((card, i) => card.idx === i));
    // every seat picks at once (concurrentDraft): no turn, any order — here the last of the order first
    assert.equal(m.spTurn(), null); assert.equal(m.publicView().sp.concurrent, true);
    let confirmed = 0, firstTaker = null;
    for (const pid of [...draft.order].reverse()) {
      const ps = m.players.get(pid);
      if (!m.spPending(ps)) { assert.ok(!draft.cards.some(c => m.spCardAvailable(c, ps)), 'only a seat whose stock holds none of the cards has nothing to pick'); continue; }
      assert.equal(m.pickCard(ps, 6).error, ERR.BAD_TARGET);
      if (!m.spCardAvailable(first, ps)) {
        assert.equal(first.kind, 'item', 'taken metadata alone cannot exhaust repeatable bounty/tactic cards');
        assert.equal(ps.itemPool.canGain(first.id), false);
        assert.equal(m.pickCard(ps, 0).error, ERR.SOLD_OUT);
        assert.deepEqual(ps.privateView().spBlocked.includes(0), true, 'the seat sees the card sold out for its own stock');
        assert.equal(draft.picks[ps.playerId], undefined, 'a rejected exhausted card consumes no confirmation');
      }
      const card = draft.cards.find(c => m.spCardAvailable(c, ps));
      assert.ok(card);
      assert.deepEqual(m.pickCard(ps, card.idx), { ok: true }); assert.equal(draft.picks[ps.playerId], card.idx);
      if (card.idx === 0) firstTaker ??= pid;
      assert.equal(m.pickCard(ps, card.idx).error, ERR.ALREADY); confirmed++;
    }
    h.sched.advance(0); assert.equal(m.phase, 'PREP');
    assert.equal(Object.keys(draft.picks).length, confirmed);
    assert.equal(Object.values(draft.picks).filter(idx => idx === 0).length, firstPicks);
    if (first.kind !== 'item') {
      assert.equal(confirmed, count); assert.ok(Object.values(draft.picks).every(idx => idx === 0), 'unlimited bounty/tactic choices remain fully repeatable');
    }
    assert.equal(draft.taken[0], firstTaker); assert.deepEqual(draft.cards, options);
    assert.equal(m.errorCount, 0); assert.deepEqual(audit.violations, []);
  });
}

for (const capacity of [8, 12, 16, 20]) test(`${capacity}-mode repeated team choices isolate nested content mutations per picker and recipient`, t => {
  const chosen = DATA.choices.cards.tactic.find(c => c.team); assert.ok(chosen);
  const data = forced('tactic'); data.choices = { ...data.choices, cards: { ...data.choices.cards, tactic: [chosen] } };
  const calls = new Map();
  const h = make(t, capacity, { data, experimental: rules(capacity) }), m = h.m; m.round = 3;
  const registry = m.registry;
  registry.register(`choice:${chosen.effectId}`, { onChoicePick(ctx, ev) {
    const seen = calls.get(ctx.playerId) || []; seen.push(ev.picker); calls.set(ctx.playerId, seen);
    assert.equal(ctx.source.card.nested.count, 0); ctx.source.card.nested.count++;
    ctx.incCounter('repeat-team'); ctx.source.card.id = 'mutated-test-copy'; ctx.source.card.team = false;
  } });
  for (const ps of m.order) ps.lp = 28;
  m.enterSpDraft(); m.sp.cards[0].nested = { count: 0 }; const draft = m.sp, source = structuredClone(draft.cards);
  for (const pid of draft.order) { const ps = m.players.get(pid); assert.deepEqual(m.pickCard(ps, 0), { ok: true }); m._applyCard(ps, 0); }
  h.sched.advance(0);
  for (const ps of m.order) { assert.equal(ps.counters['repeat-team'], capacity); assert.equal(calls.get(ps.playerId).length, capacity); assert.equal(new Set(calls.get(ps.playerId)).size, capacity); }
  assert.deepEqual(draft.cards, source); assert.equal(m.errorCount, 0);
});

for (const capacity of [8, 12, 16, 20]) test(`${capacity}-mode SP timeout/autoplay still sees all six options after all indices have been used`, t => {
  const h = make(t, capacity, { data: forced('supply'), experimental: rules(capacity) }), m = h.m; m.round = 3;
  for (const ps of m.order) ps.lp = 28;
  m.enterSpDraft(); const draft = m.sp;
  const deadline = m.deadline; assert.ok(deadline > 0);
  for (let idx = 0; idx < 6; idx++) assert.deepEqual(m.pickCard(m.players.get(draft.order[idx]), idx), { ok: true });
  assert.equal(Object.keys(draft.taken).length, 6); assert.equal(m.deadline, deadline, 'picks never restart the countdown');
  const next = m.players.get(draft.order[6]); next.connected = false; m.onDisconnect(next.playerId);
  m.setAutoplay(next, true);
  // （断线/托管的重入在 intents.js kickBot，其并发草稿分支不属本分支范围——到点的一次倒计时仍给每个未决定的席位发卡）
  h.sched.advance(m.scaled(m.gd.timer('spFirst') * 1000)); h.sched.advance(0);
  assert.equal(m.phase, 'PREP'); assert.equal(Object.keys(draft.picks).length, capacity);
});

for (const capacity of [8, 12, 16, 20]) test(`${capacity}-mode repeated equipment uses its group's live stock; exhausted humans/AI switch to a remaining legal card`, t => {
  const h = make(t, 3, { bots: 2, experimental: rules(capacity) }), m = h.m;
  m.phase = 'SP_DRAFT'; m.round = 3;
  for (const ps of m.order) ps.lp = 28;
  const pack = 'chess_item_5_07_e_a', fallback = 'chess_item_2_03_e_a';
  // equipment stock follows the chess-pool groups (Match itemPoolFor): five seats share one pool enlarged ×5/4 in the
  // 8/12/16 modes (商业包装方案 2 → 3), the 20 mode keeps fixed groups of four (seats 0–3 | seat 4, ×1 each)
  const chunked = capacity === 20, first = m.order[0].itemPool, takers = chunked ? 2 : 3;
  assert.equal(first.cap(pack), chunked ? 2 : 3);
  assert.equal(first.cap(fallback), null, 'effect-only gear has no shared cap');
  assert.equal(m.order[4].itemPool === first, !chunked);
  m.sp = { cards: [pack, fallback].map((id, idx) => ({ idx, id, kind: 'item' })),
    order: m.order.map(p => p.playerId), idx: 0, picks: {}, taken: {}, untimed: true, concurrent: true };
  const draft = m.sp;
  for (const ps of m.order.slice(0, takers)) assert.deepEqual(m.pickCard(ps, 0), { ok: true });
  assert.equal(draft.taken[0], m.order[0].playerId, 'taken keeps only first-picker display metadata');
  assert.equal(first.left(pack), 0);
  const next = m.order[takers];
  assert.equal(m.pickCard(next, 0).error, ERR.SOLD_OUT);
  assert.equal(draft.picks[next.playerId], undefined, 'an exhausted rejection consumes no pick');
  // the public mark: no alive seat's stock holds it; each seat's own: m.private spBlocked
  assert.equal(m.publicView().sp.cards[0].soldOut, !chunked);
  assert.deepEqual(next.privateView().spBlocked, [0], "the card is marked for the seat's own group");
  assert.deepEqual(m.pickCard(next, 1), { ok: true });
  assert.ok(h.run(() => m.phase === 'PREP'), 'automatic picks skip the exhausted repeated card');
  assert.equal(Object.keys(draft.picks).length, 5);
  const picks = m.order.map(ps => draft.picks[ps.playerId]);
  assert.deepEqual(picks.slice(0, 4), chunked ? [0, 0, 1, 1] : [0, 0, 0, 1]);
  if (chunked) {
    // the fifth seat draws on its own group's two copies, untouched by the first group's
    assert.ok([0, 1].includes(picks[4]));
    assert.equal(m.order[4].itemPool.held(pack), picks[4] === 0 ? 1 : 0);
  } else assert.equal(picks[4], 1);
  assert.equal(first.held(pack), first.cap(pack));
  assert.deepEqual(collectViolations(m), []);
  assert.deepEqual(h.logs.error, []);
});

for (const capacity of [8, 12, 16, 20]) test(`${capacity}-mode AI seats repeat the human band and unlimited bounty index`, t => {
  const h = make(t, 2, { bots: capacity - 2, aiPicksLast: true, data: forced('bounty'), experimental: rules(capacity) }), m = h.m;
  m.rngBots = () => 0; enterBand(h);
  const band = botPickBand(m, m.order.find(ps => ps.isBot));
  // 「AI 队友最后选择」: the AI seats wait until no human is still deciding
  const humans = m.draft.order.slice(0, 2).map(pid => m.players.get(pid)); assert.ok(humans.every(ps => !ps.isBot));
  h.sched.advance(0); assert.deepEqual(Object.keys(m.draft.picks), []);
  assert.deepEqual(m.pickBand(humans[1], band), { ok: true }); h.sched.advance(0);
  assert.deepEqual(Object.keys(m.draft.picks), [humans[1].playerId]);
  assert.deepEqual(m.pickBand(humans[0], band), { ok: true });
  h.sched.advance(0); assert.equal(m.phase, 'BATTLE_CHECK');
  assert.ok(Object.values(m.draft.picks).every(id => id === band));
  m.setDeadline(0); m.round = 3; m.enterSpDraft(); const draft = m.sp;
  const source = draft.cards[0]; draft.cards = draft.cards.map((card, idx) => ({ ...source, idx }));
  for (const pid of draft.order.slice(0, 2)) assert.deepEqual(m.pickCard(m.players.get(pid), 0), { ok: true });
  assert.ok(h.run(() => m.phase === 'PREP'));
  assert.equal(Object.keys(draft.picks).length, capacity); assert.ok(Object.values(draft.picks).every(idx => idx === 0));
  assert.equal(m.errorCount, 0);
});

for (const capacity of [8, 12, 16, 20]) test(`${capacity}-mode timeout focus, departing defaults and later two survivors retain repeat rules`, t => {
  const h = make(t, 5, { experimental: rules(capacity), data: forced('bounty') }), m = h.m; enterBand(h);
  const focused = m.gd.bandIds().find(id => id !== m.gd.bandDraft.timeoutBandId); assert.ok(focused);
  const focusing = m.draft.order.slice(0, 2).map(pid => m.players.get(pid));
  for (const ps of focusing) assert.deepEqual(m.bandFocus(ps, focused), { ok: true });
  const departing = m.players.get(m.draft.order[2]); m.onLeave(departing.playerId);
  assert.equal(m.phase, 'BAND_DRAFT', 'a departure leaves the others deciding');
  // 并发草稿没有「到它的回合由 AI 代选」：退出席位立即落默认（platform.js _quit），不占一步倒计时
  assert.equal(m.draft.picks[departing.playerId], m.gd.bandDraft.timeoutBandId);
  h.sched.advance(m.bandTurnMs());
  for (const ps of focusing) assert.equal(m.draft.picks[ps.playerId], focused);
  h.sched.advance(0); assert.equal(m.phase, 'BATTLE_CHECK');
  assert.ok(m.order.filter(ps => ![m.draft.order[0], m.draft.order[1]].includes(ps.playerId)).every(ps => ps.bandId === m.gd.bandDraft.timeoutBandId));
  m.setDeadline(0);
  for (const ps of m.order.slice(2)) if (ps.alive) ps.eliminate(1);
  m.round = 9; m.enterSpDraft(); const draft = m.sp;
  assert.equal(m.playerCapacity, capacity); assert.equal(draft.order.length, 2); assert.equal(draft.cards.length, 6);
  assert.equal(m.publicView().sp.allowRepeat, true);
  for (const pid of draft.order) assert.deepEqual(m.pickCard(m.players.get(pid), 0), { ok: true });
  h.sched.advance(0); assert.equal(m.phase, 'PREP'); assert.equal(Object.keys(draft.picks).length, 2);
});

test('two battle owners with the same revive strategy each retain their own three-use hook counter', () => {
  const rec = chessRec('repeat_op', { hp: 1000, atk: 1, range: [[0, 0]], respawn: 20 });
  const players = ['left', 'right'].map((playerId, i) => ({ playerId, seat: i, side: 'L', colOffset: 0, bandId: 'band_ermengard', bonds: {}, playerEffects: [],
    units: [{ uid: i + 1, chessId: 'repeat_op', row: 10 + i, col: 4, dir: 'RIGHT' }] }));
  const h = makeBattle({ players, defs: { chess: { repeat_op: rec } }, autoFinish: false, timeLimit: 60 }); h.step(1);
  const a = h.b.allies('left')[0], b = h.b.allies('right')[0]; assert.ok(a && b);
  for (let i = 0; i < 3; i++) { h.b.kill(a); assert.equal(a.alive, true); }
  h.b.kill(a); assert.equal(a.alive, false);
  for (let i = 0; i < 3; i++) { h.b.kill(b); assert.equal(b.alive, true); }
  h.b.kill(b); assert.equal(b.alive, false);
  assert.deepEqual(h.b.errors, []);
});

test('equipment stock follows the chess-pool groups: one per group of seats, enlarged with the pool, per player without a shared pool', t => {
  const coin = 'chess_item_1_03_e_a';
  // an ordinary co-op match: one stock for every seat, the measured cap
  const coop = make(t, 4, { experimental: undefined }).m;
  assert.ok(coop.order.every(ps => ps.itemPool === coop.itemPool)); assert.equal(coop.itemPool.cap(coin), 4);
  // the 20 mode: fixed groups of four — the first group's four coins leave the second group's untouched
  const m = make(t, 8).m, [a, b] = [m.order[0], m.order[4]];
  assert.notEqual(a.itemPool, b.itemPool); assert.equal(a.itemPool.cap(coin), 4); assert.equal(b.itemPool.cap(coin), 4);
  for (const ps of m.order.slice(0, 4)) assert.ok(ps.acquireItem(coin));
  assert.equal(a.itemPool.canGain(coin), false); assert.equal(b.itemPool.canGain(coin), true);
  assert.ok(b.acquireItem(coin)); assert.equal(b.itemPool.held(coin), 1); assert.equal(a.itemPool.held(coin), 4);
  assert.equal(a.acquireItem(coin), null, "the first group's stock refuses a fifth");
  // six seats of the 8 mode: 3 + 3, a complete stock each (feedback #49)
  const six = make(t, 6, { experimental: rules(8) }).m;
  assert.deepEqual(six.poolGroups.map(g => g.playerIds.length), [3, 3]); assert.equal(six.itemPool.cap(coin), 4);
  assert.notEqual(six.order[0].itemPool, six.order[3].itemPool);
  // five seats share one pool enlarged ×5/4: 盟约之币 4 → 5
  const five = make(t, 5, { experimental: rules(8) }).m;
  assert.equal(five.poolGroups.length, 1); assert.equal(five.itemPool.cap(coin), 5);
  // no shared pool: every seat its own stock
  const solo = make(t, 3, { experimental: rules(8, { disableSharedPool: true }) }).m;
  assert.equal(new Set(solo.order.map(ps => ps.itemPool)).size, 3);
  const [p0, p1] = solo.order;
  for (let i = 0; i < 4; i++) assert.ok(p0.acquireItem(coin));
  assert.equal(p0.itemPool.held(coin), 4); assert.equal(p0.acquireItem(coin), null);
  assert.equal(p1.itemPool.canGain(coin), true, "another seat's private stock is untouched");
  assert.ok(p1.acquireItem(coin));
  assert.deepEqual(collectViolations(solo), []);
});

test('Match capacity is snapshotted and bounded; solo/default limits and default public shape remain', t => {
  const seats = count => Array.from({ length: count }, (_, seat) => ({ seat, playerId: `p_${seat}`, name: `P${seat}`, isBot: false, connected: true }));
  for (const capacity of [8, 12, 16, 20]) {
    const options = rules(capacity);
    const h = makeMatch({ seats: seats(capacity), experimental: options }); t.after(() => h.m.dispose());
    options.playerCapacity = 4;
    assert.equal(h.m.players.size, capacity); assert.equal(h.m.playerCapacity, capacity);
    assert.ok(Object.isFrozen(h.m.experimental));
    assert.throws(() => makeMatch({ humans: capacity + 1, experimental: rules(capacity) }), /capacity/);
  }
  assert.throws(() => makeMatch({ humans: 5 }), /capacity/);
  assert.throws(() => makeMatch({ humans: 5, experimental: rules(4) }), /capacity/);
  assert.throws(() => makeMatch({ mode: 'solo', seats: seats(2), experimental: rules(20) }), /capacity/);
  for (const seat of [-1, 20, 0.5, NaN]) assert.throws(() => makeMatch({ seats: [{ ...seats(1)[0], seat }], experimental: rules() }), /seat index/);
  assert.throws(() => makeMatch({ seats: [seats(2)[0], { ...seats(2)[1], seat: 0 }], experimental: rules() }), /seat index/);
  for (const capacity of [5, 6, 7, 21, Infinity, '20']) assert.throws(() => makeMatch({ experimental: { ...rules(), playerCapacity: capacity } }), /experimental/);
  const ordinary = makeMatch({ humans: 4 }); t.after(() => ordinary.m.dispose());
  const four = makeMatch({ humans: 4, experimental: rules(4) }); t.after(() => four.m.dispose());
  assert.deepEqual(four.m.publicView(), ordinary.m.publicView());
  assert.equal('playerCapacity' in ordinary.m.publicView(), false);
  assert.equal('poolGroups' in ordinary.m.publicView(), false);
  assert.equal(ordinary.m.playerPools, null);
  // 容量房间的取池必须落在已入座的席位上（普通对局 poolFor 恒等 m.pool，无此约束）
  const cap9 = makeMatch({ humans: 9, experimental: rules(20) }); t.after(() => cap9.m.dispose());
  assert.throws(() => cap9.m.poolFor('stranger'), /player card pool/);
  assert.throws(() => cap9.m.poolFor(null), /player card pool/);
  // （createPoolGroups / SharedPool scale 的边界在 experimental-player-capacity 的纯函数段；此处只钉公共形状）
});

test('disableDuckLord keeps the duck band out of a capacity room: picks, default, timeout fallback; ≤4 rooms ignore it', t => {
  // a room whose configured default / timeout strategy IS the duck band: the switch must fall past it everywhere
  const data = { ...DATA, config: { ...DATA.config,
    economy: { ...DATA.config.economy, defaultBandId: 'band_ducklord' },
    bandDraft: { ...DATA.config.bandDraft, timeoutBandId: 'band_ducklord' } } };
  const plain = new GameData(data, 'mode_multi_hard');
  assert.equal(plain.bandAllowed('band_ducklord'), true);
  assert.equal(plain.defaultBandId, 'band_ducklord'); assert.equal(plain.bandDraft.timeoutBandId, 'band_ducklord');
  const h = make(t, 8, { data, experimental: rules(8, { disableDuckLord: true }) }), m = h.m;
  assert.equal(m.disableDuckLord, true); assert.equal(m.gd.disableDuckLord, true);
  assert.equal(m.gd.bandAllowed('band_ducklord'), false);
  assert.ok(!m.gd.bandIds().includes('band_ducklord'), 'the duck band is not offered');
  assert.equal(m.gd.defaultBandId, 'band_bldsk', 'the default falls to the first usable band');
  assert.equal(m.gd.bandDraft.timeoutBandId, 'band_bldsk', 'the timeout fallback falls with it');
  enterBand(h);
  for (const pid of m.draft.order) assert.notEqual(m.defaultBand(pid), 'band_ducklord');
  // the step's one countdown gives every seat still deciding its default — never the duck band
  h.sched.advance(m.bandTurnMs()); h.sched.advance(0);
  assert.equal(m.phase, 'BATTLE_CHECK');
  assert.ok(Object.values(m.draft.picks).every(id => id !== 'band_ducklord'));
  // an ordinary-sized room ignores the switch (Match only wires it past four seats)
  const four = makeMatch({ humans: 4, data, experimental: rules(4, { disableDuckLord: true }) });
  t.after(() => four.m.dispose());
  assert.equal(four.m.disableDuckLord, false); assert.equal(four.m.gd.disableDuckLord, false);
  assert.equal(four.m.gd.bandAllowed('band_ducklord'), true);
  assert.equal(four.m.gd.defaultBandId, 'band_ducklord');
});

test('an expanded room\'s band effects roll from the dispatching seat\'s own stock (见者有份 onPrepStart)', (t) => {
  // 娜仁图亚's 「见者有份」 rolls its free items via ctx.rollPool without an explicit player: in a grouped room that
  // player is the dispatching seat (Match itemPoolFor) — the shared-pool fallback is gone and must not throw.
  const h = make(t, 9), m = h.m;
  m.phase = 'PREP'; m.round = 2;
  for (const ps of m.order) ps.lp = 28;
  const ps = m.order[0];
  ps.bandId = 'band_narant';
  m.dispatch(ps, 'onPrepStart', { round: 2 });
  assert.equal(h.logs.error.filter(l => l.includes('meta handler error')).length, 0, 'no meta handler error');
  assert.ok(ps.offers.some(o => Array.isArray(o.slots) && o.slots.length && o.slots.every(s => s.kind === 'item')),
    'the free item offer arrived (rolled from the seat\'s group stock)');
  assert.deepEqual(collectViolations(m), []);
});
