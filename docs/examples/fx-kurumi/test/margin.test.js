import { test } from 'node:test';
import assert from 'node:assert/strict';
import setup, { CHALLENGE_RATINGS } from '../meta.js';
import { getData } from '../../../server/data.js';
import { deriveSeed } from '../../../server/sim/rng.js';
import fs from 'node:fs';

const BAND = 'band_x_fx_kurumi_margin';
function fixture({ mult = 2.5, seed = 17, funds = 10, round = 4, holders = [0], rolls = {}, weights = {}, unavailable = false, inactive = [], bountyCards, enemyDefs, productionSeeds = false } = {}) {
  const handlers = new Map();
  setup({ settings: { multMax: mult, ...weights }, meta: { register: (key, h) => handlers.set(key, h) } });
  const hook = handlers.get('global:fx-kurumi:margin');
  const data = getData();
  const defs = enemyDefs ?? data.enemies;
  const cards = data.choices.cards.bounty;
  const players = Array.from({ length: 3 }, (_, seat) => {
    let balance = seat === 0 ? funds : 40;
    const counters = new Map();
    const p = {
      seat, name: 'P' + seat, round, adds: [], messages: [], bounties: [],
      data: { choices: { cards: { bounty: unavailable ? [] : (bountyCards ?? cards) } } },
      gd: { bossRound: 14, hiddenRound: 15, enemy: (key) => defs[key], inactiveEnemies: new Set(inactive) },
      bandId: () => holders.includes(seat) ? BAND : 'band_cannot', alive: () => true,
      funds: () => balance, counter: (key) => counters.get(key) ?? 0,
      setCounter: (key, value) => counters.set(key, value),
      addFunds: (n, reason) => { balance += n; p.adds.push({ n, reason }); },
      spendFunds: (n) => { if (balance < n) return false; balance -= n; return true; },
      teammates: () => players.filter((x) => x !== p),
      seedFor: (salt) => {
        if (productionSeeds) return deriveSeed(seed, 'meta:' + salt);
        if (salt.startsWith('fx-kurumi:sample:')) return 1;
        for (const [suffix, value] of Object.entries(rolls)) if (salt.endsWith(':' + suffix)) return Math.floor(value * 4294967296);
        return deriveSeed(seed, salt);
      },
      destroyPiece: () => {}, toast: (msg) => p.messages.push(msg), ticker: (msg) => p.messages.push(msg),
      addBounty: (card) => { p.bounties.push(card); return 'bounty:' + p.bounties.length; },
    };
    return p;
  });
  const buy = (p = players[0], id = 'item_x_fx_kurumi_call') => hook.onGain(p, {
    piece: { id: /^item_x_fx_kurumi_(call|put)(_m)?$/.test(id) ? id + '_x' + Math.round(Math.min(3, mult) * 10) : id, uid: 'contract' },
  });
  const prep = () => { for (const p of players) hook.onPrepEnd(p); };
  const result = (leaked, time = 60) => hook.onBattleResult(players[1], { result: { leaked }, time });
  return { hook, players, buy, prep, result };
}

test('symmetric settlement belongs to the bettor alone, with unpaid losses preserved', () => {
  for (const bearish of [false, true]) for (const leaked of [[], [{}]]) {
    const f = fixture({ funds: 3, round: 4, mult: 2.5 });
    const [bettor, other] = f.players;
    f.buy(bettor, bearish ? 'item_x_fx_kurumi_put' : 'item_x_fx_kurumi_call'); f.prep();
    assert.equal(bettor.funds(), 0);
    f.result(leaked); bettor.round = 5; f.hook.onRoundStart(bettor);
    if (bearish === (leaked.length > 0)) {
      assert.deepEqual(bettor.adds, [{ n: 11, reason: 'fx-kurumi:win' }]);
    } else {
      assert.equal(bettor.counter('kurumi:unpaidLoss'), 5);
      const income = { income: 3, pending: 0 }; f.hook.onIncome(bettor, income);
      assert.equal(income.income, 0); assert.equal(bettor.counter('kurumi:unpaidLoss'), 2);
    }
    assert.equal(other.funds(), 40, 'no other player pays or receives anything');
    assert.equal(bettor.counter('kurumi:pos'), 0);
  }
});

test('one target gets one one-battle bounty, without bonus coins or direction-dependent draws', () => {
  let reference;
  for (const bearish of [false, true]) {
    const f = fixture({ holders: [0, 2] });
    for (const p of [f.players[0], f.players[2]]) f.buy(p, bearish ? 'item_x_fx_kurumi_put' : 'item_x_fx_kurumi_call');
    f.prep(); f.prep();
    assert.deepEqual(f.players.map((p) => p.bounties.length), [0, 1, 0]);
    const card = f.players[1].bounties[0];
    assert.equal(card.count, 1);
    assert.equal(card.rounds, 1);
    assert.equal(card.coin, 0);
    assert.equal(card.multiRound, false);
    assert.ok(CHALLENGE_RATINGS[card.enemyKey]?.level >= 1);
    if (reference) assert.deepEqual(card, reference);
    reference = card;
    f.hook.onBattleStart(f.players[1], { kind: 'normal', preview: true });
    assert.equal(f.players[0].counter('kurumi:ann:4'), 0);
    f.hook.onBattleStart(f.players[1], { kind: 'normal' });
    assert.equal(f.players[0].counter('kurumi:ann:4'), 1);
  }
});

test('round progression changes difficulty, while leverage remains capped at 3', () => {
  for (const [round, mult, roll, expected] of [
    [4, 1, 0, 1], [4, 1, 0.78, 2], [4, 3, 0.78, 3],
    [8, 1, 0.1, 2], [8, 3, 0.16, 3],
    [12, 1, 0, 3], [12, 3, 0, 3], [12, 3, 0.1, 4], [12, 3, 0.7, 5],
    [100, 3, 0.1, 4], [100, 3, 0.7, 5],
  ]) {
    const f = fixture({ round, mult, funds: mult === 1 ? 1 : 5, rolls: { strength: roll, low: 0.5 } });
    f.buy(); f.prep();
    assert.equal(f.players[1].counter('kurumi:challengeLevel'), expected, `${round}/${mult}/${roll}`);
  }
  const capped = fixture({ mult: 5 });
  capped.buy();
  assert.equal(capped.players[0].counter('kurumi:mult'), 300);
});

test('late low-level branch includes all three levels even at 3x and has a 10% threshold', () => {
  for (const [roll, coin] of [[0, 1], [1 / 4294967296, 2], [2 / 4294967296, 3]]) {
    const f = fixture({ round: 12, mult: 3, rolls: { low: 0.099, 'low-price': roll, strength: 0.999 } });
    f.buy(); f.prep();
    assert.equal(f.players[1].counter('kurumi:challengeLevel'), coin);
  }
  const ordinary = fixture({ round: 12, mult: 3, rolls: { low: 0.101, strength: 0.999 } });
  ordinary.buy(); ordinary.prep();
  assert.equal(ordinary.players[1].counter('kurumi:challengeLevel'), 5);
});

test('late 3x distribution retains the 10% independent low branch plus 4.5% ordinary level 3', () => {
  const counts = [0, 0, 0, 0, 0, 0];
  for (let seed = 1; seed <= 6000; seed++) {
    const f = fixture({ seed, round: 12, mult: 3 });
    f.buy(); f.prep();
    counts[f.players[1].counter('kurumi:challengeLevel')]++;
  }
  assert.ok(Math.abs((counts[1] + counts[2] + counts[3]) / 6000 - 0.145) < 0.02);
  for (const level of [1, 2]) assert.ok(Math.abs(counts[level] / 6000 - 1 / 30) < 0.015);
  assert.ok(Math.abs(counts[3] / 6000 - (1 / 30 + 0.045)) < 0.02);
  assert.ok(Math.abs(counts[4] / 6000 - 0.36) < 0.025);
  assert.ok(Math.abs(counts[5] / 6000 - 0.495) < 0.025);
});

test('difficulty rises with actual stake times multiplier; equal products and directions draw identically', () => {
  for (let seed = 1; seed <= 128; seed++) {
    let previous = 0;
    for (const [stake, mult] of [[1,1],[2,1],[1,3],[2,2],[5,1],[3,2],[4,2],[5,2],[5,3]]) {
      const f = fixture({ seed, round: 12, mult: 3 });
      f.buy(f.players[0], `item_x_fx_kurumi_call_s${stake}_x${Math.round(mult * 10)}`); f.prep();
      const level = f.players[1].counter('kurumi:challengeLevel');
      assert.ok(level >= previous); previous = level;
    }
    for (const pairs of [[[1,2],[2,1]], [[2,3],[3,2]], [[3,1],[1,3]], [[4,1.5],[3,2]]]) {
      let reference;
      for (const [stake,mult] of pairs) for (const dir of ['call','put']) {
        const f = fixture({ seed, round: 8, mult: 3 });
        f.buy(f.players[0], `item_x_fx_kurumi_${dir}_s${stake}_x${Math.round(mult * 10)}`); f.prep();
        const card = f.players[1].bounties[0];
        if (reference) assert.deepEqual(card, reference); reference = card;
      }
    }
  }
});

test('zero funds, no bet and boss rounds do not create challenges', () => {
  for (const options of [{ funds: 0 }, { round: 14 }, { round: 15 }]) {
    const f = fixture(options);
    f.buy(); f.prep();
    assert.equal(f.players[0].counter('kurumi:pos'), 0);
    assert.equal(f.players[1].bounties.length, 0);
  }
  const idle = fixture(); idle.prep();
  assert.equal(idle.players[1].bounties.length, 0);
  const missing = fixture({ unavailable: true });
  missing.buy(); missing.prep(); missing.result([]);
  missing.hook.onRoundStart(missing.players[0]);
  assert.deepEqual(missing.players[0].adds, [{ n: 5, reason: 'fx-kurumi:void' }]);
});

test('a 5x3 loss is never written off, even after spending all remaining cash', () => {
  const f = fixture({ mult: 3, funds: 100, round: 12 });
  f.buy(f.players[0], 'item_x_fx_kurumi_call_s5_x30'); f.prep();
  assert.equal(f.players[0].counter('kurumi:stake'), 5);
  f.players[0].spendFunds(95); f.result([{}]); f.hook.onRoundStart(f.players[0]);
  assert.equal(f.players[0].counter('kurumi:unpaidLoss'), 10);
  assert.equal(f.players[1].funds(), 40);
  const income = { income: 7, pending: 2 }; f.hook.onIncome(f.players[0], income);
  assert.deepEqual(income, { income: 0, pending: 0 });
  assert.equal(f.players[0].counter('kurumi:unpaidLoss'), 1);
});

test('legacy fractional contracts remain bounded by the 5-unit principal ceiling', () => {
  for (const denominator of [5, 4, 3, 2, 1]) for (const mult of [1, 1.5, 2, 2.5, 3]) {
    const f = fixture({ funds: 19, mult });
    f.buy(f.players[0], 'item_x_fx_kurumi_call_d' + denominator + '_x' + Math.round(mult * 10));
    const stake = Math.min(Math.floor(19 / denominator), 5);
    assert.equal(f.players[0].counter('kurumi:stake'), stake);
    assert.equal(f.players[0].counter('kurumi:mult'), Math.round(mult * 100));
    assert.equal(f.players[0].funds(), 19 - stake);
  }
  const forged = fixture();
  forged.buy(forged.players[0], 'item_x_fx_kurumi_call_d1_x50');
  assert.equal(forged.players[0].counter('kurumi:pos'), 0);
  assert.equal(forged.players[0].funds(), 10);
});

test('room weights normalize correctly, scale uniformly and cannot remove low-level protection or the high-level cap', () => {
  const sample = (round, mult, weights = {}) => {
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 1000; i++) {
      const f = fixture({ round, mult, funds: mult === 1 ? 1 : mult === 2 ? 4 : 5, weights, rolls: { strength: (i + 0.5) / 1000, low: 0.5 } });
      f.buy(); f.prep();
      counts[f.players[1].counter('kurumi:challengeLevel')]++;
    }
    return counts;
  };
  assert.deepEqual(sample(4, 1), [0, 400, 400, 200, 0, 0]);
  assert.deepEqual(sample(4, 3), [0, 250, 400, 350, 0, 0]);
  assert.deepEqual(sample(8, 3), [0, 0, 150, 400, 375, 75]);
  assert.deepEqual(sample(12, 3), [0, 0, 0, 50, 400, 550]);
  assert.deepEqual(sample(4, 2), [0, 325, 400, 275, 0, 0]);
  assert.deepEqual(sample(4, 1, { weight1: 200, weight2: 200, weight3: 200 }), sample(4, 1));
  const tilted = sample(4, 1, { weight1: 200 });
  assert.ok(Math.abs(tilted[1] / 1000 - 4 / 7) < 0.002);
  assert.ok(Math.abs(tilted[2] / 1000 - 2 / 7) < 0.002);
  assert.deepEqual(sample(12, 3, { weight4: 150 }), [0, 0, 0, 42, 500, 458]);
  assert.deepEqual(sample(12, 3, { weight4: 10, weight5: 300 }), [0, 0, 0, 222, 178, 600]);
  for (const [roll, coin] of [[0, 1], [1 / 4294967296, 2], [2 / 4294967296, 3]]) {
    const f = fixture({ round: 12, mult: 3, weights: { weight1: 10, weight2: 10, weight3: 10, weight5: 300 },
      rolls: { low: 0.01, 'low-price': roll } });
    f.buy(); f.prep();
    assert.equal(f.players[1].counter('kurumi:challengeLevel'), coin);
  }
});

test('all 56 source enemies are restored with one reviewed rating based on combat mechanics', () => {
  const data = getData();
  const keys = [...new Set(data.choices.cards.bounty.filter((c) => c.payout === 'kill' && c.rounds === 1
    && !c.multiRound && c.coin >= 1 && c.coin <= 5).map((c) => c.enemyKey))].sort();
  assert.equal(keys.length, 56);
  assert.deepEqual(Object.keys(CHALLENGE_RATINGS).sort(), keys);
  const counts = [0, 0, 0, 0, 0, 0];
  const doc = fs.readFileSync(new URL('../docs/design/enemy-grades.md', import.meta.url), 'utf8');
  for (const key of keys) {
    const { level, reason } = CHALLENGE_RATINGS[key];
    assert.ok(Number.isInteger(level) && level >= 1 && level <= 5, key);
    assert.ok(reason.length > 5, key);
    assert.ok(doc.includes('`' + key + '`') && doc.includes(reason), key + ' documented');
    counts[level]++;
    assert.equal(data.enemies[key].notCountInTotal, false, key);
  }
  assert.deepEqual(counts, [0, 1, 3, 11, 24, 17]);
  assert.equal(CHALLENGE_RATINGS.enemy_1283_sgkill_2.level, 4);
  assert.equal(CHALLENGE_RATINGS.enemy_1092_mdgint.level, 5);
  assert.equal(CHALLENGE_RATINGS.enemy_1502_crowns.level, 4);
  assert.equal(CHALLENGE_RATINGS.enemy_10081_mpplai.level, 3);
  for (const key of ['enemy_1001_bigbo', 'enemy_1272_nhtank_2']) assert.equal(CHALLENGE_RATINGS[key].level, 3);
  for (const key of ['enemy_1415_mmkabi_2', 'enemy_2005_axetro']) assert.equal(CHALLENGE_RATINGS[key].level, 4);
  for (const key of ['enemy_2001_duckmi', 'enemy_2002_bearmi', 'enemy_2085_skzjxd']) assert.equal(CHALLENGE_RATINGS[key].level, 4);
  assert.equal(CHALLENGE_RATINGS.enemy_2034_sythef.level, 3);
  assert.equal(CHALLENGE_RATINGS.enemy_2008_flking.level, 5);
});

test('each difficulty pool samples every unique eligible enemy and ignores old price, duplicates and input order', () => {
  const data = getData();
  const cards = data.choices.cards.bounty;
  for (const level of [1, 2, 3, 4, 5]) {
    const keys = Object.keys(CHALLENGE_RATINGS).filter((k) => CHALLENGE_RATINGS[k].level === level).sort();
    for (const [index, key] of keys.entries()) {
      const rolls = { low: level <= 3 ? 0 : 0.5, 'low-price': (level - 1) / 4294967296,
        strength: level === 5 ? 0.9 : 0.1, pick: index / 4294967296 };
      for (const bountyCards of [cards, [...cards].reverse().concat(cards, cards)]) {
        const f = fixture({ round: 12, mult: 3, rolls, bountyCards });
        f.buy(); f.prep();
        const challenge = f.players[1].bounties[0];
        assert.equal(challenge.enemyKey, key, `level ${level} pick ${index}`);
        assert.equal(challenge.coin, 0);
        assert.ok(challenge.name.endsWith(`（挑战${level}级）`));
        assert.equal(f.players[1].counter('kurumi:challengeLevel'), level);
      }
    }
  }
});

test('R4 never draws level 4/5 even with 3x, full stake or extreme room weights; R8 can draw the exterminator', () => {
  for (const mult of [1, 1.5, 2, 2.5, 3]) for (let i = 0; i < 101; i++) {
    const f = fixture({ mult, rolls: { strength: i / 101 }, weights: { weight4: 300, weight5: 300 } });
    f.buy(); f.prep();
    const challenge = f.players[1].bounties[0];
    assert.ok(CHALLENGE_RATINGS[challenge.enemyKey].level <= 3);
    assert.notEqual(challenge.enemyKey, 'enemy_1283_sgkill_2');
  }
  const fourth = Object.keys(CHALLENGE_RATINGS).filter((k) => CHALLENGE_RATINGS[k].level === 4).sort();
  const f = fixture({ round: 8, mult: 3, rolls: { strength: 0.8,
    pick: fourth.indexOf('enemy_1283_sgkill_2') / 4294967296 } });
  f.buy(); f.prep();
  assert.equal(f.players[1].bounties[0].enemyKey, 'enemy_1283_sgkill_2');
});

test('every mode has all five difficulty pools; disabled and unknown enemies fail closed, raw lpr does not filter', () => {
  const data = getData();
  for (const mode of Object.values(data.config.modes).filter((m) => m.inScope)) {
    for (const level of [1, 2, 3, 4, 5]) {
      const f = fixture({ round: 12, mult: 3, inactive: mode.inactiveEnemyKeys,
        rolls: { low: level <= 3 ? 0 : 0.5, 'low-price': (level - 1) / 4294967296,
          strength: level === 5 ? 0.9 : 0.1 } });
      f.buy(); f.prep();
      const key = f.players[1].bounties[0]?.enemyKey;
      assert.equal(CHALLENGE_RATINGS[key]?.level, level, mode.modeId + '/' + level);
      assert.ok(!mode.inactiveEnemyKeys.includes(key));
    }
  }
  for (const level of [1, 2, 3, 4, 5]) {
    const f = fixture({ round: 12, mult: 3, inactive: Object.keys(CHALLENGE_RATINGS),
      rolls: { low: level <= 3 ? 0 : 0.5, 'low-price': (level - 1) / 4294967296,
        strength: level === 5 ? 0.9 : 0.1 } });
    f.buy(); f.prep(); f.result([]); f.hook.onRoundStart(f.players[0]);
    assert.equal(f.players[1].bounties.length, 0);
    assert.deepEqual(f.players[0].adds, [{ n: 5, reason: 'fx-kurumi:void' }]);
  }
  for (const enemyKey of ['enemy_1283_sgkill', 'enemy_unknown']) {
    const f = fixture({ bountyCards: [{ enemyKey, coin: 1, payout: 'kill', rounds: 1 }] });
    f.buy(); f.prep();
    assert.equal(f.players[1].bounties.length, 0, enemyKey);
    assert.equal(f.players[0].counter('kurumi:void'), 1);
  }
  // Raw lpr is not the normal-round settlement rule, including when another content set overrides it.
  const enemyKey = 'enemy_1006_shield';
  for (const lpr of [0, 6, 30]) {
    const f = fixture({ rolls: { strength: 0 },
      enemyDefs: { ...data.enemies, [enemyKey]: { ...data.enemies[enemyKey], stats: { ...data.enemies[enemyKey].stats, lpr } } } });
    f.buy(); f.prep();
    assert.equal(f.players[1].bounties[0]?.enemyKey, enemyKey, 'raw lpr ' + lpr);
    assert.equal(f.players[0].counter('kurumi:void'), 0);
  }
});


test('absolute 1–5 stakes never exceed 5 and default 2x caps net profit at 10', () => {
  for (const round of [1, 2, 3, 4, 5, 8, 12, 13]) for (const funds of [1, 10, 1000]) {
    for (const stake of [1, 2, 3, 4, 5]) for (const dir of ['call', 'put']) {
      const f = fixture({ round, funds, mult: 2 });
      f.buy(f.players[0], `item_x_fx_kurumi_${dir}_s${stake}_x20`);
      assert.equal(f.players[0].counter('kurumi:stake'), Math.min(funds, stake));
      assert.ok(f.players[0].counter('kurumi:stake') * 2 <= 10);
    }
  }
  const f = fixture({ funds: 10, mult: 2 });
  f.buy(f.players[0], 'item_x_fx_kurumi_put_s3_x30');
  assert.equal(f.players[0].counter('kurumi:pos'), 0, 'forged above-room multiplier grants no position');
  assert.equal(f.players[0].funds(), 10);
});

test('Skip and timeout/no pick add no enemies or challenge announcements in consecutive rounds', () => {
  const f = fixture({ holders:[0,2] });
  for (const round of [1,2,3,4,5,8,12,13]) {
    for (const p of f.players) p.round=round;
    f.buy(f.players[0],'item_x_fx_kurumi_skip');
    f.prep();f.prep();f.hook.onBattleStart(f.players[1],{kind:'normal'});
    assert.equal(f.players[1].bounties.length,0);
    assert.ok(!f.players[0].messages.some(m=>m.includes('追加挑战')));
    assert.ok(!f.players[2].messages.some(m=>m.includes('追加挑战')));
  }
});

test('a second contract in the same round cannot spend a second 5-unit stake', () => {
  const f = fixture({ funds: 100, mult: 2 });
  f.buy(f.players[0], 'item_x_fx_kurumi_call_s5_x20');
  f.buy(f.players[0], 'item_x_fx_kurumi_put_s5_x20');
  assert.equal(f.players[0].funds(), 95);
  assert.equal(f.players[0].counter('kurumi:stake'), 5);
  assert.equal(f.players[0].counter('kurumi:pos'), 1);
});


test('management fee charges carried cash in full groups of 5, never new income or pending gains', () => {
  for (const [funds, fee] of [[0,0],[4,0],[5,1],[9,1],[10,2],[14,2],[25,5]]) {
    const f = fixture({ funds }); const income = { income: 12, pending: 7 };
    f.hook.onIncome(f.players[0], income);
    assert.equal(f.players[0].funds(), funds - fee);
    assert.deepEqual(income, { income: 12, pending: 7 });
    assert.equal(f.players[1].funds(), 40);
  }
});

test('default 5x2 loss is fully paid by escrow plus next-round 5-unit income', () => {
  const f = fixture({ funds: 5, mult: 2, round: 1 });
  f.buy(f.players[0], 'item_x_fx_kurumi_call_s5_x20'); f.prep(); f.result([{}]);
  const income = { income: 5, pending: 0 }; f.hook.onIncome(f.players[0], income);
  f.players[0].addFunds(income.income); f.players[0].round = 2; f.hook.onRoundStart(f.players[0]);
  assert.equal(f.players[0].funds(), 0);
  assert.equal(f.players[0].counter('kurumi:unpaidLoss'), 0);
  assert.equal(f.players[1].funds(), 40);
});


test('challenge uses affordable actual stake rather than the requested amount', () => {
  for (let seed=1;seed<=64;seed++) {
    const short=fixture({ seed,round:8,funds:2,mult:2 });
    const exact=fixture({ seed,round:8,funds:10,mult:2 });
    short.buy(short.players[0],'item_x_fx_kurumi_call_s5_x20');
    exact.buy(exact.players[0],'item_x_fx_kurumi_call_s2_x20');
    short.prep();exact.prep();
    assert.equal(short.players[0].counter('kurumi:stake'),2);
    assert.deepEqual(short.players[1].bounties,exact.players[1].bounties);
  }
});

test('shared target takes the highest product, even when that bet has a lower multiplier', () => {
  const shared=fixture({ holders:[0,2],mult:3,rolls:{ strength:0.36 } });
  const single=fixture({ holders:[0],mult:3,rolls:{ strength:0.36 } });
  for (const f of [shared,single]) f.buy(f.players[0],'item_x_fx_kurumi_call_s5_x10');
  shared.buy(shared.players[2],'item_x_fx_kurumi_put_s1_x30');
  shared.prep();single.prep();
  assert.equal(shared.players[1].bounties.length,1);
  assert.deepEqual(shared.players[1].bounties,single.players[1].bounties);
});


test('one player observing does not suppress another successful bet or add a second challenge', () => {
  const f=fixture({holders:[0,2],mult:2});
  f.buy(f.players[0],'item_x_fx_kurumi_call_s5_x20');
  f.buy(f.players[2],'item_x_fx_kurumi_skip');
  f.prep();f.hook.onBattleStart(f.players[1],{kind:'normal'});
  assert.equal(f.players[1].bounties.length,1);
  assert.ok(f.players[0].messages.some(m=>m.includes('追加挑战')));
  assert.ok(!f.players[2].messages.some(m=>m.includes('追加挑战')));
});


test('production seed salts and randomly selected targets follow the documented level distribution', () => {
  const cases = [
    [4, 1, [38.928571, 40, 21.071429, 0, 0]],
    [4, 5, [30.357143, 40, 29.642857, 0, 0]],
    [8, 5, [0, 20.357143, 40, 34.821429, 4.821429]],
    [12, 5, [3.333333, 3.333333, 12.654762, 36, 44.678571]],
  ];
  for (const [round, stake, expected] of cases) {
    const counts = [0, 0, 0, 0, 0, 0], targets = [0, 0, 0];
    for (let seed = 1; seed <= 10000; seed++) {
      const f = fixture({ seed, round, mult: 2, productionSeeds: true });
      f.buy(f.players[0], `item_x_fx_kurumi_call_s${stake}_x20`); f.prep();
      const seat = f.players[0].counter('kurumi:pick');
      targets[seat]++;
      counts[f.players[seat].counter('kurumi:challengeLevel')]++;
    }
    assert.equal(counts[0], 0, 'every successful bet creates a challenge');
    for (let i = 0; i < 5; i++) {
      const observed = counts[i + 1] / 100;
      assert.ok(Math.abs(observed - expected[i]) < 2.5, `R${round} stake ${stake} level ${i + 1}: ${observed}%`);
      if (expected[i] === 0) assert.equal(counts[i + 1], 0);
    }
    for (const count of targets) assert.ok(Math.abs(count / 10000 - 1 / 3) < 0.025);
  }
});
