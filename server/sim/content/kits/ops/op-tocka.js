// server/sim/content/kits/ops/op-tocka.js — 冻河 (char_4244_tocka) 自选 operator kit: 6★ 游击手 (辅助), an owned-6★ pick of the
// tier-5 and tier-6 自选 slots; every skill and both talents at every form. She has no module. Kit contract and the 自选
// rules: ../README.md ("How to add an operator (自选)").
//
// Sources: character_table / skill_table of ArknightsGameData 08ba2aea (client 2.7.91, 2026-11-01), as built into
// backups.json; the client's battle logic of that commit — buff_template_data (tocka_s1[trigger] / [shield],
// tocka_s2[trigger] / [auto_skill], tocka_s3[trigger] / [trigger_listener] / [bonus] / [skill_add_sp],
// tocka_t1[sp_and_heal], tocka_t2[aoe_mark_listener], tocka_mx_a[t2_dot]) and the prefabs (charpack char_4244_tocka,
// [uc]skills.ab skchr_tocka_1..3, [uc]projectiles.ab projectile_chr_tocka*); PRTS 冻河 (2026-11-02) 备注. The official mode
// never fielded her: what neither source settles is marked [ASSUMED].
//
// 触发型效果 ("trigger effects"): a buff she puts on one of our operators; it fires once on its condition, then it is gone.
// Each firing runs 夜的哑然 (talent 1); each application arms 雪的印痕 (talent 2).
// - S1 一无所有之人 (AUTO, instant): up to max_target operators of her attack range that hold no S1 effect — herself
//   included —, lowest HP ratio first, then the latest deployed (PRTS 备注; the selector has no excludeOwner). With no
//   such operator the cast waits, its SP kept (the skill's _minTargetNum 1 / _recoverSpIfNoTarget: the kit casts it, the
//   data's trigger is NEVER here). The effect stays until it fires (lifeTimeType INFINITY): on the first damage its
//   holder takes that is neither 元素 nor continuous (a DoT; ON_BEFORE_APPLYING_MODIFIER, FilterDamageModifer ELEMENT /
//   IS_CONTINUOUS, not cancelled) the holder gets a 屏障 of shield_atk_scale × her ATK at that moment (PRTS 备注 "根据
//   触发时…计算") that absorbs every type but 元素 (BlockDamage ANY_ATTACK_EXCEPT_ELEMENT) and loses initial / shield_time
//   every second (the buff's 1 s trigger, PRTS 备注) — an earlier one of hers is cleared first and the new amount is the
//   larger of the two (PRTS 备注) —, and that damage's source, alive and not of our side, is 晕眩 stun s. The 屏障 is
//   made before the damage lands, so it takes that damage too [the client's order: the modifier stage precedes
//   ON_TAKE_DAMAGE]; fully absorbed, the hit counts as blocked (PRTS 屏障).
// - S2 意欲呼啸之心 (AUTO, instant): one operator of the whole field with a skill that is not passive and holds no S2
//   effect nor its attack-speed window — whose skill is not running first, then the latest deployed, not herself (PRTS
//   备注); herself only when nobody else qualifies (the skill's second selector). The effect flies to it
//   (projectile_chr_tocka_s2, speed 10) and is put on at the landing. It fires when the holder starts a skill, or at its
//   0.2 s check once the holder's skill can open (PRTS 备注: "技力充足、未持有阻止能力类异常效果、不需要目标/满足目标条件" —
//   SP ready, able to act, not silenced, and `targetMet`: the target condition the engine asks of that skill's automatic
//   cast — the range rules' own range, DEFAULT's initial range or a blocked enemy, a heal skill's injured ally [ASSUMED:
//   the 技能策略's condition stands for the skill's own target need]; the rules with no target of their own (SP_FULL /
//   NEVER / TAKE_DAMAGE, PRTS's "不需要目标") wait for an enemy in the holder's attack or skill range, or one it blocks
//   (`enemyInReach`) — the owner's test of 2026-11-03: "干员技力一满并且技能/攻击范围内有敌人就自动放，没敌人不会放"; the
//   cast stays the engine's);
//   then attack_speed for buff_duration s (EXTEND) and, while that lasts, every 0.2 s a MANUAL skill of the holder that
//   is ready opens (tocka_s2[auto_skill] TriggerSkill: "每6帧尝试触发…不会改变其手动触发性质") — [ASSUMED] not held back by
//   the mode's 3 s automatic-operation cooldown: it is the skill's own effect, not the mode's operation. Every 冻河's
//   window is its own buff (PRTS "不同冻河间的攻击速度加成互相独立").
// - S3 踽踽独行之春 (MANUAL, data DEFAULT): duration, attack_speed; her attacks strike attack@max_target enemies (air too) for
//   attack@atk_scale physical and 晕眩 attack@stun s (the S3 mode's attack, projectile_chr_tocka_s3). At its start, with no
//   S3 effect of hers on the field, one goes on another operator of her attack range (SelectCharacter: our operators,
//   not herself, without her S3 effect — first those with a non-passive skill that is not running, then those with a
//   non-passive skill, then anyone; the highest SP ratio first); with one, it fires instead. It fires when its holder
//   starts a skill: the holder and 冻河 get bonus_init_atk ATK (MULTIPLIER, i.e. 攻击力+%) that falls by
//   bonus_atk_dec_per_sec every second over bonus_duration s (PRTS 备注), and the effect moves to the operator of her
//   range with the highest SP ratio by the same order (none: it is gone). Whoever holds it gets bonus_sp SP every second
//   while her skill runs. Her S3 effects belong to her (derived from her S3 passive): they end when she leaves.
// - 夜的哑然: each firing of one of her effects gives her sp SP and heals one operator of her attack range but herself —
//   [ASSUMED] the lowest HP ratio (SelectHealTarget's postFilter 3, the heal selectors' order) — for heal_scale × her ATK.
//   Not while she is off the field (her talent buff goes with her). SP goes through giveSp: [ASSUMED] none during her
//   running S3, the engine's rule for SP during a timed skill.
// - 雪的印痕: an application of any of her effects arms her next normal attack (tocka_t2[aoe_mark], spent as that attack
//   is made): it is the client's T2Attack — the same 1.0 × ATK physical hit, landing on every enemy within
//   attack@projectile_range of the target (projectile_chr_tocka_t2) — and each enemy it lands on is 虚弱 |attack@t2_atk|
//   (attr_down[atk], 最终乘算, PRTS) and takes attack@t2_magic_atk_scale × her ATK arts every second (a DoT, the first
//   1 s later), both attack@t2_buff_duration s; hers refresh on a target and the DoT keeps the larger value (AssignMode
//   MAX). Her S3 attacks are the S3 mode's: an armed attack waits for the first normal one after it.

import { num, talentBb, skillRec, up, giveSp, alliesInGridOf } from '../shared/tier1.js';
import { canTargetEnemy } from '../../../targeting.js';
import { isHpLoss } from '../../../attack.js';
import { hypot } from '../../../detmath.js';

const S1 = 'skchr_tocka_1', S2 = 'skchr_tocka_2', S3 = 'skchr_tocka_3';
const AIR = Object.freeze({ canHitFly: true });
/** S2's effect checks its holder and its window opens the holder's skill every 6 frames (PRTS 备注, triggerInterval 0.2). */
const CHECK = 0.2;
/** projectile_chr_tocka_s2 _speed (tiles / s); projectile_tocka_s3_effect, the S3 effect's move (a visual: it moves at once), 6. */
const S2_SPEED = 10, S3_FX_SPEED = 6;
const S1_KEY = 'tocka:s1', S2_KEY = 'tocka:s2', S2_TAG = 'tocka:s2';

const stateOf = (unit) => (unit.mem.tocka ??= { mark: false, armed: 0, s3: new Set(), s2hooked: new WeakSet() });
const isDot = (dmg) => dmg?.attackType === 'BUFF' || !!dmg?.tags?.includes('dot');
const isOp = (a) => a.kind === 'op';
/** A skill her S2 / S3 selectors accept: one that is not passive (and exists). */
const activeSkill = (a) => !!a.skill && !a.skill.noSkill && a.skill.kind !== 'passive';
const spRatio = (a) => (a.skill && a.skill.spCost > 0 ? Math.min(1, (a.skill.sp + (a.skill.charges >= 1 ? a.skill.spCost : 0)) / a.skill.spCost) : 0);
const latestFirst = (a, b) => b.deploySeq - a.deploySeq;
/** Our operators of the whole field another unit's ability may pick. */
const fieldOps = (battle, by) => battle.allyUnits.filter((a) => a.alive && a.deployed && !a.hidden && isOp(a) && battle.allySelectable(a, by));
/** The holder's skill can be opened now (PRTS 备注: SP enough, no ability-stopping status, not running). */
const openable = (a) => up(a) && activeSkill(a) && a.skill.ready && !(a.skill.active && a.skill.isTimed) && !a.skill.pending
  && a.canAct && !a.s.flags.silence;
/** Trigger rules whose cast asks no target of its own ("不需要目标"): at full SP, a kit's own cast, a hit taken. */
const NO_TARGET_RULES = new Set(['SP_FULL', 'NEVER', 'TAKE_DAMAGE']);
/** The rules the engine checks on their own range every tick (skills.js TICK_RULES but SP_FULL). */
const RANGE_RULES = new Set(['SEARCH', 'CUSTOM_RANGE', 'SKILL_RANGE', 'ACTIVE_RANGE', 'GDGLOW_SKILL_2']);
/**
 * "满足目标条件" (PRTS S2 备注): the target condition the engine asks of an automatic cast of `u`'s skill — the range rules'
 * own check (skills.js `_tickRuleSatisfied`), else DEFAULT's: an enemy in the initial range or one it blocks, a heal skill
 * an injured ally (`_defaultCondition`; a DEFAULT cast bound to an ally: `_allyTriggerSatisfied`); the NO_TARGET_RULES an
 * enemy within reach (`enemyInReach`, the owner's test). The cast itself stays the engine's.
 */
function targetMet(u) {
  const sk = u.skill;
  if (NO_TARGET_RULES.has(sk.rule)) return enemyInReach(u);
  if (RANGE_RULES.has(sk.rule)) return !!sk._tickRuleSatisfied();
  return sk.triggerAllies ? !!sk._allyTriggerSatisfied() : !!sk._defaultCondition();
}

/**
 * "技能/攻击范围内有敌人" (the owner's test, 2026-11-03): an enemy `u` can target in its initial range or in its skill's own
 * trigger range, or one it blocks — DEFAULT's enemy part (skills.js `_defaultCondition`), a heal skill's too.
 */
function enemyInReach(u) {
  const sk = u.skill, b = sk.battle;
  if (b.rangeChanged(u)) b._refreshRange(u);
  const keys = u.baseRangeKeys || u.rangeKeys;
  if (keys && b.enemiesInKeys(keys, u, u.profile).length > 0) return true;
  if (sk.triggerGrid && b.anyEnemyInKeys(sk._triggerKeys(), u)) return true;
  return u.blocking.length > 0 && b.blockedTargets(u, u.profile).length > 0;
}

/** 夜的哑然: a firing of one of her effects. */
function onFire(battle, unit, t0) {
  if (!up(unit)) return;
  giveSp(unit, num(t0.sp, 2));
  const pick = alliesInGridOf(battle, unit).filter((a) => a !== unit && isOp(a) && !a.s.flags.noHeal)
    .sort((a, b) => a.hpRatio - b.hpRatio || latestFirst(a, b))[0];
  if (!pick) return;
  battle.heal({ source: unit, target: pick, amount: unit.s.atk * num(t0.heal_scale, 1) });
  battle.fx('heal', { x: pick.x, y: pick.y, id: unit.id, target: pick.id });
}

/** 雪的印痕: an application of one of her effects arms her next normal attack. */
const arm = (unit) => { stateOf(unit).mark = true; };

// ---- S1 --------------------------------------------------------------------------------------------------------------

const s1Targets = (battle, unit, n) => alliesInGridOf(battle, unit).filter((a) => isOp(a) && !a.findBuff(S1_KEY))
  .sort((a, b) => a.hpRatio - b.hpRatio || latestFirst(a, b)).slice(0, n);

function s1Shield(battle, unit, holder, b1) {
  const key = `tocka:s1shield:${unit.id}`;
  const old = holder.findBuff(key);
  const amount = Math.max(old?.shield ?? 0, unit.s.atk * num(b1.shield_atk_scale));
  if (old) battle.removeBuff(holder, old);
  if (!(amount > 0)) return null;
  const step = amount / Math.max(1e-9, num(b1.shield_time, 10));
  const buff = battle.addBuff(holder, {
    key, source: unit, shield: amount, shieldType: ['phys', 'arts', 'true'], visible: true, interval: 1,
    onTick({ unit: h, buff: b }) {
      b.shield = Math.max(0, b.shield - step);
      h.markDirty();
      if (!(b.shield > 1e-9)) battle.removeBuff(h, b);
    },
  });
  battle.fx('shield', { x: holder.x, y: holder.y, id: unit.id, target: holder.id, from: unit.id, dur: num(b1.shield_time, 10) });
  return buff ?? holder.findBuff(key);
}

function putS1(battle, unit, holder, b1, t0) {
  battle.addBuff(holder, {
    key: S1_KEY, source: unit, visible: true, injuryPriority: 1000,
    injury(ev) {
      const dmg = ev.dmg;
      if (!(ev.amount > 0) || ev.type === 'elemental' || isDot(dmg) || isHpLoss(dmg)) return;
      const me = holder.findBuff(S1_KEY);
      if (!me || me.source !== unit) return;
      battle.removeBuff(holder, me);
      const shield = s1Shield(battle, unit, holder, b1);
      if (shield && shield.shield > 0 && ev.type !== 'elemental') {
        const take = Math.min(shield.shield, ev.amount);
        shield.shield -= take;
        ev.amount -= take;
        if (!(ev.amount > 1e-9)) { ev.amount = 0; ev.block(); }
        if (!(shield.shield > 1e-9)) battle.removeBuff(holder, shield);
        holder.markDirty();
      }
      const src = ev.source;
      ev.defer(() => {
        if (src && src.alive && src.side !== holder.side) battle.applyStatus(src, 'stun', { duration: num(b1.stun), source: unit });
        onFire(battle, unit, t0);
      });
    },
  });
  battle.fx('mark', { x: holder.x, y: holder.y, id: unit.id, target: holder.id, skill: 'tocka_1' });
  arm(unit);
}

// ---- S2 --------------------------------------------------------------------------------------------------------------

const hasS2 = (a) => a.buffs.some((b) => b.tags?.includes(S2_TAG));

function s2Target(battle, unit) {
  const ok = (a) => activeSkill(a) && !hasS2(a);
  const order = (a, b) => (a.skill.active ? 1 : 0) - (b.skill.active ? 1 : 0) || latestFirst(a, b);
  const others = fieldOps(battle, unit).filter((a) => a !== unit && ok(a)).sort(order);
  if (others.length) return others[0];
  return up(unit) && ok(unit) ? unit : null;
}

function openWindow(battle, unit, holder, b2) {
  battle.addBuff(holder, {
    key: `tocka:s2auto:${unit.id}`, source: unit, duration: num(b2.buff_duration, 15), refresh: 'extend', visible: true,
    tags: [S2_TAG], mods: { aspd: num(b2.attack_speed) }, interval: CHECK,
    onTick({ unit: h }) { if (h.skill?.manual && openable(h)) h.skill.activate('tocka'); },
  });
  battle.fx('buff', { x: holder.x, y: holder.y, id: unit.id, target: holder.id, dur: num(b2.buff_duration, 15), skill: 'tocka_2' });
}

function putS2(battle, unit, holder, b2, t0) {
  if (!holder.alive || !holder.deployed || hasS2(holder)) return;
  let fired = false;
  const fire = () => {
    if (fired) return;
    const me = holder.findBuff(S2_KEY);
    if (!me || me.source !== unit) return;
    fired = true;
    battle.removeBuff(holder, me);
    openWindow(battle, unit, holder, b2);
    onFire(battle, unit, t0);
  };
  battle.addBuff(holder, {
    key: S2_KEY, source: unit, visible: true, tags: [S2_TAG], interval: CHECK, data: { fire },
    // 技能可开启时: SP ready, able to act, not silenced, and its own target condition met (PRTS 备注) — checked every 0.2 s
    onTick({ unit: h }) { if (openable(h) && targetMet(h)) fire(); },
  });
  // "技能开启时" (and a toggle's switch): one handler per holder, owned by the holder (it outlives her)
  const m = stateOf(unit);
  if (!m.s2hooked.has(holder)) {
    m.s2hooked.add(holder);
    battle.on('skillStart', ({ unit: u }) => {
      const me = u === holder ? holder.findBuff(S2_KEY) : null;
      if (me && me.source === unit) me.data.fire();
    }, { owner: holder });
  }
  battle.fx('mark', { x: holder.x, y: holder.y, id: unit.id, target: holder.id, skill: 'tocka_2' });
  arm(unit);
}

// ---- S3 --------------------------------------------------------------------------------------------------------------

/** SelectCharacter: our operators of her attack range but her (and `skip`), without her S3 effect; three tiers, SP ratio first. */
function s3Target(battle, unit, skip = null) {
  const key = `tocka:s3:${unit.id}`;
  const pool = alliesInGridOf(battle, unit).filter((a) => a !== unit && a !== skip && isOp(a) && !a.findBuff(key));
  const best = (list) => list.sort((a, b) => spRatio(b) - spRatio(a) || latestFirst(a, b))[0] ?? null;
  return best(pool.filter((a) => activeSkill(a) && !a.skill.active)) ?? best(pool.filter(activeSkill)) ?? best(pool);
}

function bonus(battle, unit, target, b3) {
  const dec = num(b3.bonus_atk_dec_per_sec);
  let v = num(b3.bonus_init_atk);
  if (!(v > 0) || !target?.alive) return;
  battle.addBuff(target, {
    key: `tocka:bonus:${unit.id}`, source: unit, duration: num(b3.bonus_duration, 15), visible: true, tags: ['skill'],
    mods: { atkPct: v }, interval: 1,
    onTick({ unit: h, buff: b }) { v = Math.max(0, v - dec); b.mods = { atkPct: v }; h.markDirty(); },
  });
  battle.fx('buff', { x: target.x, y: target.y, id: unit.id, target: target.id, dur: num(b3.bonus_duration, 15), skill: 'tocka_3' });
}

function putS3(battle, unit, holder, b3) {
  const m = stateOf(unit), key = `tocka:s3:${unit.id}`;
  if (!holder?.alive || holder.findBuff(key)) return;
  m.s3.add(holder);
  battle.addBuff(holder, {
    key, source: unit, visible: true, interval: 1,
    // tocka_s3[skill_add_sp]: bonus_sp every second while her skill runs
    onTick({ unit: h }) { if (up(unit) && unit.skill?.id === S3 && unit.skill.active) giveSp(h, num(b3.bonus_sp, 1)); },
    onRemove() { m.s3.delete(holder); },
    onExpire() { m.s3.delete(holder); },
  });
  battle.fx('mark', { x: holder.x, y: holder.y, id: unit.id, target: holder.id, skill: 'tocka_3' });
  arm(unit);
}

/** Her S3 effect on `holder` fires: both ATK bonuses, the move to the next operator, 夜的哑然. */
function fireS3(battle, unit, holder, b3, t0) {
  const key = `tocka:s3:${unit.id}`;
  if (!holder.findBuff(key)) return;
  bonus(battle, unit, holder, b3);
  const next = up(unit) ? s3Target(battle, unit) : null;
  battle.removeBuff(holder, key);
  stateOf(unit).s3.delete(holder);
  if (next) {
    putS3(battle, unit, next, b3);
    battle.fx('link', { x: holder.x, y: holder.y, tx: next.x, ty: next.y, t: hypot(next.x - holder.x, next.y - holder.y) / S3_FX_SPEED,
      id: unit.id, target: next.id, flame: `${unit.id}:s3:${battle.time}:${next.id}`, skill: 'tocka_3' });
  }
  if (holder !== unit) bonus(battle, unit, unit, b3);
  onFire(battle, unit, t0);
}

function installS3(battle, unit, b3, t0) {
  const m = stateOf(unit);
  battle.on('skillStart', ({ unit: u }) => {
    if (u === unit || !m.s3.has(u)) return;
    fireS3(battle, unit, u, b3, t0);
  }, { owner: unit });
  // derived from her S3 passive (tocka_s3[trigger_listener]): they go when she leaves
  battle.on('death', ({ unit: u }) => {
    if (u !== unit) return;
    for (const h of [...m.s3]) battle.removeBuff(h, `tocka:s3:${unit.id}`);
    m.s3.clear();
  }, { owner: unit, priority: 5 });
}

// ---- 雪的印痕 ----------------------------------------------------------------------------------------------------------

function installMark(battle, unit, t1) {
  const m = stateOf(unit);
  const radius = num(t1['attack@projectile_range'], 1.5), dur = num(t1['attack@t2_buff_duration'], 8);
  const weak = Math.abs(num(t1['attack@t2_atk'], -0.2)), dotScale = num(t1['attack@t2_magic_atk_scale'], 0.8);
  battle.on('deploy', ({ unit: u }) => { if (u === unit) { m.mark = false; m.armed = 0; } }, { owner: unit });
  battle.on('beforeAttack', (c) => {
    if (c.attacker !== unit || c.isSkill || !m.mark || (unit.skill?.id === S3 && unit.skill.active)) return;
    m.mark = false;
    m.armed++;
  }, { owner: unit });
  const mark = (e) => {
    if (!e.alive) return;
    if (weak > 0) battle.applyStatus(e, 'weaken', { duration: dur, value: weak, source: unit });
    const key = `tocka:t2dot:${unit.id}`, value = unit.s.atk * dotScale, old = e.findBuff(key);
    const keep = Math.max(value, old?.data?.value ?? 0);
    battle.addBuff(e, {
      key, source: unit, duration: dur, refresh: 'replace', interval: 1, data: { value: keep },
      onTick({ unit: t, buff }) {
        battle.dealDamage({ source: unit, target: t, amount: buff.data.value, type: 'arts', attackType: 'BUFF', canDodge: false, tags: ['dot', 'tocka:t2dot'] });
      },
    });
  };
  battle.on('hit', ({ source, target, dmg }) => {
    if (source !== unit || !m.armed || !dmg?.isAttack || dmg.isSplash || dmg.isSkill || target?.side !== 'enemy') return;
    if (dmg.tags?.includes('chain') || dmg.tags?.includes('addition')) return;
    m.armed--;
    battle.fx('aoe', { x: target.x, y: target.y, radius, id: unit.id, dmgType: 'phys', skill: 'tocka_t2' });
    const others = battle.foesInRadius(target.x, target.y, radius).filter((e) => e !== target && canTargetEnemy(unit, e, AIR));
    mark(target);
    for (const e of others) {
      battle.dealDamage({ source: unit, target: e, amount: unit.s.atk, type: 'phys', isAttack: true, isSplash: true, attackId: dmg.attackId, tags: ['tocka:t2'] });
      mark(e);
    }
  }, { owner: unit });
}

export default {
  char_4244_tocka: (bb, raw) => {
    const t0 = talentBb(raw, 0), t1 = talentBb(raw, 1);
    const b1 = skillRec(raw, S1)?.bb ?? {}, b2 = skillRec(raw, S2)?.bb ?? {}, b3 = skillRec(raw, S3)?.bb ?? {};
    return {
      skills: {
        [S1]: {
          kind: 'instant', trigger: { rule: 'NEVER' },
          onStart({ battle, unit }) {
            for (const a of s1Targets(battle, unit, Math.max(1, Math.floor(num(b1.max_target, 1))))) putS1(battle, unit, a, b1, t0);
          },
        },
        [S2]: {
          kind: 'instant', trigger: { rule: 'NEVER' },
          onStart({ battle, unit }) {
            const t = s2Target(battle, unit);
            if (!t) return;
            const d = hypot(t.x - unit.x, t.y - unit.y);
            battle.fx('link', { x: unit.x, y: unit.y, tx: t.x, ty: t.y, t: d / S2_SPEED, id: unit.id, target: t.id,
              flame: `${unit.id}:s2:${battle.time}:${t.id}`, skill: 'tocka_2' });
            if (d < 1e-6) putS2(battle, unit, t, b2, t0);
            else battle.after(d / S2_SPEED, () => putS2(battle, unit, t, b2, t0), { owner: t });
          },
        },
        [S3]: {
          kind: 'duration', mods: { aspd: num(b3.attack_speed) },
          attack: {
            atkScale: num(b3['attack@atk_scale'], 1), maxTargets: Math.max(1, Math.floor(num(b3['attack@max_target'], 1))),
            onEachHit({ battle, unit, target }) {
              if (target?.alive && target.side === 'enemy') battle.applyStatus(target, 'stun', { duration: num(b3['attack@stun']), source: unit });
            },
          },
          onStart({ battle, unit }) {
            const m = stateOf(unit);
            const held = [...m.s3].filter((h) => h.alive && h.findBuff(`tocka:s3:${unit.id}`));
            if (held.length) for (const h of held) fireS3(battle, unit, h, b3, t0);
            else { const t = s3Target(battle, unit); if (t) putS3(battle, unit, t, b3); }
          },
        },
      },
      talents: [
        { install() {} },   // 夜的哑然: run by each firing (onFire)
        { install(battle, unit) { installMark(battle, unit, t1); } },
      ],
      install(battle, unit) {
        const skill = unit.skill;
        // S1 / S2: cast as soon as SP is full and someone can take the effect (the selectors' _minTargetNum 1)
        if (skill?.id === S1 || skill?.id === S2) {
          battle.on('tick', () => {
            if (!skill.ready || skill.active || !unit.canAct || unit.s.flags.silence || battle.time < skill.nextCastAt - 1e-9) return;
            const any = skill.id === S1 ? s1Targets(battle, unit, 1).length > 0 : !!s2Target(battle, unit);
            if (any) skill.activate('SP_FULL');
          }, { owner: unit });
        }
        if (skill?.id === S3) installS3(battle, unit, b3, t0);
      },
    };
  },
};
