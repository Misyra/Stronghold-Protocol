// server/sim/content/kits/ops/chess_char_3_19-vigil.js — 伺夜 (char_427_vigil) kit, tier 3.
// Conventions of the tier-3 kits: ../shared/tier3.js; kit contract and rules: ../README.md.

import { num, defOf, talentBb, selectedId, altSkills, alive, fx, textNum, tacticalPoint } from '../shared/tier3.js';

/** Tokens `tokenId` summoned by / placed for `owner` (board pieces included). */
const tokensOf = (battle, owner, tokenId) => battle.allyUnits.filter((t) => t.kind === 'token' && t.defId === tokenId && t.ownerUnit === owner && !t.mem.isClone);

export default {
  // ---- 3_19 伺夜 · 战术家 — the tactical reinforcement is the wolf pack (狼群领袖: 2 wolves, +1 every 25 s up to 3, each
  //      wolf = +1 block and one more bite, a wolf is lost instead of the pack dying); 狼群天性: DEF ignore vs pack-blocked
  //      enemies; S3 领袖的尊严: DP over time, 三连击, bonus arts vs pack-blocked enemies; 精锐 module: pack takes less
  //      damage from the enemies it blocks (token module talent). A 狼群 piece placed in the prep phase is the pack.
  //      S1 领袖的呼唤 (ALWAYS): +cost DP and one more “狼影” (≤ the talent's maximum); S2 领袖的馈赠: +cost DP, the pack
  //      recovers hp_ratio of its max HP and its next attack hits ×atk_scale — a kill by that attack gives +cost DP.
  //      精锐 module TAC-Y: trait ×165 % (profession layer) and "援军阻挡的敌人更容易受到我方的攻击": the pack's token module
  //      talent taunt_level (+1) goes to the enemies it blocks — the enemy-side 嘲讽等级 our operators target first
  //      (targeting.js; research 05: "更容易受到我方的攻击" = enemy taunt.taunt_level), never to the pack itself.
  chess_char_3_19_a: (bb, chess, def) => {
    const d = defOf(chess, def);
    const sel = selectedId(chess, d);
    const t0 = d.talents?.[0] ?? {}, t1 = talentBb(d, 1);
    const wolfId = t0.tokenKey ?? (d.tokens || []).find((t) => /wolf/.test(String(t))) ?? 'token_10028_vigil_wolf';
    const initial = textNum(t0.description, /初始(\d+|[一二两三四五])只/, 2);
    const maxWolves = textNum(t0.description, /至多(\d+|[一二两三四五])只/, 3);
    const hits = textNum(d.skill?.description, /(\d+|[一二两三四五])连击/, 3);
    const bonus = num(bb['attack@vigil_s_3.atk_scale'], 0);
    const pen = num(t1.def_penetrate_fixed, 0);
    const wolfOf = (u) => (u.trait.reinforcement && u.trait.reinforcement.alive ? u.trait.reinforcement : null);
    const wolfKit = (vigil) => ({
      skill: null,
      trait: { hitsFn: (b, w) => Math.max(1, w.mem.wolves || 1) },
      install(battle, w) {
        const tal = w.def.talents || [];
        const wb = tal[0]?.bb ?? {};
        const per = num(wb.block_cnt, num(wb['vigil_wolf_t_1_enhance[trigger].block_cnt'], 1));
        const grow = num(wb.interval, num(wb['vigil_wolf_t_1_enhance[trigger].interval'], 25));
        // (mem.shadows mirrors the count for content reading tokens.js wolfShadows())
        const apply = () => { w.mem.shadows = w.mem.wolves; battle.addBuff(w, { key: 'token:wolves', mods: { blockCnt: per * w.mem.wolves }, allowDead: true }); };
        w.mem.wolves = Math.max(1, Math.min(maxWolves, initial));
        apply();
        w.mem.addWolf = () => {
          if (!w.alive || w.mem.wolves >= maxWolves) return false;
          w.mem.wolves++;
          apply();
          fx(battle, 'summon', w, { src: vigil.id, wolves: w.mem.wolves });
          return true;
        };
        battle.every(grow, () => w.mem.addWolf(), { owner: w });
        battle.on('fatal', (ctx) => {
          if (ctx.unit !== w || ctx.prevented || w.mem.wolves <= 1) return;
          w.mem.wolves--;
          apply();
          ctx.prevented = true;
          w.hp = w.s.maxHp;
          fx(battle, 'revive', w, { wolves: w.mem.wolves });
        }, { owner: w });
        const mod = tal.find((t) => t && t.bb && t.bb.damage_scale != null);
        if (mod) {
          battle.on('hit', (ctx) => {
            if (ctx.target === w && ctx.source && ctx.source.blockedBy === w) ctx.dmg.mul *= num(mod.bb.damage_scale, 1);
          }, { owner: w });
        }
      },
    });
    // TAC-Y token module talent (taunt_level) of the pack — whichever kit runs it (this one or a tokens.js board piece):
    // the enemies it blocks carry that taunt level while they stay blocked (short refreshed buff: nothing lingers when
    // the pack or 伺夜 leaves)
    const packTaunt = (w) => {
      if (w.mem.packTaunt == null) {
        const t = (w.def?.talents || []).find((x) => x && x.bb && x.bb.taunt_level != null);
        w.mem.packTaunt = t ? num(t.bb.taunt_level) : 0;
      }
      return w.mem.packTaunt;
    };
    const installPackMark = (battle, unit) => {
      let cur = new Set();
      const levelOf = (w) => (w && alive(w) && alive(unit) ? packTaunt(w) : 0);
      const mark = (e, w, lvl) => battle.addBuff(e, { key: 'token:pack_mark', duration: 0.25, refresh: 'extend', mods: { taunt: lvl }, source: w, visible: true });
      // at once when the pack blocks (the operators attacking this tick already see it), kept / dropped every 0.1 s
      battle.on('blocked', (ctx) => {
        const w = wolfOf(unit), lvl = ctx.blocker === w ? levelOf(w) : 0;
        if (lvl && ctx.enemy.alive) { mark(ctx.enemy, w, lvl); cur.add(ctx.enemy); }
      }, { owner: unit });
      battle.every(0.1, () => {
        const w = wolfOf(unit);
        const lvl = levelOf(w);
        const next = new Set();
        if (lvl) {
          for (const e of w.blocking) {
            if (!e.alive || e.side !== 'enemy' || e.blockedBy !== w) continue;
            mark(e, w, lvl);
            next.add(e);
          }
        }
        for (const e of cur) {
          if (next.has(e)) continue;
          const b = e.findBuff('token:pack_mark');
          if (b) battle.removeBuff(e, b);
        }
        cur = next;
      }, { owner: unit, immediate: true });
    };
    /** One more “狼影” (S1): this kit's pack, or a 狼群 board piece run by content/tokens.js (same 'wolf:shadows' buff). */
    const addShadow = (battle, vigil, w) => {
      if (typeof w.mem.addWolf === 'function') return w.mem.addWolf();
      const n = Math.max(1, w.mem.shadows ?? 1);
      if (n >= maxWolves) return false;
      const wb = w.def?.talents?.[0]?.bb ?? {};
      const per = num(wb['vigil_wolf_t_1_enhance[trigger].block_cnt'], num(wb.block_cnt, 1));
      w.mem.shadows = n + 1;
      battle.addBuff(w, { key: 'wolf:shadows', persist: true, allowDead: true, refresh: 'replace', mods: { blockCnt: w.mem.shadows * per } });
      fx(battle, 'summon', w, { src: vigil.id, wolves: w.mem.shadows });
      return true;
    };
    const dpGain = (battle, unit, n) => { if (n > 0) { battle.addDp(unit.ownerId, n); fx(battle, 'dp', unit, { n }); } };
    // S2: the pack's empowered next attack (armed by the cast; ×scale on its hits; a kill pays once)
    const installGift = (battle, unit) => {
      battle.on('tick', () => { // the cast: ready, the pack on the field, no unused gift on it (PRTS 备注)
        const sk = unit.skill, w = wolfOf(unit);
        if (!alive(unit) || !sk || !sk.ready || sk.active || !unit.canAct || unit.s.flags.silence || !w || w.mem.vigilGift) return;
        sk.activate('SP_FULL');
      }, { owner: unit });
      battle.on('beforeAttack', (ctx) => {
        const w = wolfOf(unit);
        if (!w || ctx.attacker !== w || !w.mem.vigilGift) return;
        w.mem.vigilGiftOn = w.mem.vigilGift;
        w.mem.vigilGift = null;
      }, { owner: unit, priority: -100 });
      battle.on('hit', (ctx) => {
        const g = ctx.source?.mem?.vigilGiftOn;
        if (g && ctx.dmg.isAttack && ctx.source === wolfOf(unit)) ctx.dmg.mul *= g.scale;
      }, { owner: unit });
      battle.on('kill', (ctx) => {
        const g = ctx.killer?.mem?.vigilGiftOn;
        if (!g || g.paid || ctx.victim.side !== 'enemy' || ctx.killer !== unit.trait.reinforcement) return;
        g.paid = true;
        dpGain(battle, unit, g.dp);
      }, { owner: unit });
      battle.on('attack', (ctx) => { if (ctx.attacker?.mem?.vigilGiftOn && ctx.attacker === unit.trait.reinforcement) ctx.attacker.mem.vigilGiftOn = null; }, { owner: unit });
    };
    return {
      trait: { install(battle, unit) {
        // The pack is the tactician's 援军. The match also hands the player the 狼群 token to place in the prep phase
        // (= choosing the tactical point): that board piece (tokens.js kit, owner-coupled effects left to this kit) is
        // the pack when present — deployed early on its own tile if 伺夜 deploys first — never a second pack.
        const spawn = () => {
          if (!alive(unit) || wolfOf(unit)) return;
          const pieces = tokensOf(battle, unit, wolfId);
          const live = pieces.find((t) => alive(t));
          if (live) { unit.trait.reinforcement = live; return; }
          const waiting = pieces.find((t) => !t.alive && !t.removed);
          if (waiting && battle.redeploy(waiting, { free: true })) {
            unit.trait.reinforcement = waiting;
            fx(battle, 'summon', waiting, { src: unit.id, token: wolfId });
            return;
          }
          const board = pieces.find((t) => t.uid != null);
          const tile = tacticalPoint(battle, unit, board ? [board.homeR, board.homeC] : null);
          if (!tile) return;
          const w = battle.spawnToken(unit, wolfId, tile[0], tile[1], { kit: wolfKit(unit) });
          unit.trait.reinforcement = w;
          if (!w) return;
          fx(battle, 'summon', w, { src: unit.id, token: wolfId, wolves: w.mem.wolves });
          const again = Math.max(0, w.base.respawnTime || 0);
          battle.on('death', (c) => { if (c.unit === w && c.reason === 'killed') battle.after(again, spawn, { owner: unit }); }, { owner: w });
        };
        battle.on('deploy', (c) => { if (c.unit === unit) spawn(); }, { owner: unit });
        installPackMark(battle, unit);
        battle.on('death', (c) => {
          if (c.unit !== unit) return;
          const w = wolfOf(unit);
          if (w) battle.retreat(w, { reason: 'expired', permanent: true });
        }, { owner: unit });
      } },
      skill: {
        kind: 'duration',
        attack: { hits },
        onStart({ unit }) { unit.mem.vigilAcc = 0; unit.mem.vigilDp = 0; },
        onTick({ battle, unit, dt }) {
          const iv = num(bb.interval, 1.5), step = num(bb.cost, 1), cap = num(bb.value, 0);
          if (!(iv > 0) || !(step > 0)) return; // (junk blackboard: never spin)
          unit.mem.vigilAcc += dt;
          while (unit.mem.vigilAcc >= iv - 1e-9 && unit.mem.vigilDp + step <= cap + 1e-9) {
            unit.mem.vigilAcc -= iv;
            unit.mem.vigilDp += step;
            battle.addDp(unit.ownerId, step);
          }
        },
        onEnd({ battle, unit, reason }) {
          // the whole `value` is granted over a full duration (精锐: 11 × 1.364 s ends a hair after 15 s)
          const rest = num(bb.value, 0) - (unit.mem.vigilDp ?? 0);
          if (reason === 'duration' && rest > 1e-9) { battle.addDp(unit.ownerId, rest); unit.mem.vigilDp += rest; }
          fx(battle, 'dp', unit, { n: unit.mem.vigilDp ?? 0 });
        },
      },
      skills: altSkills(chess, d, bb, {
        // (自动触发: an AUTO skill takes no 技能策略 — the 战术家 row is for MANUAL skills — and this DP skill fires as soon
        // as it is ready, as before)
        skchr_vigil_1: (s) => ({
          kind: 'instant',
          trigger: 'SP_FULL',
          onStart({ battle, unit }) {
            dpGain(battle, unit, num(s.bb.cost, 0));
            const w = wolfOf(unit);
            if (w) addShadow(battle, unit, w);
          },
        }),
        // (自动触发, PRTS 备注 「仅场上存在狼群，且狼群未获得此技能的充能时可触发技能」: no enemy needed — the kit casts it as soon
        // as it is ready while the pack stands and holds no unused gift (installGift); until 0.2.0 the data's DEFAULT made it
        // wait for 伺夜's own next attack, so it never fired with no enemy in his range)
        skchr_vigil_2: (s) => ({
          kind: 'instant',
          trigger: 'NEVER',
          onStart({ battle, unit }) {
            dpGain(battle, unit, num(s.bb.cost, 0));
            const w = wolfOf(unit);
            if (!w) return;
            const hr = num(s.bb['vigil_wolf_s_2.hp_ratio'], 0);
            if (hr > 0) battle.heal(w, w, w.s.maxHp * hr, { self: true });
            w.mem.vigilGift = { scale: num(s.bb['vigil_wolf_s_2.atk_scale'], 1), dp: num(s.bb['vigil_wolf_s_2.cost'], 0), paid: false };
            fx(battle, 'buff', w, { src: unit.id, skill: 'vigil_2' });
          },
        }),
      }),
      install(battle, unit) { if (sel === 'skchr_vigil_2') installGift(battle, unit); },
      talents: [
        { install() { /* 狼群领袖: the pack itself (trait.install / wolfKit) */ } },
        { install(battle, unit) {
          battle.on('hit', (ctx) => {
            const w = wolfOf(unit);
            // "伺夜和狼群对其的攻击无视其175防御力": their attacks only (not item procs or other non-attack damage)
            if (!w || pen <= 0 || !ctx.dmg.isAttack || (ctx.source !== unit && ctx.source !== w) || ctx.target.blockedBy !== w) return;
            ctx.dmg.defIgnoreFlat += pen;
          }, { owner: unit });
          battle.on('damaged', (ctx) => {
            const w = wolfOf(unit);
            if (!w || !(bonus > 0) || !unit.skill?.active || !ctx.dmg?.isAttack || (ctx.source !== unit && ctx.source !== w)) return;
            const e = ctx.target;
            if (e.side !== 'enemy' || !e.alive || e.blockedBy !== w) return;
            // "狼群与伺夜攻击…时，额外造成…": the extra hit belongs to that attack's dealer (a bite's bonus is the pack's
            // damage — never re-typed by 伺夜's 弱点伤害 特质), its size to 伺夜's ATK (same as tokens.js unmanaged mode)
            battle.dealDamage(ctx.source, e, { amount: unit.s.atk * bonus, type: 'arts', canDodge: false, isSkill: true, tags: ['skill', 'vigilBonus'] });
          }, { owner: unit });
        } },
      ],
    };
  },
};
