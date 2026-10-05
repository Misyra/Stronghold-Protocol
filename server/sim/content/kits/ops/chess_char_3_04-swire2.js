// server/sim/content/kits/ops/chess_char_3_04-swire2.js — 琳琅诗怀雅 (char_1033_swire2) kit, tier 3.
// Conventions of the tier-3 kits: ../shared/tier3.js; kit contract and rules: ../README.md.

import { COLS } from '../../../constants.js';
import { bodyOnTile } from '../../../body.js';
import {
  num, defOf, talentBb, moduleTalentBb, selectedId, altSkills, alive, gridKeys, fx, copyGrid, textNum, freeTile,
  groundTile, enemiesOn,
} from '../shared/tier3.js';

/** 琳琅诗怀雅 S3's coin range (PRTS 备注 "前方范围2-4"; range_table "2-4", facing right). */
const SWIRE2_COIN_GRID = Object.freeze([[1, 1], [0, 0], [0, 1], [0, 2], [-1, 1]]);

/** Merchant trait with a callback on every successful DP payment (琳琅诗怀雅 大买家). Same rules as professions.js. */
function merchantInstall(onPay) {
  return (battle, unit) => {
    const iv = unit.profile.merchantInterval ?? 3;
    const cost = unit.profile.merchantCost ?? 3;
    battle.every(iv, () => {
      if (!alive(unit)) return;
      const pl = battle.getPlayer(unit.ownerId);
      if (!pl) return;
      if (pl.dp >= cost) {
        battle.addDp(unit.ownerId, -cost);
        onPay(battle, unit, cost);
        battle.emit('merchantPay', { unit, cost });
      } else battle.retreat(unit, { reason: 'merchant' });
    }, { owner: unit });
  };
}

export default {
  // ---- 3_04 琳琅诗怀雅 · 行商 — S2 “见面礼” (passive): each attack spends a coin to drop a champagne bomb in range;
  //      大买家: coin at skill start + coin & ATK stack per trait payment; 破财消灾: DP-paid revive (cost doubles)
  //      S1 仗义疏财 (passive, 2 coins): a coin heals the most injured ally (< 70 % HP) of the 8 surrounding tiles for
  //      attack@heal_scale × ATK — on her attack, or with no enemy to attack on her own attack timer (owner's decision
  //      2026-10-04, against the official 「下一次攻击会为…」; installS1). S3 千金一掷 (持续时间无限): attacks hit twice, kills give a coin;
  //      closing it spends every coin on random ground enemies of range 2-4 in front and those she blocks (atk_scale phys +
  //      a small push, radial despite the text's 向前 — PRTS 备注 "推开效果为径向推动"; client charpack char_1033_swire2:
  //      the RandomGold ability (Skill_3_End) carries swire2_s_3[knockback] of template knockback[relative]; 地面敌方单位,
  //      弹道不可对空). It does not close itself when the purse is full (PRTS 卫戍协议/帮助 「通常不会自动关闭技能」; the skill
  //      text is 「可随时主动关闭」). Owner 2026-10-04: at the cap (金币上限为10) she shoots once an enemy is in the skill's
  //      attack range (the 1-tile range, not the coin-mark 2-4 grid). Below the cap, or with nobody there, it stays open.
  //      精锐 module MER-Y: ATK +4 % per trait payment (≤ 5 stacks).
  chess_char_3_04_a: (bb, chess, def) => {
    const d = defOf(chess, def);
    const t0 = talentBb(d, 0), t1 = talentBb(d, 1);
    const sel = selectedId(chess, d);
    const S1 = 'skchr_swire2_1', S2 = 'skchr_swire2_2', S3 = 'skchr_swire2_3';
    // "携带此技能时金币上限为N": the SELECTED skill's cap
    const coinMax = num(bb.sp, 3);
    const coinCost = Math.abs(num(bb['attack@sp'], -1)) || 1;
    const modTal = moduleTalentBb(chess);
    const scale = num(bb.atk_scale, 1);
    const slug = num(bb.sluggish, 2);
    const tokenId = chess?.skill?.overrideTokenKey ?? (d.tokens || []).find((t) => /gdtrap/.test(String(t))) ?? 'token_10031_swire2_gdtrap';
    const skillGrid = copyGrid(d.skill?.rangeGrid);
    const addCoins = (battle, unit, n) => {
      const before = unit.mem.coins ?? 0;
      unit.mem.coins = Math.min(coinMax, before + n);
      if (unit.mem.coins > before) fx(battle, 'coin', unit, { n: unit.mem.coins });
    };
    const bombKit = (owner, switchT) => ({
      skill: null,
      trait: { noAttack: true },
      install(battle, bomb) {
        battle.on('tick', () => {
          if (!bomb.alive || !bomb.deployed) return;
          for (const e of battle.enemies) {
            if (!e.alive || e.hidden || e.isFlying || e.s.flags.untargetable) continue;
            if (!bodyOnTile(e, bomb.tileR, bomb.tileC)) continue;
            // first enemy touching it; after switchT s on the field the bomb deals its damage one extra time
            const hits = battle.time - bomb.deployedAt >= switchT - 1e-9 ? 2 : 1;
            for (let i = 0; i < hits && e.alive; i++) {
              battle.dealDamage(owner, e, { amount: owner.s.atk * scale, type: 'phys', isSkill: true, canDodge: false, tags: ['skill', 'trap'] });
            }
            if (e.alive) battle.applyStatus(e, 'sluggish', { duration: slug, source: owner });
            // `consumed`: the bomb is used up by its own blast — clients play its impact sound, not a death sound
            fx(battle, 'explode', bomb, { src: owner.id, target: e.id, hits, consumed: true });
            battle.retreat(bomb, { reason: 'expired', permanent: true });
            break;
          }
        }, { owner: bomb });
      },
    });
    const healRatio = textNum(d.skill?.description, /血量不足(\d+)%/, 70) / 100;
    /**
     * 仗义疏财 — official text 「消耗一枚金币，下一次攻击会为周围八格内血量不足70%的一名友方单位恢复相当于攻击力40%的生命」: the heal rides on an
     * attack, so with no enemy around she never healed (community report #5 「琳琅诗怀雅1技能不会主动奶身边受伤的干员」). Owner's
     * decision 2026-10-04 (a deliberate deviation, like §21.29's 重装 casts): she heals an injured ally beside her whether
     * she attacks or not. Same target (the lowest HP ratio below 70 % of the 8 surrounding tiles, no 禁疗 / 孤立 unit, no
     * device), coin and heal_scale × ATK. Cadence [ASSUMED]: at most one heal per attack cycle (her attack interval, ASPD
     * included) — while she attacks, on the attack as before; when her last attack attempt found no target, on her own
     * timer (the 'tick' hook runs after the attacks, so an attack due in the same tick takes it).
     */
    const installS1 = (battle, unit) => {
      const hs = num(bb['attack@heal_scale'], num(bb.heal_scale, 0));
      let nextAt = -Infinity;
      const healTarget = () => {
        let best = null;
        for (const a of battle.allyUnits) {
          if (a === unit || !alive(a) || a.hidden || a.kind === 'device' || a.hpRatio >= healRatio) continue;
          if (a.s.flags.noHeal || a.profile?.noHeal) continue; // 禁疗 / 孤立: never a heal target
          if (Math.max(Math.abs(a.tileR - unit.tileR), Math.abs(a.tileC - unit.tileC)) !== 1) continue; // 周围八格
          if (!best || a.hpRatio < best.hpRatio || (a.hpRatio === best.hpRatio && a.deploySeq < best.deploySeq)) best = a;
        }
        return best;
      };
      const tryHeal = () => {
        if (!alive(unit) || (unit.mem.coins ?? 0) < coinCost || !(hs > 0) || battle.time < nextAt - 1e-9) return;
        const best = healTarget();
        if (!best) return;
        unit.mem.coins -= coinCost;
        nextAt = battle.time + unit.s.interval;
        battle.heal(unit, best, unit.s.atk * hs);
        fx(battle, 'coin', unit, { n: unit.mem.coins, heal: best.id, skill: 'swire2_1' });
      };
      battle.on('attack', (ctx) => { if (ctx.attacker === unit) tryHeal(); }, { owner: unit, priority: -10 });
      battle.on('tick', () => { if (unit.deployed && unit.canAct && !unit.trait?.hadTarget) tryHeal(); }, { owner: unit });
    };
    const installS3 = (battle, unit) => { // 千金一掷: "击倒敌人时获得一枚金币"
      battle.on('kill', (ctx) => {
        if (ctx.killer === unit && ctx.victim.side === 'enemy' && unit.skill?.active) addCoins(battle, unit, 1);
      }, { owner: unit });
    };
    return {
      skill: { kind: 'passive' },
      skills: altSkills(chess, d, bb, {
        [S1]: () => ({ kind: 'passive' }), // (coins → heals: installS1)
        [S3]: (s) => {
          const cash = num(s.bb.atk_scale, 1), force = num(s.bb.force, 0);
          // the 【金币标记】 targets: ground enemies on range 2-4 in front of her (range_table "2-4") and every unit she blocks
          const coinMarks = (battle, unit) => {
            const list = enemiesOn(battle, unit, gridKeys(SWIRE2_COIN_GRID, unit), 0, { ...unit.profile, canHitFly: false });
            for (const e of unit.blocking || []) if (e.alive && !e.isFlying && !list.includes(e)) list.push(e);
            return list;
          };
          const purseCap = Math.max(1, Math.floor(num(s.bb.sp, 10)));
          return {
            kind: 'toggle',
            attack: { hits: 2 },
            // Owner 2026-10-04: at the cap, shoot once a ground enemy is in the skill attack range (data rangeGrid,
            // the same 1-tile range as her attack). The coin marks (前方 2-4) are who the burst pays, not the trigger.
            // Nobody in that range: stay open and keep the coins. Below the cap: stay open.
            onTick({ battle, unit, skill }) {
              if (!skill.active || (unit.mem.coins ?? 0) + 1e-9 < purseCap) return;
              const keys = gridKeys(skillGrid ?? unit.rangeGrid, unit);
              if (enemiesOn(battle, unit, keys, 0, { ...unit.profile, canHitFly: false }).length) skill.end('manual');
            },
            onEnd({ battle, unit, reason }) {
              if (reason !== 'manual' || !unit.alive) return;
              const n = unit.mem.coins ?? 0;
              unit.mem.coins = 0;
              let spent = 0;
              // PRTS 备注: closing it "立即对前方范围2-4内的地面敌方单位与自身阻挡的所有单位施加【金币标记】", the coins going to
              // marked units at random — 弹道（不可对空）: air units (FLY, 近地悬浮, 浮空) are never paid. Until 0.1.1 the
              // coins went to her attack range (1-1) instead of range 2-4.
              const marked = coinMarks(battle, unit);
              for (let i = 0; i < n; i++) {
                const e = battle.rng.pick(marked.filter((x) => x.alive && !x.isFlying));
                if (!e) break;
                spent++;
                battle.dealDamage(unit, e, { amount: unit.s.atk * cash, type: 'phys', isSkill: true, tags: ['skill', 'swire2Cash'] });
                // "将目标小力地向前推开" — PRTS 备注 "金币弹道…推开效果为径向推动", client knockback[relative]: a radial push
                // away from her centre (not along her direction, so no 45° / 0.25-tile 特殊修正), official 力度 − 重量
                // distance (Battle.push)
                if (e.alive) battle.push(e, force, { from: unit });
              }
              fx(battle, 'coin', unit, { n: 0, spent, skill: 'swire2_3' });
            },
          };
        },
      }),
      trait: { install: merchantInstall((battle, unit) => {
        // MER-Y "每次特性消耗费用时攻击力+4%，最多可以叠加5次" (any time, not only during the skill)
        if (modTal && num(modTal.atk) > 0) {
          battle.addBuff(unit, { key: 'trait:swire2_module', refresh: 'stack', stacks: 1, maxStacks: Math.max(1, num(modTal.max_stack_cnt, 5)), mods: { atkPct: num(modTal.atk) } });
        }
        if (!unit.skill?.active) return; // "技能期间"
        addCoins(battle, unit, num(t0.trait_sp, 1));
        battle.addBuff(unit, { key: 'talent:swire2_buyer', refresh: 'stack', stacks: 1, maxStacks: Math.max(1, num(t0.max_stack_cnt, 8)), mods: { atkPct: num(t0.atk) } });
      }) },
      install(battle, unit) {
        if (sel === S1) { installS1(battle, unit); return; }
        if (sel === S3) { installS3(battle, unit); return; }
        if (sel !== S2 && sel != null) return;
        const switchT = num(battle.tokenDef(tokenId, unit)?.skill?.bb?.duration_switch, 3);
        battle.on('attack', (ctx) => {
          if (ctx.attacker !== unit || !alive(unit) || (unit.mem.coins ?? 0) < coinCost) return;
          const tiles = [];
          for (const k of gridKeys(skillGrid ?? unit.rangeGrid, unit)) {
            const r = (k / COLS) | 0, c = k % COLS;
            // (never on the home tile of a dead operator: it could not redeploy until an enemy triggers the bomb)
            if (freeTile(battle, r, c) && groundTile(battle, r, c)) tiles.push([r, c]);
          }
          const tile = battle.rng.pick(tiles);
          if (!tile) return;
          const bomb = battle.spawnToken(unit, tokenId, tile[0], tile[1], { untargetable: true, kit: bombKit(unit, switchT) });
          if (!bomb) return;
          unit.mem.coins -= coinCost;
          fx(battle, 'summon', bomb, { src: unit.id, token: tokenId, coins: unit.mem.coins });
        }, { owner: unit, priority: -10 });
      },
      talents: [
        { install(battle, unit) { // 大买家: "开启技能时获得1枚金币" (a passive starts at every deployment, S3 when cast)
          battle.on('deploy', (ctx) => {
            if (ctx.unit !== unit) return;
            unit.mem.coins = 0;
            if (unit.skill?.kind === 'passive') addCoins(battle, unit, num(t0.sp, 1));
          }, { owner: unit });
          battle.on('skillStart', (ctx) => { if (ctx.unit === unit && unit.skill?.kind !== 'passive') addCoins(battle, unit, num(t0.sp, 1)); }, { owner: unit });
        } },
        { install(battle, unit) { // 破财消灾
          battle.on('fatal', (ctx) => {
            if (ctx.unit !== unit || ctx.prevented) return;
            const n = unit.mem.saveCount ?? 0;
            const cost = Math.abs(num(t1.cost, -5)) * Math.pow(num(t1.cost_multi, 2), n);
            const pl = battle.getPlayer(unit.ownerId);
            if (!pl || pl.dp + 1e-9 < cost) return;
            battle.addDp(unit.ownerId, -cost);
            unit.mem.saveCount = n + 1;
            ctx.prevented = true;
            unit.hp = Math.max(1, unit.s.maxHp * num(t1.hp_ratio, 0.7));
            fx(battle, 'revive', unit, { cost });
          }, { owner: unit });
        } },
      ],
    };
  },
};
