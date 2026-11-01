// 预选盟约 (bond plan, 移植自用户分支 fork e64a3260, a remake feature, display only): g.bondPlan { bondId? } — a human
// player announces the core bond it means to build from INFO_CHECK until round 1's battle starts (the strategy draft,
// BATTLE_CHECK and round 1's ROUND_START / 机变 / prep), afterwards WRONG_PHASE; every teammate and spectator sees it as
// m.public players[].bondPlan for the whole match (reconnects and new spectator seats included). Plannable: every core
// faction bond (GameData plannableBondIds, bonds.json isCore) in every mode, the ones the mode switches off included;
// trait bonds are refused (BAD_TARGET). AI seats never announce one and nothing else of the match reads it
// (server/match/match/intents.js planBond). The client side: ui/bondPlan.js (picker + tag), the briefing's entry
// (screens/briefing.js), the draft order rows (screens/bandDraft.js) and the team panel (ui/teamPanel.js) — asserted
// below as pure functions and source wiring, the way test/ui/*.test.js do it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERR, PHASE } from '../../shared/constants.js';
import { validateC2S } from '../../shared/protocol.js';
import { GameData } from '../../server/match/gamedata.js';
import { plannableBonds, bondPlanOpen, bondPlanHolders } from '../../public/js/ui/bondPlan.js';
import { DATA, makeMatch } from './harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const CORE = ['yanShip', 'sargonShip', 'victoriaShip', 'kjeragShip', 'lateranoShip', 'egirShip', 'siracusaShip', 'kazimierzShip'];
const S = 's_spec';
const plan = (m, pid, bondId) => m.handle(pid, bondId === undefined ? { t: 'g.bondPlan' } : { t: 'g.bondPlan', bondId });
/** players[].bondPlan of an m.public frame by playerId */
const plans = (pub) => Object.fromEntries(pub.players.map((p) => [p.playerId, p.bondPlan]));

test('protocol: g.bondPlan { bondId? } validates (absent / null clears)', () => {
  assert.equal(validateC2S({ t: 'g.bondPlan', bondId: 'yanShip' }), null);
  assert.equal(validateC2S({ t: 'g.bondPlan', bondId: null }), null);
  assert.equal(validateC2S({ t: 'g.bondPlan' }), null);
  for (const bondId of ['', 'a b', 12, true, {}, 'a'.repeat(65)]) assert.notEqual(validateC2S({ t: 'g.bondPlan', bondId }), null, String(bondId));
});

test('plannable bonds: the eight core faction bonds in every mode, mode-off ones included; never a trait bond', () => {
  for (const modeId of Object.keys(DATA.config.modes)) {
    const gd = new GameData(DATA, modeId);
    assert.deepEqual([...gd.plannableBondIds()], CORE, modeId);
    assert.ok(Object.isFrozen(gd.plannableBondIds()));
  }
  const funny = new GameData(DATA, 'mode_multi_funny');
  for (const id of ['lateranoShip', 'egirShip', 'kazimierzShip']) {
    assert.ok(funny.modeInactiveBonds.has(id), `${id} is off in 标准模拟`);
    assert.equal(funny.bondPlannable(id), true, `${id} is still plannable`);
  }
  for (const id of ['preciShip', 'swiftShip', 'maniShip', 'emptyShip', 'soloShip', 'suntShip', 'investShip', 'nope', '__proto__', 'constructor', '', null, 7]) {
    assert.equal(funny.bondPlannable(id), false, String(id));
  }
  // the data says the same: the core bonds are exactly the SEASON bonds
  assert.deepEqual(Object.values(DATA.bonds).filter((b) => b.isCore).map((b) => b.bondId).sort(), [...CORE].sort());
  assert.ok(Object.values(DATA.bonds).every((b) => (b.bondType === 'SEASON') === (b.isCore === true)));
});

test('accepted through the opening (INFO_CHECK → round 1 prep), refused once round 1\'s battle starts; kept the whole match', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 1, seed: 4711, fake: true, script: () => ({ duration: 2 }) }).start();
  const m = h.m;
  assert.equal(m.phase, PHASE.INFO_CHECK);
  assert.deepEqual(plans(m.publicView()), { p_0: null, p_1: null, ai_0: null }, 'nobody planned yet (bots never announce one)');
  const seen = [];
  const step = (phase, round, bondId) => {
    assert.ok(h.drive(() => m.phase === phase && m.round === round, { ready: false }), `reach ${phase} R${round}`);
    assert.deepEqual(plan(m, 'p_0', bondId), { ok: true }, `${phase} R${round}`);
    assert.equal(h.ps('p_0').bondPlan, bondId);
    seen.push(phase);
  };
  step(PHASE.INFO_CHECK, 0, 'yanShip');
  step(PHASE.BAND_DRAFT, 0, 'sargonShip');
  step(PHASE.BATTLE_CHECK, 0, 'victoriaShip');
  step(PHASE.ROUND_START, 1, 'kjeragShip');
  step(PHASE.PREP, 1, 'lateranoShip');
  assert.deepEqual(seen, [PHASE.INFO_CHECK, PHASE.BAND_DRAFT, PHASE.BATTLE_CHECK, PHASE.ROUND_START, PHASE.PREP]);
  // two players may plan the same bond
  assert.deepEqual(plan(m, 'p_1', 'lateranoShip'), { ok: true });
  h.flushAll();
  assert.deepEqual(plans(h.lastBc('m.public')), { p_0: 'lateranoShip', p_1: 'lateranoShip', ai_0: null });

  assert.ok(h.drive(() => m.phase === PHASE.COMBAT && m.round === 1), 'reach COMBAT R1');
  assert.deepEqual(plan(m, 'p_0', 'yanShip'), { error: ERR.WRONG_PHASE });
  assert.deepEqual(plan(m, 'p_0', null), { error: ERR.WRONG_PHASE }, 'no clearing either');
  assert.equal(h.ps('p_0').bondPlan, 'lateranoShip');
  for (const [phase, round] of [[PHASE.SETTLE, 1], [PHASE.ROUND_START, 2], [PHASE.PREP, 2]]) {
    assert.ok(h.drive(() => m.phase === phase && m.round === round), `reach ${phase} R${round}`);
    assert.deepEqual(plan(m, 'p_1', 'yanShip'), { error: ERR.WRONG_PHASE }, `${phase} R${round}`);
    h.flushAll();
    assert.deepEqual(plans(h.lastBc('m.public')), { p_0: 'lateranoShip', p_1: 'lateranoShip', ai_0: null }, `still shown in ${phase} R${round}`);
  }
  h.invariants();
  m.dispose();
});

test('the window by phase and round (机变 in round 1 included); every other phase is WRONG_PHASE', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 1, bots: 1, seed: 5, fake: true }).start();
  const m = h.m;
  const opening = [PHASE.INFO_CHECK, PHASE.BAND_DRAFT, PHASE.BATTLE_CHECK];
  const round1 = [PHASE.ROUND_START, PHASE.SP_DRAFT, PHASE.PREP];
  for (const phase of Object.values(PHASE)) {
    for (const round of [0, 1, 2, 3]) {
      m.phase = phase;
      m.round = round;
      const want = opening.includes(phase) || (round1.includes(phase) && round <= 1);
      assert.equal(m.bondPlanOpen(), want, `${phase} R${round}`);
      const res = m._handle(h.ps('p_0'), { t: 'g.bondPlan', bondId: round % 2 ? 'egirShip' : 'siracusaShip' });
      assert.deepEqual(res, want ? { ok: true } : { error: ERR.WRONG_PHASE }, `${phase} R${round}`);
    }
  }
  m.dispose();
});

test('a 机变 draft in round 1 is part of the opening (forced: no mode has one there); round 3\'s is not', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 2, bots: 1, seed: 8, fake: true, script: () => ({ duration: 1 }) });
  const m = h.m;
  const official = m.gd.spRounds();
  assert.ok(official.includes(3) && !official.includes(1));
  m.gd.spRounds = () => [1, ...official];
  h.start();
  assert.ok(h.drive(() => m.phase === PHASE.SP_DRAFT && m.round === 1, { ready: false }), 'reach SP_DRAFT R1');
  assert.deepEqual(plan(m, 'p_0', 'egirShip'), { ok: true });
  assert.ok(h.drive(() => m.phase === PHASE.SP_DRAFT && m.round === 3), 'reach SP_DRAFT R3');
  assert.deepEqual(plan(m, 'p_0', 'yanShip'), { error: ERR.WRONG_PHASE });
  assert.equal(h.ps('p_0').bondPlan, 'egirShip');
  m.dispose();
});

test('invalid ids are BAD_TARGET (trait bonds, unknown, inherited keys, non-strings); null / absent clears; the same plan again changes nothing', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'FUNNY', humans: 2, seed: 77, fake: true }).start();
  const m = h.m;
  for (const bondId of ['preciShip', 'suntShip', 'maniShip', 'band_bldsk', 'chess_char_1_08_a', 'nope', '__proto__', 'constructor', 'toString', 42, {}]) {
    // handle() may be reached without validateC2S (defence in depth): a non-string id is refused too
    assert.deepEqual(m.handle('p_0', { t: 'g.bondPlan', bondId }), { error: ERR.BAD_TARGET }, String(bondId));
  }
  assert.equal(h.ps('p_0').bondPlan, null);
  // 标准模拟 switches 阿戈尔 off — still plannable
  assert.deepEqual(plan(m, 'p_0', 'egirShip'), { ok: true });
  assert.equal(h.ps('p_0').bondPlan, 'egirShip');
  assert.deepEqual(plan(m, 'p_0', 'nope'), { error: ERR.BAD_TARGET });
  assert.equal(h.ps('p_0').bondPlan, 'egirShip', 'a refused id keeps the plan');

  let marks = 0;
  const mark = m.markPublic.bind(m);
  m.markPublic = () => { marks++; mark(); };
  assert.deepEqual(plan(m, 'p_0', 'egirShip'), { ok: true }, 'the same plan again');
  assert.equal(marks, 0, 'an unchanged plan marks nothing');
  assert.deepEqual(plan(m, 'p_0', 'yanShip'), { ok: true });
  assert.equal(marks, 1, 'a change marks m.public once');
  assert.deepEqual(plan(m, 'p_0', null), { ok: true });
  assert.equal(h.ps('p_0').bondPlan, null, 'null clears');
  assert.deepEqual(plan(m, 'p_0', 'kjeragShip'), { ok: true });
  assert.deepEqual(plan(m, 'p_0'), { ok: true });
  assert.equal(h.ps('p_0').bondPlan, null, 'absent clears');
  assert.deepEqual(plan(m, 'p_0'), { ok: true }, 'clearing nothing is fine');
  assert.equal(marks, 4, 'one mark per change (yanShip, cleared, kjeragShip, cleared)');
  m.dispose();
});

test('spectator seats and AI seats cannot plan; a departed player neither', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 1, seed: 31, fake: true, spectators: [S] }).start();
  const m = h.m;
  assert.deepEqual(plan(m, S, 'yanShip'), { error: ERR.SPECTATOR });
  assert.deepEqual(plan(m, 'ai_0', 'yanShip'), { error: ERR.NOT_IN_ROOM });
  assert.deepEqual(plan(m, 'p_0', 'yanShip'), { ok: true });
  m.onLeave('p_0');
  assert.deepEqual(plan(m, 'p_0', 'sargonShip'), { error: ERR.NOT_IN_ROOM });
  assert.deepEqual(plans(m.publicView()), { p_0: 'yanShip', p_1: null, ai_0: null }, 'the departed player\'s plan stays shown');
  m.dispose();
});

test('visible to every teammate and spectator, survives a reconnect resync and reaches a spectator seat taken later', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 3, seed: 902, fake: true, spectators: [S],
    script: () => ({ duration: 1 }) }).start();
  const m = h.m;
  assert.deepEqual(plan(m, 'p_0', 'yanShip'), { ok: true });
  assert.deepEqual(plan(m, 'p_2', 'kazimierzShip'), { ok: true });
  h.flushAll();
  const want = { p_0: 'yanShip', p_1: null, p_2: 'kazimierzShip' };
  // m.public is one broadcast: every seated human and every spectator seat gets the same frame (opts.broadcast)
  assert.deepEqual(plans(h.lastBc('m.public')), want);
  assert.ok(!h.allTo('p_0', 'm.private').some((p) => 'bondPlan' in p), 'never in m.private');
  // the plans survive the opening and every later phase
  h.autoHumans();
  h.toPrep(2);
  h.flushAll();
  assert.deepEqual(plans(h.lastBc('m.public')), want, 'round 2 prep');
  // a reconnect (or a resync request) resends m.public with the plans
  m.onDisconnect('p_1');
  m.onReconnect('p_1');
  assert.deepEqual(plans(h.lastTo('p_1', 'm.public')), want, 'reconnect resync');
  // the spectator's own resync and a spectator seat taken mid-match
  m.addSpectator(S);
  assert.deepEqual(plans(h.lastTo(S, 'm.public')), want, 'spectator resync');
  m.addSpectator('s_late');
  assert.deepEqual(plans(h.lastTo('s_late', 'm.public')), want, 'a spectator seat taken later');
  const end = h.runToEnd();
  assert.ok(end);
  assert.deepEqual(plans(h.lastBc('m.public')), want, 'the final m.public');
  assert.equal(JSON.stringify(end).includes('bondPlan'), false, 'the summary (golden digests, receipts) carries no plan');
  m.dispose();
});

test('nobody planning: every player reads bondPlan null from the first m.public to the end (solo too)', () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'FUNNY', seed: 3, fake: true, script: () => ({ duration: 1 }) });
  h.autoHumans().start();
  h.runToEnd();
  const frames = h.bc.filter((x) => x.t === 'm.public');
  assert.ok(frames.length > 5);
  for (const f of frames) for (const p of f.players) assert.equal(p.bondPlan, null);
});

describe('UI: ui/bondPlan.js pure functions (the client mirrors the server)', () => {
  test('plannableBonds: every core faction bond in data order — the server\'s plannableBondIds, in every mode', () => {
    const ids = plannableBonds(Object.values(DATA.bonds)).map((b) => b.bondId);
    for (const modeId of ['mode_single_normal', 'mode_multi_normal', 'mode_multi_abyss']) {
      assert.deepEqual(ids, [...new GameData(DATA, modeId).plannableBondIds()], modeId);
    }
    assert.equal(ids.length, 8);
    assert.ok(ids.includes('lateranoShip') && !ids.includes('preciShip'));
    assert.deepEqual(plannableBonds(null), []);
  });

  test('bondPlanOpen: from 确认本局信息 until round 1\'s battle, as on the server', () => {
    for (const phase of [PHASE.INFO_CHECK, PHASE.BAND_DRAFT, PHASE.BATTLE_CHECK]) assert.equal(bondPlanOpen({ phase, round: 0 }), true, phase);
    for (const phase of [PHASE.ROUND_START, PHASE.SP_DRAFT, PHASE.PREP]) {
      assert.equal(bondPlanOpen({ phase, round: 1 }), true, `${phase} R1`);
      assert.equal(bondPlanOpen({ phase, round: 2 }), false, `${phase} R2`);
    }
    for (const phase of [PHASE.COMBAT, PHASE.UNITE, PHASE.SETTLE, PHASE.FINAL_ASSAULT, PHASE.RESULT]) assert.equal(bondPlanOpen({ phase, round: 1 }), false, phase);
    assert.equal(bondPlanOpen(null), false);
  });

  test('bondPlanHolders: other players\' plans by bond, never the viewer\'s', () => {
    const players = [
      { playerId: 'me', name: 'A', bondPlan: 'yanShip' }, { playerId: 'p2', name: 'B', bondPlan: 'yanShip' },
      { playerId: 'p3', name: 'C', bondPlan: 'egirShip' }, { playerId: 'p4', name: 'D', bondPlan: null },
    ];
    assert.deepEqual([...bondPlanHolders(players, 'me')], [['yanShip', ['B']], ['egirShip', ['C']]]);
    assert.deepEqual([...bondPlanHolders(null, 'me')], []);
  });
});

describe('UI: the wiring reads the plan where the fork showed it', () => {
  test('shared/protocol.js declares g.bondPlan', () => {
    assert.match(read('shared/protocol.js'), /'g\.bondPlan': \{ bondId: nullable\(isId\)/);
  });
  test('screens/briefing.js hosts the picker entry (the 确认本局信息 flow)', () => {
    const src = read('public/js/screens/briefing.js');
    assert.match(src, /from '\.\.\/ui\/bondPlan\.js'/);
    assert.match(src, /BondPlanPicker/);
    assert.match(src, /g\.bondPlan/);
    assert.match(src, /bond-plan-open/);
  });
  test('screens/bandDraft.js shows the plan on each draft order row', () => {
    const src = read('public/js/screens/bandDraft.js');
    assert.match(src, /import \{ BondPlanTag \} from '\.\.\/ui\/bondPlan\.js'/);
    assert.match(src, /p\.bondPlan \? html`<\$\{BondPlanTag\} bondId=\$\{p\.bondPlan\} gd=\$\{gd\} class="dorder__plan"/);
  });
  test('ui/teamPanel.js shows the compact plan glyph on the row\'s status line', () => {
    const src = read('public/js/ui/teamPanel.js');
    assert.match(src, /import \{ BondPlanTag \} from '\.\/bondPlan\.js'/);
    assert.match(src, /p\.bondPlan \? html`<\$\{BondPlanTag\} bondId=\$\{p\.bondPlan\} compact=\$\{true\} class="team__plan"/);
  });
  test('the css is there (the tag, the picker cards, the briefing entry)', () => {
    assert.match(read('public/css/screens/game-panels.css'), /\.bplan-card__off/);
    assert.match(read('public/css/screens/game.css'), /\.team__plan/);
    assert.match(read('public/css/screens/draft.css'), /\.dorder__plan/);
    assert.match(read('public/css/screens/briefing.css'), /\.brief-plan/);
  });
  test('the four i18n packs translate the plan strings', () => {
    for (const pack of ['en', 'ja', 'ko', 'zh-TW']) {
      const obj = JSON.parse(read(`public/i18n/${pack}.json`));
      for (const key of ['预选盟约：{name}', '预选盟约', '不预选', '选择你打算发展的盟约，所有博士都能看到。只作沟通，不影响对局。']) {
        assert.equal(typeof obj[key], 'string', `${pack}: ${key}`);
      }
    }
  });
});
