// fx-kurumi v4.5.3 — symmetric leveraged bets on whether a seeded random player leaks.
// See README.md for current rules and [ASSUMED] balance tuning. Pure deterministic meta hooks only.
// One bounty enemy is added on the sampled field; its challenge level comes from a seeded roll + round + actual stake × leverage.
// Profit/loss = round(principal * locked multiplier). Escrow covers principal; additional losses are paid only by the bettor.
// Unpaid losses are carried to the bettor’s future income; no other player pays.

// [ASSUMED] Plugin-only difficulty ratings, NOT official bounty prices or measured leak probabilities.
// Reviewed against data/enemies.json and actual kits: durability, damage, bypass/control/summons.
// Normal settlement counts each eligible leak once, irrespective of raw lpr. Unknown enemies await review.
// See docs/design/enemy-grades.md for the complete table.
export const CHALLENGE_RATINGS = {
  enemy_1006_shield: { level: 1, reason: '低法抗、单阶段，常规法伤可处理高防御' },
  enemy_10081_mpplai: { level: 3, reason: '原始形态取消伤害，受击次数触发强化形态，阻挡则转为无法阻挡的幽灵' },
  enemy_1041_lazerd_2: { level: 2, reason: '飞行与高法抗，需要常规物理对空' },
  enemy_9006_actoxi: { level: 2, reason: '耐久中等，死亡毒雾要求分散站位' },
  enemy_10141_xdpeng_2: { level: 2, reason: '常态面板较低，但被失衡移动后可加速并无法阻挡' },
  enemy_1026_aghost: { level: 3, reason: '无法阻挡且移动较快，需要沿途输出' },
  enemy_10084_hlegle: { level: 3, reason: '飞行、高攻击与弹药交互，威胁对空输出位' },
  enemy_1299_ymkilr: { level: 3, reason: '隐匿且破隐后攻击增伤，需要可靠阻挡' },
  enemy_1404_msnip: { level: 3, reason: '隐匿、直线法伤与眩晕，可能干扰阻挡链' },
  enemy_1203_sfhu_2: { level: 3, reason: '死亡范围法伤与减攻速，并分裂出4个彩瓷茶器' },
  enemy_10097_crshd: { level: 3, reason: '正面减伤并对阻挡者造成神经损伤，需要调整攻击方向' },
  enemy_1501_demonk: { level: 3, reason: '中等偏高耐久，同时攻击两个目标' },
  enemy_1439_dslntf: { level: 4, reason: '高生命、受击加速及范围神经损伤，常规地图未必有甲壳克制' },
  enemy_1321_wdarft: { level: 4, reason: '高生命飞行单位，持续召唤枯朽之种' },
  enemy_1207_sfji_2: { level: 4, reason: '高攻高防且移动快，攻击增伤与死亡生成铁矛头' },
  enemy_10067_ftsjc: { level: 4, reason: '蓄力首击范围法伤与灼燃损伤，容易击穿前排' },
  enemy_1439_dslntf_2: { level: 4, reason: '更高生命与法抗，受击加速并持续造成范围神经损伤' },
  enemy_1272_nhtank_2: { level: 3, reason: '高防御、近战增伤与周期污染秽蚀，但攻击间隔较长、法抗低，可用法伤应对' },
  enemy_1283_sgkill_2: { level: 4, reason: '18000生命、1050攻击、800防御、45法抗叠加隐匿' },
  enemy_1170_dushld_2: { level: 4, reason: '1100防御叠加折射，物理与法术两侧都需要处理' },
  enemy_1172_dugago_2: { level: 4, reason: '折射、石像重生与转为空中单位，需要两阶段对策' },
  enemy_1062_rager_2: { level: 4, reason: '1750攻击、短攻击间隔与快移速，虽持续掉血仍可能快速破阵' },
  enemy_1364_spnaxe_2: { level: 4, reason: '高攻高防，周围死亡触发回血及叠攻，死亡留下血珀' },
  enemy_1273_stmgun_2: { level: 4, reason: '1500防御、远距离锁定与连续法术轰炸' },
  enemy_10144_xdelk_2: { level: 4, reason: '高面板，蓄力推动阻挡者，推不动时增伤眩晕' },
  enemy_10127_rkmbst_2: { level: 4, reason: '高生命、高攻击并带减伤与攻速提升，依赖特定克制' },
  enemy_1500_skulsr: { level: 4, reason: '榴弹范围破防，低血增攻，容易击穿防线' },
  enemy_1502_crowns: { level: 4, reason: '高速且可越过阻挡，需要多段阻挡或沿途输出' },
  enemy_1504_cqbw: { level: 4, reason: '炸药包范围爆发，低血时数量增加，可打击多个输出位' },
  enemy_1509_mousek: { level: 4, reason: '护盾与防御加成，针对最高和最低生命单位的范围技能' },
  enemy_1050_lslime: { level: 4, reason: '高生命高法抗，多目标灼烧、低血加速与阻挡自爆' },
  enemy_1001_bigbo: { level: 3, reason: '22000生命、1900攻击与800防御，但移动慢、攻击间隔6秒，无额外突破机制' },
  enemy_10118_ymgprc: { level: 4, reason: '50000生命、900防御与50法抗，二连击及强化攻击' },
  enemy_1092_mdgint: { level: 5, reason: '100000生命与3000攻击，单靠数值即可造成极高压力' },
  enemy_1302_ymtro_2: { level: 5, reason: '1500防御且要求阻挡数至少4，还可能装载和释放乘客' },
  enemy_1415_mmkabi_2: { level: 4, reason: '75000生命与2200攻击，但防御仅50、攻击间隔5秒，单阶段可集中物理输出' },
  enemy_10159_mntrjn: { level: 5, reason: '28000生命、移动较快且无法阻挡，还可装载乘客' },
  enemy_1511_mdrock: { level: 5, reason: '高耐久、周期屏障与永久叠攻，持续施压能力强' },
  enemy_1513_dekght: { level: 5, reason: '40000生命、1200防御与高额范围物理爆发' },
  enemy_1513_dekght_2: { level: 5, reason: '40000生命、70法抗，多目标攻击与范围爆炸箭' },
  enemy_2005_axetro: { level: 4, reason: '50000生命、持续攻击叠攻速与攻击力，但停止攻击数秒后复原，可控场或轮换阻挡' },
  enemy_2004_balloon: { level: 5, reason: '58000生命，被阻挡后升空越过防线，需要持续对空输出' },
  enemy_1516_jakill: { level: 5, reason: '双阶段、群体眩晕、形态抗性变化与近战无视防御' },
  enemy_1517_xi: { level: 5, reason: '双阶段，护盾破坏检查与巨额范围伤害' },
  enemy_1525_blkswb: { level: 5, reason: '双阶段、越过阻挡、范围攻击及清技力和限制攻击治疗' },
  enemy_1535_wlfmster: { level: 5, reason: '双阶段、减伤、恐惧持续掉血及攻速压制' },
  enemy_2003_rockman: { level: 5, reason: '75000生命、1500攻击与超长眩晕，压制输出和阻挡' },
  enemy_1512_mcmstr: { level: 5, reason: '高耐久、范围伤害，死亡自爆后出现不可阻挡的大祭司' },
  enemy_2048_smgrd: { level: 5, reason: '50000生命，持续生成国度压制攻速，并对国度中的我方造成高额物理伤害' },
  enemy_2050_smsha: { level: 5, reason: '40000生命、连锁寒冷并强化其他敌人，对整条防线产生影响' },
  enemy_2052_smgia: { level: 5, reason: '90000生命、1200攻击与周期眩晕，高耐久叠加控制' },
  enemy_2001_duckmi: { level: 4, reason: '18000生命、无法阻挡且受击后加速，要求沿途持续输出' },
  enemy_2002_bearmi: { level: 4, reason: '30000生命、2000攻击且无法被眩晕，对前排与控制方式有要求' },
  enemy_2034_sythef: { level: 3, reason: '隐匿并攻击眩晕目标，但生命8000、攻击300，基础面板较低' },
  enemy_2085_skzjxd: { level: 4, reason: '50000生命、正面物法减伤80%，需要侧后方输出' },
  enemy_2008_flking: { level: 5, reason: '全场降低我方攻击、防御和部署效率，叠加高面板与周期屏障' },
};

// 合约标记物 → 方向与仓位档（_m=半仓50%，无后缀=全仓）。单一定义：offers/cards.json 的 quote 与
// data/items.json 的 `set.contract` 必须与本表一致（plugins/fx-kurumi/test/contracts.test.js）。
export const CONTRACTS = (() => {
  /** @type {Record<string, {dir: number, tier: number, mult?: number, stake?: number, label: string}>} */
  const out = {
    item_x_fx_kurumi_call: { dir: 1, tier: 1, label: '全仓' },
    item_x_fx_kurumi_call_m: { dir: 1, tier: 0.5, label: '半仓' },
    item_x_fx_kurumi_put: { dir: -1, tier: 1, label: '全仓' },
    item_x_fx_kurumi_put_m: { dir: -1, tier: 0.5, label: '半仓' },
  };
  for (const [id, spec] of Object.entries(out)) {
    for (const mult of [1, 1.5, 2, 2.5, 3]) out[id + '_x' + Math.round(mult * 10)] = { ...spec, mult };
  }
  for (const [direction, dir] of [['call', 1], ['put', -1]]) {
    for (const denominator of [5, 4, 3, 2, 1]) for (const mult of [1, 1.5, 2, 2.5, 3]) {
      out['item_x_fx_kurumi_' + direction + '_d' + denominator + '_x' + Math.round(mult * 10)] = {
        dir, tier: 1 / denominator, mult, label: denominator === 1 ? '全仓' : '1/' + denominator + '仓',
      };
    }
  }
  for (const [dirName, dir] of [['call', 1], ['put', -1]]) {
    for (const stake of [1, 2, 3, 4, 5]) for (const mult of [1, 1.5, 2, 2.5, 3]) {
      out[`item_x_fx_kurumi_${dirName}_s${stake}_x${Math.round(mult * 10)}`] = { dir, tier: 1, stake, mult, label: stake + '元' };
    }
  }
  for (const spec of Object.values(out)) Object.freeze(spec);
  return Object.freeze(out);
})();

export default function setup(sp) {
  const BAND = 'band_x_fx_kurumi_margin';
  const SKIP = 'item_x_fx_kurumi_skip'; // 不赌卡：弃牌观望
  const K = {
    unpaid: 'kurumi:unpaidLoss', // 本人尚未补足的交易亏损，后续收入优先补足
    pos: 'kurumi:pos',       // +1 看涨 / -1 看跌 / 0 无持仓
    stake: 'kurumi:stake',   // 建仓划扣的本金
    betRound: 'kurumi:betr', // 建仓回合（抽样盐 + 播报）
    tier: 'kurumi:tier',     // 仓位档 ×10（10 全仓 / 5 半仓；播报用）
    mult: 'kurumi:mult',     // 建仓锁定的倍率 ×100，赚亏完全对称
    pick: 'kurumi:pick',     // 开战播报记录的抽中席位（结算与播报一致；-1 无记录）
    ann: 'kurumi:ann:',      // 本笔建仓回合是否已播报（按建仓回合去重）
    has: 'kurumi:obs:',      // 结算观察：该席位有记录
    leak: 'kurumi:leak:',    // 结算观察：该席位漏怪数
    challengeRound: 'kurumi:challengeRound',
    challengeLevel: 'kurumi:challengeLevel',
    void: 'kurumi:void',
    multMax: 'kurumi:multMax',
  };
  const num = (v, dflt) => (Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : dflt);
  const LEVEL_WEIGHTS = [1, 2, 3, 4, 5].map((level) => Math.min(300, Math.max(10, num(sp.settings?.['weight' + level], 100))));
  const int = (v) => (Number.isFinite(v) ? Math.trunc(v) : 0);
  const MULT_MAX = Math.min(3, Math.max(1, Number(sp.settings?.multMax) || 2));
  const STAKE_MAX = 5;
  const isBossRound = (ctx) => ctx.gd.bossRound === ctx.round || ctx.gd.hiddenRound === ctx.round;
  const mates = (ctx) => ctx.teammates().filter((t) => t.alive());
  // teammates() is available in both live and isolated preview contexts; alivePlayers() is not a preview read.
  const participants = (ctx) => [ctx, ...mates(ctx)];
  const leaksOf = (ev) => ((ev?.result?.leaked) || []).filter((l) => l && l.counted !== false).length;

  // band 派发先找 band:<id>、再回退 effectRef（band_cannot，坎诺特的利滚利处理器）。
  // 本策略没有利息被动，注册空处理器盖掉回退，避免白得坎诺特的 +1/回合。
  sp.meta.register('band:' + BAND, {});

  sp.meta.register('global:fx-kurumi:margin', {
    onRoundStart(ctx) {
      if (ctx.bandId() !== BAND) return;
      ctx.setCounter(K.multMax, MULT_MAX);
      resolve(ctx);
      collectUnpaid(ctx);
    },

    // All bets exist before the global prep deadline. Add through the existing bounty API so route choice,
    // round scaling, simulations, save/restore and the bounty's one-battle lifetime use the production path.
    onPrepEnd(ctx) {
      if (isBossRound(ctx) || int(ctx.counter(K.challengeRound)) === ctx.round) return;
      const bets = targetBets(ctx);
      if (!bets.length) return;
      // [ASSUMED] Only successful bets trigger challenges; Skip, timeout and no funds add none.
      // Shared targets never stack; difficulty follows the highest actual stake × multiplier.
      const exposure = Math.max(1, ...bets.map(p => int(p.counter(K.stake)) * int(p.counter(K.mult)) / 100));
      const draw = drawEnemy(ctx, exposure);
      const id = draw && ctx.addBounty({
        ...draw.card, effectId: 'fx-kurumi:challenge:' + ctx.round + ':' + ctx.seat,
        name: `久留美挑战：${ctx.gd.enemy(draw.card.enemyKey).name}（挑战${draw.level}级）`,
        desc: '保证金交易附加敌人，仅本场出现，不额外掉落悬赏金币。',
        // [ASSUMED] Challenge level is independent of bounty price; this enemy grants no bonus income.
        count: 1, rounds: 1, multiRound: false, coin: 0, payout: 'kill',
      });
      ctx.setCounter(K.challengeRound, ctx.round);
      ctx.setCounter(K.challengeLevel, id ? draw.level : 0);
      if (!id) for (const p of bets) p.setCounter(K.void, 1);
    },

    onBattleStart(ctx, ev) {
      if (ev?.kind !== 'normal' || isBossRound(ctx)) return;
      if (ev.preview) return;
      const level = int(ctx.counter(K.challengeLevel));
      for (const p of targetBets(ctx)) {
        const betRound = ctx.round;
        if (int(p.counter(K.ann + betRound))) continue;
        p.setCounter(K.ann + betRound, 1);
        const dir = int(p.counter(K.pos)) > 0 ? '看涨' : '看跌';
        p.ticker(`【保证金】${p.name} ${dir} ×${int(p.counter(K.mult)) / 100}：抽中 ${ctx.name}（第${ctx.seat + 1}席）`
          + (level ? `，追加挑战${level}级敌人` : '，无可用挑战敌人，合约作废'));
      }
    },

    onGain(ctx, ev) {
      const id = ev?.piece?.id;
      if (ctx.bandId() !== BAND) {
        // 非本策略：合约作废（静默回收）
        if (CONTRACTS[id] || id === SKIP) ctx.destroyPiece(ev.piece.uid);
        return;
      }
      if (id === SKIP) { // 不赌：弃牌观望（已有持仓时静默销毁，防御）
        ctx.destroyPiece(ev.piece.uid);
        if (!int(ctx.counter(K.pos))) ctx.toast('【保证金】本期不赌，观望', 'info');
        return;
      }
      const spec = CONTRACTS[id];
      if (!spec) return;
      const MULT = spec.mult ?? 2; // Legacy unversioned contracts retain the old 2x default.
      if (MULT > MULT_MAX) { ctx.destroyPiece(ev.piece.uid); return; }
      if (int(ctx.counter(K.pos))) { ctx.destroyPiece(ev.piece.uid); return; } // 已有持仓：防御
      if (isBossRound(ctx)) {
        ctx.destroyPiece(ev.piece.uid);
        ctx.toast('【保证金】Boss 回合休市，合约作废', 'warn');
        return;
      }
      // Requested and actual principal are capped at 5 and paid from the bettor’s cash.
      const requested = Math.min(STAKE_MAX, spec.stake ?? STAKE_MAX, Math.floor(ctx.funds() * spec.tier));
      const S = requested;
      if (S <= 0) {
        ctx.destroyPiece(ev.piece.uid);
        ctx.toast('【保证金】资金不足，本期未建仓', 'warn');
        return;
      }
      if (!ctx.spendFunds(S)) return;
      const sampled = drawSample(ctx, ctx.round);
      ctx.setCounter(K.pos, spec.dir);
      ctx.setCounter(K.stake, S);
      ctx.setCounter(K.tier, Math.round(spec.tier * 10));
      ctx.setCounter(K.mult, Math.round(MULT * 100));
      ctx.setCounter(K.void, 0);
      ctx.setCounter(K.betRound, ctx.round);
      ctx.setCounter(K.pick, sampled ? sampled.seat : -1);
      for (let s = 0; s < 8; s++) { // 清掉上一笔的结算观察
        ctx.setCounter(K.has + s, 0);
        ctx.setCounter(K.leak + s, 0);
      }
      ctx.destroyPiece(ev.piece.uid);
      ctx.toast(`【保证金】${spec.dir > 0 ? '看涨' : '看跌'}·${spec.label}：押 ${S} ×${MULT}，押对净赚 ${Math.round(S * MULT)}，押错净亏 ${Math.round(S * MULT)}`, 'info');
    },

    // 全房每份战斗结算都会派发到这里（global key）：给每个持仓中的久留美记录抽签用的观察。
    onBattleResult(ctx, ev) {
      const leaks = leaksOf(ev);
      const players = participants(ctx);
      for (const k of players) {
        if (k.bandId() !== BAND || !int(k.counter(K.pos))) continue;
        k.setCounter(K.has + ctx.seat, 1);
        k.setCounter(K.leak + ctx.seat, leaks);
      }
    },

    onIncome(ctx, ev) {
      if (ctx.bandId() !== BAND) return;
      const cashPaid = collectUnpaid(ctx);
      // [ASSUMED] Fee is charged on carried cash only, BEFORE this round’s income/pending funds and trade settlement.
      const carried = Math.max(0, Math.floor(ctx.funds()));
      const fee = Math.floor(carried / 5);
      if (fee > 0 && ctx.spendFunds(fee)) ctx.toast(`【保证金】留存管理费 ${fee}（留存资金 ${carried}）`, 'info');
      let unpaid = int(ctx.counter(K.unpaid));
      const beforeIncome = unpaid;
      for (const key of ['income', 'pending']) {
        if (unpaid <= 0) break;
        const amount = Math.min(unpaid, Math.max(0, int(ev[key])));
        if (amount > 0) { ev[key] -= amount; unpaid -= amount; }
      }
      ctx.setCounter(K.unpaid, unpaid);
      const paid = cashPaid + beforeIncome - unpaid;
      if (paid > 0) ctx.toast(`【保证金】补扣待补亏损 ${paid}（尚欠 ${unpaid}）`, 'info');
    },
  });

  function collectUnpaid(ctx) {
    const owed = Math.max(0, int(ctx.counter(K.unpaid)));
    const paid = Math.min(owed, Math.max(0, Math.floor(ctx.funds())));
    if (paid > 0 && ctx.spendFunds(paid)) {
      ctx.setCounter(K.unpaid, owed - paid);
      return paid;
    }
    return 0;
  }

  /** 结算/播报共用的确定性抽样：全房间存活玩家按座位号排序，对局种子取模（不消耗 rng 流）。 */
  function drawSample(ctx, betRound) {
    const pool = participants(ctx).sort((a, b) => a.seat - b.seat);
    if (!pool.length) return null;
    const roll = int(ctx.seedFor('fx-kurumi:sample:' + int(betRound) + ':' + ctx.seat)) >>> 0;
    return pool[roll % pool.length];
  }

  function targetBets(ctx) {
    return participants(ctx).filter((p) => p.bandId() === BAND && int(p.counter(K.pos))
      && int(p.counter(K.betRound)) === ctx.round && int(p.counter(K.pick)) === ctx.seat);
  }

  function drawEnemy(ctx, exposure) {
    const salt = 'fx-kurumi:enemy:' + ctx.round + ':' + ctx.seat;
    const roll = (int(ctx.seedFor(salt + ':strength')) >>> 0) / 4294967296;
    // Late rounds keep an independent 10% low-level branch at EVERY leverage. Legacy seed salts are retained.
    // Equal actual stake × multiplier uses the same stage distribution and seed salts.
    const lowBranch = ctx.round >= 12 && (int(ctx.seedFor(salt + ':low')) >>> 0) / 4294967296 < 0.1;
    const level = lowBranch ? 1 + (int(ctx.seedFor(salt + ':low-price')) >>> 0) % 3
      : weightedLevel(ctx.round, exposure, roll);
    const seen = new Set();
    const pool = ((ctx.data.choices?.cards?.bounty) || []).filter((c) => {
      if (c.payout !== 'kill' || c.rounds !== 1 || c.multiRound || c.coin < 1 || c.coin > 5) return false;
      if (CHALLENGE_RATINGS[c.enemyKey]?.level !== level) return false;
      const enemy = ctx.gd.enemy(c.enemyKey);
      if (!enemy || enemy.notCountInTotal === true
        || ctx.gd.inactiveEnemies?.has(c.enemyKey) || seen.has(c.enemyKey)) return false;
      seen.add(c.enemyKey);
      return true;
    }).sort((a, b) => a.enemyKey < b.enemyKey ? -1 : a.enemyKey > b.enemyKey ? 1 : 0);
    if (!pool.length) return null; // [ASSUMED] Void, rather than silently resampling a different level.
    return { level, card: pool[(int(ctx.seedFor(salt + ':pick')) >>> 0) % pool.length] };
  }

  function weightedLevel(round, exposure, roll) {
    // [ASSUMED] Retain the stage endpoints; interpolate risk using actual principal × multiplier (1–15).
    const base = [[40, 40, 20, 0, 0], [0, 30, 40, 30, 0], [0, 0, 20, 40, 40]];
    const leveraged = [[25, 40, 35, 0, 0], [0, 15, 40, 37.5, 7.5], [0, 0, 5, 40, 55]];
    const progress = Math.max(0, Math.min(2, (round - 4) / 4));
    const left = Math.floor(progress), right = Math.min(2, left + 1), phaseMix = progress - left;
    const leverageMix = (Math.min(15, Math.max(1, exposure)) - 1) / 14;
    const weights = base[left].map((v, i) => {
      const a = v + (leveraged[left][i] - v) * leverageMix;
      const b = base[right][i] + (leveraged[right][i] - base[right][i]) * leverageMix;
      return (a + (b - a) * phaseMix) * LEVEL_WEIGHTS[i];
    });
    let total = weights.reduce((sum, w) => sum + w, 0);
    // [ASSUMED] Limit the ordinary branch's level-5 probability to 60%, including custom room weights.
    // The independent 10% low-level branch then limits late-game level-5 draws to 54%.
    if (weights[4] > total * 0.6) {
      weights[4] = (total - weights[4]) * 1.5;
      total = weights.reduce((sum, w) => sum + w, 0);
    }
    let point = roll * total, last = 1;
    for (let i = 0; i < weights.length; i++) {
      if (weights[i] > 0) last = i + 1;
      if (point < weights[i]) return i + 1;
      point -= weights[i];
    }
    return last;
  }

  /** 上一回合的对赌结算（onRoundStart：上一场战斗的结算观察已全部落账）。 */
  function resolve(ctx) {
    const pos = int(ctx.counter(K.pos));
    if (!pos) return;
    const S = int(ctx.counter(K.stake));
    // 抽中者：开战播报记录的席位（K.pick，播报与结算永远一致）；无记录（边缘）才按同一确定性抽样重抽。
    let sampledSeat = int(ctx.counter(K.pick));
    if (sampledSeat < 0 || sampledSeat > 7) {
      const sampled = drawSample(ctx, int(ctx.counter(K.betRound)));
      sampledSeat = sampled ? sampled.seat : 0;
    }
    let leaks;
    if (!int(ctx.counter(K.void)) && int(ctx.counter(K.has + sampledSeat))) {
      leaks = int(ctx.counter(K.leak + sampledSeat));
    } else {
      // [ASSUMED] Missing results void the contract; absence is neither a leak nor a free bearish win.
      ctx.addFunds(S, 'fx-kurumi:void');
      ctx.setCounter(K.pos, 0);
      ctx.setCounter(K.stake, 0);
      ctx.setCounter(K.mult, 0);
      ctx.setCounter(K.pick, -1);
      ctx.toast('【保证金】挑战不可用或抽中玩家无结算记录，合约作废，退回本金', 'warn');
      return;
    }
    const won = pos > 0 ? leaks === 0 : leaks > 0;
    const amount = Math.round(S * int(ctx.counter(K.mult)) / 100);
    const delta = won ? amount : -amount;
    const sampleName = participants(ctx).find((p) => p.seat === sampledSeat)?.name || `第${sampledSeat + 1}席`;
    const sampleDesc = `抽中 ${sampleName}（第${sampledSeat + 1}席）${leaks > 0 ? `漏 ${leaks}` : '无漏'}`;
    if (won) {
      // Principal + symmetric profit. No fee is minted or deducted: +/- amount must stay identical.
      const back = S + delta;
      if (back > 0) ctx.addFunds(back, 'fx-kurumi:win');
      ctx.toast(`【保证金】押中！${sampleDesc}，净赚 ${delta}（含本金返还 ${back}）`, 'info');
    } else {
      // Principal was escrowed. Only this player's cash/current income pays the remaining loss.
      const extra = Math.max(0, amount - S);
      ctx.setCounter(K.unpaid, int(ctx.counter(K.unpaid)) + extra);
      collectUnpaid(ctx);
      const unpaid = int(ctx.counter(K.unpaid));
      ctx.toast(`【保证金】押错！${sampleDesc}，净亏 ${amount}`
        + (unpaid > 0 ? `，待补亏损 ${unpaid}，后续收入优先补足` : ''), 'warn');
    }
    ctx.setCounter(K.pos, 0);
    ctx.setCounter(K.stake, 0);
    ctx.setCounter(K.mult, 0);
    ctx.setCounter(K.pick, -1);
  }
}
