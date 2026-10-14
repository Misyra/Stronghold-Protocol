// render/vfx/skills.js — the official skill, talent and charge effects of a battle unit as plans the wiring plays
// (DESIGN §33.12 `skills`; 0.3.0 Phase 3a). Pure logic over index.json and our data: no GL, no DOM, Node-importable.
//
//   resolveSkill(idx, { info, rec })        → { unitKey, skillId, skill, via, reason } — the official skill a unit uses
//   skillPlan(idx, unitKey, skillId, opts)  → SkillPlan (below): what to play on which client signal, and where
//   attackFx(plan, { heal, ranged })        → the effects of one attack of the owner while the skill is on
//   slotKey(entry, dir)                     → the key of a directional row for a facing ('UP' | 'RIGHT' | 'DOWN' | 'LEFT')
//   planKeys(plan) / chargeKeys(plan)       → every key of a plan (preloading)
//   anchorOf(desc)                          → where a prefab descriptor places its effect (_spawnLocation, FollowMountPoint)
//   chargePlan(idx, unitKey)                → a 秘术师's stored-energy effects (CHARGE_EMITTERS), null for other units
//   chargeStep(plan, prev, next)            → what changes when the stored count goes prev → next
//
// ---- Resolving a battle unit (resolveSkill) --------------------------------------------------------------------------
// Fields relied on — the view's info (render/app/info.js renderInfo of the sim's UnitInfo, server/sim/snapshot.js):
// `kind`, `side`, `defId`, `spine`, `skillIndex` (an ally's equipped skill: the official skill slot, 0-based — the sim's
// `def.skill.index`; absent for enemies), `diy.charId` / `diy.skillIndex` (a 自选 pick); and the unit's data record —
// what render/app.js `ctx.lookupDef(info)` returns: the chess record (data/chess.json), the 补位 / 自选 record
// (shared/standIn.js composeUnitRecord: the same `skill` / `skills[]` shape), a token record (data/tokens.json), an enemy
// record (data/enemies.json): `charId`, `skill` { skillId, prefabId, index } and `skills[]` (each with `index`).
//   * the index unit: the first of [diy.charId, spine, rec.charId, defId] that index.json has (a `_<n>` suffix dropped),
//     the order of FxWiring.unitOf;
//   * the skill record: `rec.skills[]` with `index === skillIndex` (the loadout's pick), else `rec.skill`;
//   * the skill id: its `prefabId`, else `skillId` (lower case; a `[n]` variant suffix such as 预备干员's
//     `skcom_charge_cost[1]` dropped), looked up in the unit's `skills`, then in index.skills; without a record, the
//     client's naming `skchr_<code>_<skillIndex + 1>` of a `char_<n>_<code>` unit (`via: 'name'`; not when a record names
//     a skill the index lacks — the naming could hit another skill: 琴柳's slot 0, skcom_assist_cost[3], is no
//     skchr_sleach_1).
// Tokens: their skills (`sktok_*`, `skcom_withdraw`) are not in index.json (the extractor crawls the chess skills and
// every `skchr_<code>_<n>`): `reason: 'token-skill'`. A token's own `S1` / `S2` / `S3` modes follow its summoner's skill
// (麦哲伦's drones, 凯尔希's Mon3tr) [ASSUMED from the mode names]; UnitInfo carries no summoner link (ownerId is the
// player), so FxWiring.mode's `S<skillIndex + 1>` cannot be right for them yet. Enemies: index.json has no enemy skill
// effects (their abilities live in the enemy prefab; data/enemies.json `skills[].prefabKey` names them) — the sim's
// `['cast', id, slot]` (PR #275) has nothing to look up: `reason: 'enemy-skill'`.
//
// ---- The plan (skillPlan) ------------------------------------------------------------------------------------------
//   { unitKey, skillId, mode, modeName, kind,
//     start, loop, end, ready, range,      skill-level: on the owner
//     attacks: [{ node, ability, cast, range, aim, hit }],  the skill prefab's own attack abilities (each attack while on)
//     each: { cast, hit },                 any attack of the owner while on (buff template actions)
//     trigger,                             reactive: the owner taking damage while on
//     targets,                             on other units (the skill's buffs on targets / aura members): no client signal
//     unmapped: [{ key, role, reason, from }] }
// `hit` lists are hit groups: [[entry…]…] — the k-th hit of one attack plays group min(k, last) (a plain attack has one
// group); `aim` plays on the attack's targets at its cast, once. Entry = { key, role, at, loop, hold, from, node?,
// ability?, list?, startEvent?, endEvent?, directionType?, slots?, firstOnly?, afterFirst?, event?, action?, buff?,
// on?, byName?, point?, follow? }:
//   at    'owner' (placed on the owner by the prefab's own _spawnLocation: feet, HitPoint, Muzzle, a Special point, its
//         ground centre — the wiring's playOn reads it), 'target' (on the target hit; HIT_POINT for most), 'targets'
//         (the carriers of a buff the client cannot name);
//   loop  the prefab loops (index.json prefabs[key].looping) — someone has to stop it;
//   hold  'skill' (stop on skill off / death), 'cast' (stop when the cast ends: an attack's or the skill's single cast —
//         FxWiring's CAST_LOOP_S; a looping prefab in a one-shot role gets it too, except a skill-level begin effect —
//         `_beginEffect`, a buff's start action —, which lasts the skill [ASSUMED]), 'ready' (stop when the skill stops
//         being ready), null (a one-shot: it plays out);
//   point / follow  (with `opts.describe`) the prefab's SpawnLocation / FollowMountPoint names (anchorOf).
// `mode` / `modeName`: the owner's attack mode the skill switches to (index.json skills[id].mode — from the skill's data
// or `S<n>` by name); the normal attacks then use that mode's cast / hit / projectile (FxWiring.attack): Phase 3b should
// take it from here instead of `S<skillIndex + 1>` (204 of 210 skills agree; the plan is right for the other 6).
// `kind` (with `opts.rec`, our skill record): 'passive' (skillType PASSIVE — the sim starts it at deploy and sends no
// skill window for one with a duration: its loops run while the unit is deployed [ASSUMED]), 'ammo', 'lasting'
// (duration > 0), 'instant' (else: 'skill' on and off in one tick, around the skill's attack if it has one).
//
// How a use of index.json (skills[id].uses) is placed — the extractor's roles (DESIGN §33.12) refined by its fields:
//   * emitter rows (a use with `ability`, the ability the emitter serves): an attack ability (/Attack|Heal/, not
//     Channeling*) → `attacks` — `start` / `loop` / `end` rows to `cast` (on each attack's cast; a non-one-shot row is
//     held for that cast), `range` rows to its `range`, `hit` rows to `hit` (MultiHitUberEffectEmitter._hitGroups → hit
//     groups, below; plain `_hitEffects` rows play on every hit), `castTarget` / `inputTarget` rows to `aim` (on the
//     targets at the cast). Any other ability is the skill's own action → skill level: a row held past its cast — Channeling*
//     (the channel lasts the skill), or ActiveBuffAbility / BuffDuring* / Passive* / *Aura* not ending at ON_CAST_END —
//     is a `loop`; other non-one-shot rows are `start` held for the cast. Their `hit` rows have no event naming the
//     targets (unmapped 'hit-no-attack' / 'channel-hit').
//     Why attack rows go per attack, also in a one-cast skill: the sim sends ['skill', id, 1], the skill's attack
//     ['atk', …], then ['skill', id, 0] — the rows play with that attack (index.json does not say which skills are one
//     cast: the root class, ReplacementSkill / CastSkill, is not exported).
//   * buffs (a buff's effect: overrideEffectKey, else its template's effectKey) loop on their carrier: `on: 'owner'` (or
//     unknown) → `loop` (hold 'skill'), `on: 'targets'` → `targets`, a token's → unmapped 'token'.
//   * buff template actions (`event`): at ON_BUFF_START / ENABLE / LATE_ENABLE / ON_SKILL_START / ON_TOGGLE_SKILL_START →
//     as the role says (the template's buff is the skill's [ASSUMED]: its start is the skill start); at ON_BUFF_FINISH /
//     DISABLE / ON_SKILL_FINISH → `end` (a buff created there outlives the skill: unmapped 'after-end'); at
//     ON_TAKE_DAMAGE on the owner → `trigger`; at an output event (ON_OUTPUT_DAMAGE, ON_AFTER_ATTACK, …) → `each.hit`;
//     at an ability event (ON_ABILITY_START / SPELL_ON, ON_BEFORE_ATTACK) → `each.cast`; an effect or damage action at
//     ON_BUFF_TRIGGER is the buff's periodic tick (unmapped 'tick': no tick reaches the client); a buff created there —
//     the `[eff_cond]` condition checks such as billro_s_3[eff_cond], whose condition is not in the data — and any
//     other event (ON_APPLYING_MODIFIER, ON_BEFORE_TRY_SET_HP_ZERO, ON_OWNER_KILLED, ON_OWNER_LOCATE,
//     ON_CALCULATE_DAMAGE, …) → unmapped 'conditional'. Actions on targets follow `on: 'targets'` (a target's buff start
//     is its hit → `each.hit`).
//   * effect fields: ReadySkillEffect → `ready`; `_beginEffect` / `_startEffect` / … → `start` (a looping one is held
//     for the skill); `_endEffect` → `end`;
//     aura `_effects` → `loop`; `_hitEffect(Key)` / `_effectOnEliminatePos` → `each.hit`; points of a path or a line
//     (`_lineEffectKey`, `_startPointEffectKey`, `_waypointEffectKey`, `_endPointEffectKey`, `_edgeLineRendererEffectKey`)
//     and `_tileEffectKey` need positions the client is not given: unmapped 'path' / 'tiles'.
//   * `by: 'name'` (placed by the key's name) keeps that placement with `byName` [ASSUMED]; role `other` → unmapped.
//   * hookEffectAfterFirstAttack: the row's key on the first attack (`firstOnly`), the hook's from the second on
//     (`afterFirst`).
//   * MultiHitUberEffectEmitter._hitGroups arrive flattened (index.json keeps no group index): a row starts a new group
//     unless its key names a range (`_range`), which joins the group before it. This reproduces the client's groups of
//     all 10 skills of the used set that have them (client 26-09-13, [uc]skills.ab: skchr_acpion_3 8, ascln_1 2,
//     blkkgt_1 2, chen_3 10, chen3_2 6, irene_1 2, phatm2_1 2 (hit + hit_range each), vvana_1 2 + 3, zuole_1 2 / 3,
//     zuole_3 7); [ASSUMED] for later sets — a `group` field on the use (a later extractor) wins.
//
// ---- Role → client signal (render/app.js handleEvent; b.ev tuples, DESIGN §8.2; b.snap via render/interp.js) ---------
//   start     ['skill', id, 1]. An instant skill sends 1 and 0 in one tick (its attack, if any, between them); a passive
//             without a duration sends 1, then 0 after the 0.5 s clip window (server/sim/skills.js _startPassive); a
//             passive with a duration sends nothing — its loops belong to the deploy (`kind: 'passive'`).
//   loop      ['skill', id, 1] … ['skill', id, 0] (or 'die' / 'leak' / the battle's end). Level signal: b.snap flags & UF.SKILL
//             (a view built mid-battle — a reconnect, a watched field — starts its loops from it; passives never set it).
//   end       ['skill', id, 0].
//   range     as start (a one-shot) or as loop (hold 'skill').
//   ready     no event: the snapshot — sp ≥ spMax > 0 and not UF.SKILL (interp sample(): o.sp, o.spMax, o.flags)
//             [ASSUMED for a multi-charge skill, whose stored charges the snapshot does not show].
//   attacks / each .cast, attacks .aim   ['atk', ownerId, tgtId, kind] while the owner's skill is on (not a chain bounce,
//             CHAIN_KINDS; `aim` on tgtId).
//   attacks / each .hit    that attack landing on its target: the ['dmg', tgtId, …] after a melee 'atk' (app.js meleePending /
//             FxWiring's melee window), the projectile's arrival for a ranged one (FxWiring._arrive), ['heal', tgtId, n]
//             after a heal 'atk'. Hit k of a multi-hit attack: the sim deals all hits of one attack in one tick — the
//             k-th 'dmg' on that target (the order is the only link).
//   trigger   ['dmg', ownerId, …] while the skill is on (ON_TAKE_DAMAGE on the owner).
//   charge    b.snap `energy` [[id, stored, cap]] → view `o.energy` (branch claude/030-int, PR #636; not on this line).
// No client-visible signal today (and so `targets` / unmapped):
//   * who carries a skill's buff when it is not the owner — the targets of an attack's _activeBuffs, the members of an
//     aura / a global aura, a skill's selector targets: ['status', id, key, on] names only the sim's statuses (drawn by
//     generic.status), never a source or a skill;
//   * a buff given to the unit's summons (CreateBuffToToken, _buffsToToken): UnitInfo has no summoner link;
//   * the source of damage that is no attack (a kit's AoE, a DoT, a channel's ticks): 'dmg' carries no source; only the
//     kits' own 'fx' tuples name a caster (`extra.id`; `extra.skill` in 97 sim call sites), without a shared contract;
//   * buff events past start / finish / take-damage (periodic ticks, condition checks, would-die, kills, moves);
//   * the tiles / path of an area or line effect (_tileEffectKey, Aphris's path, range outlines);
//   * enemy and token skills (not in index.json); the hit index of a multi-hit attack (only the event order);
//   * a 秘术师's stored energy on this line (see the charge section; 维伊's and 黑键's stores are kit-private everywhere).
//
// ---- The 秘术师 charge (CHARGE_EMITTERS, chargePlan, chargeStep; GitHub #633) --------------------------------------
// index.json does not carry the charge emitters: they sit on the unit prefab's Trait/Charge*Group (AbilityChargeableGroup /
// AbilityExChargeGroup with MultiChargeUberEffectEmitter, MultiExChargeUberEffectEmitter, MergeableChargeUberEffectEmitter),
// which the extractor's attack reader skips (it takes a mode's `UberEffectEmitter` only — so 深靛's, 黑键's and 维伊's
// attack `cast` rows, a MultiChargeUberEffectEmitter's, are missing from their modes too). CHARGE_EMITTERS transcribes
// them from the client's charpacks (26-09-13); chargePlan checks every key against index.json. What the data says:
//   * per stored energy k (1-based) the k-th group of the trait group's emitter plays at the store's ON_SPELL_ON (event
//     4) — its looping prefab (_isLoop 1, _holdByOwner 1, FollowMountPoint on a Special point) stays while the energy is
//     stored —, and the k-th group of the store ability's own emitter (ChargeRangedAttack / ExChargeRangedAttack /
//     MergeableChargeRangeAttack, one per mode) plays at its ON_CAST_START (event 2): one-shots;
//   * a release fires the stored energies as projectiles from _mountPointForProjectiles[k − 1] (MountPointType) to the
//     attack's target — the store ability's _projectileKey of the current mode (Default / S1 / S2 …);
//   * 深靛 (char_469_indigo): 3 energies (4 with MSC-X — the sim's cap); slot k loops indigo_attack_charge_0{k+1} at
//     Special1, Special2, Special3, Special0 (mounts 6, 8, 9, 5) and every store plays indigo_attack_charge_01_start
//     (FxDelay 0.2 s, at Special0). So: count n → the loops of slots 1…n; each +1 → the one-shot and the next loop;
//     a release → the loops stop and n projectiles leave from those points;
//   * 黑键 (char_4046_ebnhlz): normal energies (orange, mounts 5, 6, 8, 9; up to 4 with MSC-X): store cast →
//     ebnhlz_attack_start_02_orange[_k], spell → ebnhlz_attack_charge_orange[_k] (a 6 s one-shot) + the loop
//     ebnhlz_attack_buff_orange[_k]; elite energies (red): the talent's extra one is slot 5 (…_red_5, Special4) outside S3;
//     during S3 every energy is elite, red … red_5 (_forceExCharge). Our sim keeps his count kit-private
//     (op-ebnhlz.js unit.trait.ebn { n, e }); the only client event is the release's ['fx', 'volley', x, y,
//     { id, target, n }] (n = normal + elite released) — nothing could drive the stored display today;
//   * 维伊 (char_4226_veen): 5 energy slots (veen_telent_01_rank_01[_k] loops + …_rank_01_change[_k] one-shots, mounts
//     5, 6, 8, 9, 10), every 3 merge (_mergeSize) into a 转置能量 slot (…_rank_02[_k] + …_rank_02_change[_k]); her kit
//     (op-veen.js) keeps its own store: no signal either.
//
// [ASSUMED] (the data does not say): the placements marked above; a looping prefab in a one-shot role is held for one
// cast (a skill-level begin effect for the skill); buff loops on the owner last the skill (a buff's own duration is not
// in index.json); hit groups beyond the last repeat the last; passive skills' loops follow the deploy.

/** Ability classes whose emitter rows follow each attack (the skill prefab's own attack). */
const isAttack = (a) => typeof a === 'string' && /Attack|Heal/.test(a) && !/^Channeling/.test(a);
const isChannel = (a) => typeof a === 'string' && /^Channeling/.test(a);
/** Abilities whose cast lasts the skill (a held row lasts it too, unless it ends at ON_CAST_END). */
const isLong = (a) => typeof a === 'string' && (/^(Active(OneOf)?BuffAbility|BuffDuring|Passive|ToggleablePassive)/.test(a) || /Aura/.test(a));

/** Buff events of a template action (Torappu.Battle.Buff/Event names, as index.json writes them) by timing. */
const START_EVENTS = new Set(['ON_BUFF_START', 'ON_BUFF_ENABLE', 'ON_BUFF_LATE_ENABLE', 'ON_SKILL_START', 'ON_TOGGLE_SKILL_START']);
const END_EVENTS = new Set(['ON_BUFF_FINISH', 'ON_BUFF_DISABLE', 'ON_SKILL_FINISH']);
const HIT_EVENTS = new Set(['ON_OUTPUT_DAMAGE', 'ON_AFTER_OUTPUT_DAMAGE', 'ON_ABILITY_CAST_ON_TARGET', 'ON_OUTPUT_ATK_OR_HEAL',
  'ON_OUTPUT_ATK_OR_HEAL_EACH_SPELL', 'ON_AFTER_ATTACK', 'ON_AFTER_OUTPUT_HEAL', 'ON_AFTER_OUTPUT_ELEMENT_DAMAGE']);
const CAST_EVENTS = new Set(['ON_ABILITY_START', 'ON_ABILITY_SPELL_ON', 'ON_BEFORE_ABILITY_SPELL_ON', 'ON_BEFORE_ATTACK']);

/** Effect fields whose positions come from the game (unmapped). */
const PATH_FIELD = /\.(_lineEffectKey|_startPointEffectKey|_waypointEffectKey|_endPointEffectKey|_edgeLineRendererEffectKey)$/;
const TILE_FIELD = /\._tileEffectKey$/;
const HOOK = '._hookEffectAfterFirstAttack';

/** The unmapped reasons (coverage tool, tests). */
export const UNMAPPED = Object.freeze({
  'no-prefab': 'the key has no extracted prefab',
  token: "a buff on the unit's summons: UnitInfo has no summoner link",
  tick: "a periodic tick of the skill's buff (ON_BUFF_TRIGGER): the sim sends no tick event (some kits send their own 'fx')",
  conditional: 'a buff template action at an event the client never sees (a condition check, would-die, a kill …)',
  'after-end': 'a buff created when the skill ends: its duration is not in index.json',
  'hit-no-attack': "hits of a non-attack ability: no 'atk' event names its targets",
  'channel-hit': "a channel's damage ticks: the sim sends them without a source",
  path: 'a line / path effect: its points come from the game',
  tiles: 'tile effects on tiles the client is not told',
  other: 'the extractor could not place it in time',
});

/** Role → the client signal that drives it (module header; the coverage tool prints it). */
export const SIGNALS = Object.freeze({
  start: "b.ev ['skill', id, 1]",
  loop: "b.ev ['skill', id, 1] … ['skill', id, 0] (level: b.snap flags & UF.SKILL)",
  end: "b.ev ['skill', id, 0]",
  range: 'as start (one-shot) or loop (hold skill)',
  ready: 'b.snap sp >= spMax > 0 and not UF.SKILL (no event)',
  cast: "b.ev ['atk', ownerId, tgt, kind] while the skill is on",
  hit: "that attack's damage on its target (melee 'dmg' window / projectile arrival / 'heal')",
  trigger: "b.ev ['dmg', ownerId, …] while the skill is on",
  targets: 'none (the client is not told who carries the buff)',
  charge: 'b.snap energy [[id, stored, cap]] (claude/030-int; char_469_indigo / the shared mystic store only)',
});

const lc = (k) => (typeof k === 'string' && k ? k.toLowerCase() : null);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- resolution -----------------------------------------------------------------------------------------------------

/** The index unit key among candidate ids (FxWiring.unitOf's order; a `_<n>` suffix dropped), or null. */
export function unitKeyOf(idx, cands) {
  const units = idx?.units;
  if (!isObj(units)) return null;
  for (const c of [].concat(cands || [])) {
    if (!c || typeof c !== 'string') continue;
    if (units[c]) return c;
    const base = c.replace(/_\d+$/, '');
    if (base !== c && units[base]) return base;
  }
  return null;
}

/** Our data's skill record a unit fights with: `rec.skills[]` with that index, else `rec.skill`. */
export function skillRecordOf(rec, skillIndex) {
  if (!isObj(rec)) return null;
  const list = Array.isArray(rec.skills) ? rec.skills : [];
  if (Number.isInteger(skillIndex)) {
    const s = list.find((x) => isObj(x) && x.index === skillIndex);
    if (s) return s;
    if (isObj(rec.skill) && (rec.skill.index == null || rec.skill.index === skillIndex)) return rec.skill;
    return null;
  }
  return isObj(rec.skill) ? rec.skill : list.find((x) => isObj(x) && x.isDefault) || null;
}

/** Candidate index skill ids of a skill record (prefabId, skillId; lower case, a `[n]` suffix dropped). */
export function skillIdsOf(srec) {
  const out = [];
  for (const v of [srec?.prefabId, srec?.skillId]) {
    const k = lc(v);
    if (!k) continue;
    for (const x of [k, k.replace(/\[\d+\]$/, '')]) if (!out.includes(x)) out.push(x);
  }
  return out;
}

/**
 * The official skill of a battle unit.
 * @param {any} idx index.json
 * @param {{ info?: any, rec?: any, unitKey?: string|null, skillIndex?: number }} unit  the view's info, its data record
 *   (ctx.lookupDef(info)); `unitKey` / `skillIndex` override what the info says
 * @returns {{ unitKey: string|null, skillId: string|null, skill: any, via: 'record'|'name'|null, reason: string|null }}
 */
export function resolveSkill(idx, { info = null, rec = null, unitKey = null, skillIndex } = {}) {
  const key = unitKey || unitKeyOf(idx, [info?.diy?.charId, info?.spine, rec?.charId, info?.defId]);
  const out = { unitKey: key, skillId: null, skill: null, via: null, reason: null };
  if (!key) { out.reason = 'no-unit'; return out; }
  const unit = idx.units[key];
  const kind = unit.kind;
  const index = Number.isInteger(skillIndex) ? skillIndex
    : Number.isInteger(info?.diy?.skillIndex) ? info.diy.skillIndex : Number.isInteger(info?.skillIndex) ? info.skillIndex : undefined;
  const find = (id) => (isObj(unit.skills) && unit.skills[id]) || (isObj(idx.skills) && idx.skills[id]) || null;
  const srec = skillRecordOf(rec, index);
  for (const id of skillIdsOf(srec)) {
    const s = find(id);
    if (s) return { ...out, skillId: id, skill: s, via: 'record' };
  }
  const m = /^char_\d+_(.+)$/.exec(key);
  if (!srec && m && Number.isInteger(index)) {   // the naming only stands in for a missing record (it could name another skill)
    const id = `skchr_${m[1]}_${index + 1}`;
    const s = find(id);
    if (s) return { ...out, skillId: id, skill: s, via: 'name' };
  }
  out.skillId = skillIdsOf(srec)[0] || null;
  out.reason = kind === 'enemy' || info?.side === 'enemy' ? 'enemy-skill' : kind === 'token' ? 'token-skill' : srec ? 'not-in-index' : 'no-skill';
  return out;
}

// ---- the plan -------------------------------------------------------------------------------------------------------

/** The rows of a MultiHitUberEffectEmitter's _hitGroups in use order → groups (header: a `_range` row joins the one before). */
export function hitGroups(rows) {
  const groups = [];
  let last = null;
  for (const r of rows) {
    if (Number.isInteger(r.group)) {
      (groups[r.group] || (groups[r.group] = [])).push(r);
      continue;
    }
    if (last && /_range/.test(r.key)) last.push(r);
    else groups.push((last = [r]));
  }
  return groups.filter(Boolean);
}

/** SpawnLocation names (ParticleEffect._spawnLocation, DESIGN §33.11 metadata). */
export const SPAWN_LOCATIONS = Object.freeze(['NONE', 'FOOT_POINT', 'HIT_POINT', 'MUZZLE_POINT', 'HEAD_POINT', 'GROUND_CENTER',
  'MUZZLE_POINT_WITHOUT_ROTATION', 'GROUND_CENTER_WITH_ZERO_HEIGHT', 'MP_SPECIAL_0', 'MP_SPECIAL_1', 'MP_SPECIAL_2', 'MP_SPECIAL_3',
  'CAMERA', 'MP_SPECIAL_4', 'MP_SPECIAL_5', 'MP_SPECIAL_6', 'MP_SPECIAL_7', 'TILE_CENTER', 'MP_SPECIAL_8', 'MP_SPECIAL_9',
  'MP_SPECIAL_10', 'MP_SPECIAL_11', 'MP_SPECIAL_12', 'MP_SPECIAL_13', 'MP_SPECIAL_14', 'MP_SPECIAL_15', 'GROUND_CENTER_WITH_TILE_HEIGHT',
  'MP_SPECIAL_16', 'MP_SPECIAL_17', 'MP_SPECIAL_18', 'MP_SPECIAL_19', 'MP_SPECIAL_20', 'MP_SPECIAL_21', 'MP_SPECIAL_22',
  'MP_SPECIAL_23', 'GROUND_CENTER_WITH_HIGHLAND_HEIGHT']);

/** A FollowMountPoint MountPointType's name (DESIGN §33.11 metadata: 0 FOOT, 1 HIT, 2 MUZZLE, 3 HEAD, 4 UI, 5 SPECIAL_0 …). */
export function mountPointName(t) {
  if (!Number.isInteger(t) || t < 0) return null;
  const fixed = ['FOOT', 'HIT', 'MUZZLE', 'HEAD', 'UI', 'SPECIAL_0', 'SPECIAL_1', 'GROUND', 'SPECIAL_2', 'SPECIAL_3'];
  if (t < fixed.length) return fixed[t];
  return t <= 29 ? `SPECIAL_${t - 6}` : null;
}

/**
 * Where a prefab places its effect: its root ParticleEffect's `_spawnLocation` (name), FollowMountPoint's point, and
 * whether it loops. `desc` = a prefab descriptor (prefabs/<file>.json) or a compiled def with `desc`.
 * @returns {{ spawn: number|null, point: string|null, follow: string|null, loop: boolean|null, projectile: boolean } | null}
 */
export function anchorOf(desc) {
  const d = isObj(desc?.desc) ? desc.desc : desc;
  if (!isObj(d) || !Array.isArray(d.nodes)) return null;
  let pe = null, follow = null, projectile = false;
  for (const n of d.nodes) {
    for (const b of Array.isArray(n?.behaviours) ? n.behaviours : []) {
      if (!b || b.enabled === false) continue;
      if (!pe && (b.class === 'ParticleEffect' || b.class === 'EmptyEffect')) pe = b.fields || {};
      else if (b.class === 'ProjectileEffect') projectile = true;
      else if (b.class === 'FollowMountPoint' && follow == null) follow = b.fields?._mountPointType;
    }
  }
  const spawn = Number.isInteger(pe?._spawnLocation) ? pe._spawnLocation : null;
  return {
    spawn, point: spawn != null ? SPAWN_LOCATIONS[spawn] || null : null, follow: mountPointName(follow),
    loop: pe ? !!pe._isLoop : (typeof d.stats?.looping === 'boolean' ? d.stats.looping : null), projectile,
  };
}

/** Our skill record → plan.kind (header). */
function kindOf(srec) {
  if (!isObj(srec)) return null;
  if (srec.skillType === 'PASSIVE') return 'passive';
  if (srec.durationType === 'AMMO') return 'ammo';
  return Number(srec.duration) > 0 ? 'lasting' : 'instant';
}

const emptyPlan = (unitKey, skillId) => ({
  unitKey, skillId, mode: null, modeName: null, kind: null,
  start: [], loop: [], end: [], ready: [], range: [], attacks: [], each: { cast: [], hit: [[]] }, trigger: [], targets: [],
  unmapped: [],
});

/**
 * The plan of a skill (module header).
 * @param {any} idx index.json
 * @param {string|null} unitKey  the owner's index unit (its modes name `modeName`)
 * @param {string} skillId
 * @param {{ rec?: any, describe?: (key: string) => any }} [opts]  rec: our skill record (plan.kind); describe: key →
 *   prefab descriptor or summary, for each entry's `point` / `follow` (anchorOf)
 */
export function skillPlan(idx, unitKey, skillId, opts = {}) {
  const id = lc(skillId);
  const plan = emptyPlan(unitKey || null, id);
  plan.kind = kindOf(opts.rec);
  const unit = unitKey && isObj(idx?.units) ? idx.units[unitKey] : null;
  const skill = (id && isObj(unit?.skills) && unit.skills[id]) || (id && isObj(idx?.skills) && idx.skills[id]) || null;
  if (!skill) return plan;
  if (Number.isInteger(skill.mode)) {
    plan.mode = skill.mode;
    plan.modeName = unit?.modes?.[skill.mode]?.name ?? null;
  }
  const prefabs = isObj(idx.prefabs) ? idx.prefabs : {};
  const uses = Array.isArray(skill.uses) ? skill.uses : [];
  const attacks = new Map();   // node|ability → { node, ability, cast, range, aim, all (every hit), grouped (_hitGroups) }
  const attackOf = (u) => {
    const k = `${u.node ?? ''}|${u.ability}`;
    let a = attacks.get(k);
    if (!a) { a = { node: u.node ?? null, ability: u.ability, cast: [], range: [], aim: [], all: [], grouped: [] }; attacks.set(k, a); }
    return a;
  };
  const eachHit = [];
  const miss = (key, role, reason, u) => { plan.unmapped.push({ key, role, reason, from: u.from }); };

  for (let i = 0; i < uses.length; i++) {
    const u = uses[i];
    if (!isObj(u) || !Array.isArray(u.keys)) continue;
    const role = u.role;
    const hook = typeof u.from === 'string' && u.from.endsWith(HOOK);
    const hooked = !hook && uses[i + 1]?.from === `${u.from}${HOOK}` && uses[i + 1]?.node === u.node;
    // a directional row is one effect picked by facing (slotKey): one entry carrying the slots; other rows play every key
    const directional = Array.isArray(u.slots) && u.slots.some(Boolean);
    for (const key0 of directional ? u.keys.slice(0, 1) : u.keys) {
      const key = lc(key0);
      if (!key) continue;
      if (!prefabs[key]) { miss(key, role, 'no-prefab', u); continue; }
      const e = entryOf(key, role, u, prefabs, opts.describe);
      if (hook) e.afterFirst = true;
      if (hooked) e.firstOnly = true;
      const placed = place(plan, e, u, { attackOf, eachHit });
      if (placed) miss(key, role, placed, u);
    }
  }
  for (const a of attacks.values()) {
    const groups = hitGroups(a.grouped);
    const hit = groups.length ? groups.map((g) => [...g, ...a.all]) : [a.all];
    plan.attacks.push({ node: a.node, ability: a.ability, cast: a.cast, range: a.range, aim: a.aim, hit: hit.filter((g) => g.length) });
  }
  plan.each.hit = [eachHit];
  return plan;
}

/** A plan entry of one key of a use (`prefabs`: index.json prefabs, the key's summary among them). */
function entryOf(key, role, u, prefabs, describe) {
  const e = { key, role, at: 'owner', loop: !!prefabs[key].looping, hold: null, from: u.from };
  for (const f of ['node', 'ability', 'list', 'startEvent', 'endEvent', 'directionType', 'event', 'action', 'buff', 'on']) {
    if (u[f] != null) e[f] = u[f];
  }
  // a slot without an extracted prefab plays nothing (null)
  if (Array.isArray(u.slots) && u.slots.length) e.slots = u.slots.map((x) => { const k = lc(x); return k && prefabs[k] ? k : null; });
  if (u.by === 'name') e.byName = true;
  if (typeof describe === 'function') {
    const a = anchorOf(describe(key));
    if (a) { e.point = a.point; e.follow = a.follow; }
  }
  return e;
}

/** Hold of an entry in a one-shot role: none, unless its prefab loops (then the cast's) [ASSUMED]. */
const oneShotHold = (e) => (e.loop ? 'cast' : null);

/**
 * Put one entry into the plan; returns an unmapped reason, or null when placed.
 * @returns {string|null}
 */
function place(plan, e, u, { attackOf, eachHit }) {
  const role = e.role;
  if (role === 'other') return 'other';
  if (PATH_FIELD.test(u.from)) return 'path';
  if (TILE_FIELD.test(u.from)) return 'tiles';
  if (role === 'ready') { e.hold = 'ready'; plan.ready.push(e); return null; }
  // emitter rows: relative to the cast of the ability they serve
  if (u.ability) {
    const held = u.oneshot === false || role === 'loop';
    if (isAttack(u.ability)) {
      const a = attackOf(u);
      if (role === 'hit') {
        e.at = 'target';
        e.hold = held ? 'cast' : oneShotHold(e);
        if (u.list === 'castTarget' || u.list === 'inputTarget') a.aim.push(e);   // on the targets at the cast, once
        else if (/_hitGroups$/.test(u.from)) a.grouped.push(e);
        else a.all.push(e);
        return null;
      }
      e.hold = held ? 'cast' : oneShotHold(e);
      if (role === 'range') a.range.push(e);
      else a.cast.push(e);
      return null;
    }
    if (role === 'hit') return isChannel(u.ability) ? 'channel-hit' : 'hit-no-attack';
    const skillLong = isChannel(u.ability) || (isLong(u.ability) && u.endEvent !== 'ON_CAST_END');
    if (role === 'range') {
      e.hold = held ? (skillLong ? 'skill' : 'cast') : oneShotHold(e);
      plan.range.push(e);
      return null;
    }
    if (role === 'end') { e.hold = oneShotHold(e); plan.end.push(e); return null; }
    if (held && skillLong) { e.hold = 'skill'; plan.loop.push(e); return null; }
    if (role === 'loop' || role === 'start') { e.hold = held ? 'cast' : oneShotHold(e); plan.start.push(e); return null; }
    if (role === 'cast') { e.hold = oneShotHold(e); plan.each.cast.push(e); return null; }
    return 'other';
  }
  // buffs, buff template actions, effect fields
  if (e.action === 'CreateBuffToToken' || u.on === 'token' || /_buffsToToken/.test(u.from)) return 'token';
  const onTargets = u.on === 'targets';
  const ev = u.event;
  if (ev && !START_EVENTS.has(ev)) {
    if (END_EVENTS.has(ev)) {
      if (role === 'loop') return 'after-end';
      if (onTargets) { e.at = 'targets'; e.hold = oneShotHold(e); plan.targets.push(e); return null; }
      e.hold = oneShotHold(e);
      plan.end.push(e);
      return null;
    }
    if (ev === 'ON_TAKE_DAMAGE') {
      if (onTargets) return 'conditional';
      e.hold = oneShotHold(e);
      plan.trigger.push(e);
      return null;
    }
    if (HIT_EVENTS.has(ev) && role === 'hit') { e.at = 'target'; e.hold = oneShotHold(e); eachHit.push(e); return null; }
    if (CAST_EVENTS.has(ev) && role !== 'loop') { e.hold = oneShotHold(e); plan.each.cast.push(e); return null; }
    // a periodic tick of the buff (an effect / damage action; a buff created there is a condition's visual state)
    if (ev === 'ON_BUFF_TRIGGER' && !/^CreateBuff/.test(u.action || '')) return 'tick';
    return 'conditional';
  }
  // at the skill (or its buff's) start, or no event
  if (role === 'hit') {
    if (/(ChannelingEffect\w*Emitter)\./.test(u.from)) return 'channel-hit';
    e.at = 'target';
    e.hold = oneShotHold(e);
    eachHit.push(e);
    return null;
  }
  if (role === 'cast') { e.hold = oneShotHold(e); plan.each.cast.push(e); return null; }
  if (role === 'trigger') return 'conditional';
  if (onTargets) { e.at = 'targets'; e.hold = role === 'loop' ? 'skill' : oneShotHold(e); plan.targets.push(e); return null; }
  if (role === 'loop') { e.hold = 'skill'; plan.loop.push(e); return null; }
  // a skill's begin effect (or its buff's start action) whose prefab loops lasts the skill: no cast stops it [ASSUMED]
  if (role === 'start') { e.hold = e.loop ? 'skill' : null; plan.start.push(e); return null; }
  if (role === 'end') { e.hold = oneShotHold(e); plan.end.push(e); return null; }
  if (role === 'range') { e.hold = e.loop ? 'skill' : null; plan.range.push(e); return null; }
  return 'other';
}

/**
 * The effects of one attack of the owner while the skill is on: the skill prefab's attack ability that fits the attack
 * (a heal → a /Heal/ ability, a ranged shot → /Ranged/, a melee blow → /Melee/; else the first), plus `each`.
 * @param {ReturnType<typeof skillPlan>} plan
 * @param {{ heal?: boolean, ranged?: boolean }} [what]
 * @returns {{ node: string|null, ability: string|null, cast: any[], range: any[], aim: any[], hit: any[][] }}
 */
export function attackFx(plan, { heal = false, ranged = false } = {}) {
  const list = plan?.attacks || [];
  const want = heal ? /Heal/ : ranged ? /Ranged/ : /Melee/;
  const a = list.find((x) => want.test(x.ability)) || (heal ? null : list.find((x) => !/Heal/.test(x.ability))) || list[0] || null;
  const each = plan?.each || { cast: [], hit: [[]] };
  const extra = each.hit?.[0] || [];
  const groups = a && a.hit.length ? a.hit.map((g) => [...g, ...extra]) : [extra];
  return {
    node: a ? a.node : null, ability: a ? a.ability : null,
    cast: [...(a ? a.cast : []), ...(each.cast || [])], range: a ? a.range : [], aim: a ? a.aim : [], hit: groups.filter((g) => g.length),
  };
}

/** Torappu SharedConsts.Direction: the slot of a facing. */
const DIR_SLOT = Object.freeze({ UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 });

/**
 * The key a directional row plays for a unit facing `dir` (UnitInfo.dir: 'UP' | 'RIGHT' | 'DOWN' | 'LEFT'): `slots`
 * indexed 0 UP, 1 RIGHT, 2 DOWN, 3 LEFT; an L_OR_R row (directionType 1) takes LEFT or RIGHT, a U_OR_D row (2) UP or
 * DOWN for the other facings [ASSUMED]; a row without slots plays its key.
 */
export function slotKey(entry, dir) {
  const slots = entry?.slots;
  if (!Array.isArray(slots) || !slots.length) return entry?.key ?? null;
  const d = DIR_SLOT[dir] ?? 1;
  let k = slots[d] || null;
  if (!k && entry.directionType === 1) k = slots[dir === 'LEFT' ? 3 : 1] || null;
  if (!k && entry.directionType === 2) k = slots[dir === 'UP' ? 0 : 2] || null;
  return k || slots.find(Boolean) || entry.key;
}

/** Every key a plan can play (slots included) — for preloading. */
export function planKeys(plan) {
  const out = new Set();
  const add = (e) => { if (!e) return; out.add(e.key); for (const s of e.slots || []) if (s) out.add(s); };
  for (const g of ['start', 'loop', 'end', 'ready', 'range', 'trigger', 'targets']) for (const e of plan?.[g] || []) add(e);
  for (const a of plan?.attacks || []) {
    for (const e of [...a.cast, ...a.range, ...(a.aim || [])]) add(e);
    for (const g of a.hit) for (const e of g) add(e);
  }
  for (const e of plan?.each?.cast || []) add(e);
  for (const g of plan?.each?.hit || []) for (const e of g) add(e);
  return [...out];
}

// ---- the 秘术师 charge ------------------------------------------------------------------------------------------------

/** Charge slots: one per stored energy — `spell` / `cast` keys and the MountPointType its projectile leaves from. */
const slotsOf = (names, mounts, spell, cast) => names.map((n, i) => ({ spell: spell(n), cast: cast(n), mount: mounts[i] }));

/**
 * The charge emitters of the roster's 秘术师, transcribed from the client's charpacks (26-09-13; module header). Slot k:
 * `spell` = the trait group emitter's _chargeEffectGroups[k] (played at the store's ON_SPELL_ON), `cast` = the store
 * ability's own groups (_chargeEffectGroups / _chargeCastGroups[k], at its ON_CAST_START), `mount` =
 * _mountPointForProjectiles[k] (the ability's, else the FollowMountPoint of the slot's effects); `cap` =
 * _maxChargeTimes; `projectiles` = the store abilities' _projectileKey by mode (a mode without a store ability of its
 * own uses Default [ASSUMED]).
 */
export const CHARGE_EMITTERS = Object.freeze({
  // Trait/ChargableAttackGroup: AbilityChargeableGroup (3) + MultiChargeUberEffectEmitter; ChargeAttack{Default,S1,S2}:
  // ChargeRangedAttack (_mountPointForProjectiles [6, 8, 9, 5]) + MultiChargeUberEffectEmitter (every group:
  // indigo_attack_charge_01_start at ON_CAST_START)
  char_469_indigo: {
    cap: 3,
    slots: slotsOf(['02', '03', '04', '05'], [6, 8, 9, 5], (n) => [`indigo_attack_charge_${n}`], () => ['indigo_attack_charge_01_start']),
    projectiles: { Default: 'projectile_chr_indigo', S1: 'projectile_chr_indigo_s1', S2: 'projectile_chr_indigo_s2' },
  },
  // Trait/ChargeAttackGroup: AbilityExChargeGroup; ExChargeAttack{Default,S1}: ExChargeRangedAttack (3, [5, 6, 8, 9],
  // _exProjectileKey …_elite) + two MultiExChargeUberEffectEmitters (normal: orange; _isExEffectEmitter: the talent's elite
  // energy, red_5 at Special4); ExChargeAttackS3: _forceExCharge, groups red … red_5 (no mounts of its own: the effects')
  char_4046_ebnhlz: {
    cap: 3,
    slots: slotsOf(['', '_2', '_3', '_4'], [5, 6, 8, 9], (n) => [`ebnhlz_attack_charge_orange${n}`, `ebnhlz_attack_buff_orange${n}`], (n) => [`ebnhlz_attack_start_02_orange${n}`]),
    elite: slotsOf(['_5'], [10], (n) => [`ebnhlz_attack_charge_red${n}`, `ebnhlz_attack_buff_red${n}`], (n) => [`ebnhlz_attack_start_02_red${n}`]),
    eliteS3: slotsOf(['', '_2', '_3', '_4', '_5'], [5, 6, 8, 9, 10], (n) => [`ebnhlz_attack_charge_red${n}`, `ebnhlz_attack_buff_red${n}`], (n) => [`ebnhlz_attack_start_02_red${n}`]),
    projectiles: { Default: 'projectile_chr_ebnhlz_charge', S1: 'projectile_chr_ebnhlz_s1_charge', S3: 'projectile_chr_ebnhlz_s3_elite_charge' },
    eliteProjectiles: { Default: 'projectile_chr_ebnhlz_elite', S1: 'projectile_chr_ebnhlz_s1_elite', S3: 'projectile_chr_ebnhlz_s3_elite_charge' },
  },
  // Trait/ChargeableGroup: AbilityChargeableGroup (9) + MergeableChargeUberEffectEmitter (_mergeSize 3: every 3 stored
  // energies merge into one 转置能量 slot — _mergedChargeEffectGroups / _mergedChargeCastGroups); ChargeAttack{Default,S2,S3}:
  // MergeableChargeRangeAttack ([5, 6, 8, 9, 10], _mergeProjectileKey …_merged)
  char_4226_veen: {
    cap: 9,
    slots: slotsOf(['', '_2', '_3', '_4', '_5'], [5, 6, 8, 9, 10], (n) => [`veen_telent_01_rank_01${n}`, `veen_telent_01_rank_01_change${n}`], (n) => [`veen_telent_01_rank_01_change${n}`]),
    merged: slotsOf(['', '_2', '_3', '_4'], [5, 6, 8, 9], (n) => [`veen_telent_01_rank_02${n}`, `veen_telent_01_rank_02_change${n}`], (n) => [`veen_telent_01_rank_02_change${n}`]),
    mergeSize: 3,
    projectiles: { Default: 'projectile_chr_veen', S2: 'projectile_chr_veen_s2', S3: 'projectile_chr_veen_s3' },
    mergedProjectiles: { Default: 'projectile_chr_veen_merged', S2: 'projectile_chr_veen_s2_merged' },
  },
});

/** One slot list of a charge emitter → plan slots, keys checked against the index (absent ones go to `missing`). */
function chargeSlots(list, prefabs, missing) {
  return (list || []).map((s) => {
    const ok = (k) => { if (prefabs[k]) return true; missing.push(k); return false; };
    const spell = s.spell.filter(ok), cast = s.cast.filter(ok);
    return {
      hold: spell.filter((k) => prefabs[k].looping),     // stays while the energy is stored
      gain: [...cast, ...spell.filter((k) => !prefabs[k].looping)],   // one-shots of the store (cast start, spell on)
      mount: mountPointName(s.mount),                     // where its projectile leaves from
    };
  });
}

/**
 * A 秘术师's stored-energy plan, or null for a unit without a charge emitter (CHARGE_EMITTERS) or one index.json lacks.
 * byCount[n]: the loops lit with n stored (cumulative: slots 1…n); onGain[n]: the one-shots of the n-th store; onRelease:
 * the loops stop and n projectiles leave from `mounts[0…n−1]` (the mode's `projectiles` key). `elite` / `eliteS3` /
 * `merged`: 黑键's and 维伊's other stores (no client signal drives them — header).
 */
export function chargePlan(idx, unitKey) {
  const src = CHARGE_EMITTERS[unitKey];
  if (!src || !isObj(idx?.units?.[unitKey])) return null;
  const prefabs = isObj(idx.prefabs) ? idx.prefabs : {};
  const missing = [];
  const slots = chargeSlots(src.slots, prefabs, missing);
  const plan = {
    unitKey, cap: src.cap, slots, byCount: {}, onGain: {},
    onRelease: { stop: 'hold', mounts: slots.map((s) => s.mount), projectiles: { ...src.projectiles } },
    elite: src.elite ? chargeSlots(src.elite, prefabs, missing) : null,
    eliteS3: src.eliteS3 ? chargeSlots(src.eliteS3, prefabs, missing) : null,
    merged: src.merged ? chargeSlots(src.merged, prefabs, missing) : null,
    mergeSize: src.mergeSize ?? null,
    missing: [...new Set(missing)],
  };
  if (src.eliteProjectiles) plan.onRelease.eliteProjectiles = { ...src.eliteProjectiles };
  if (src.mergedProjectiles) plan.onRelease.mergedProjectiles = { ...src.mergedProjectiles };
  const projs = isObj(idx.projectiles) ? idx.projectiles : {};
  for (const set of [src.projectiles, src.eliteProjectiles, src.mergedProjectiles]) {
    for (const k of Object.values(set || {})) if (!projs[k] && !plan.missing.includes(k)) plan.missing.push(k);
  }
  for (let n = 1; n <= slots.length; n++) {
    plan.byCount[n] = slots.slice(0, n).flatMap((s) => s.hold);
    plan.onGain[n] = slots[n - 1].gain.slice();
  }
  return plan;
}

/**
 * What changes when the stored count goes `prev` → `next` (both clamped to the plan's slots): `gain` one-shots to play
 * (the stores in order), `light` / `dim` the slot indexes (0-based) whose loops start / stop, `released` the energies
 * that left (a drop — a release with an attack, or a reset on redeploy).
 * @returns {{ gain: string[], light: number[], dim: number[], released: number }}
 */
export function chargeStep(plan, prev, next, slots = plan?.slots) {
  const n = Array.isArray(slots) ? slots.length : 0;
  const a = Math.max(0, Math.min(n, Math.floor(Number(prev) || 0)));
  const b = Math.max(0, Math.min(n, Math.floor(Number(next) || 0)));
  const out = { gain: [], light: [], dim: [], released: 0 };
  for (let i = a; i < b; i++) { out.gain.push(...slots[i].gain); out.light.push(i); }
  for (let i = b; i < a; i++) out.dim.push(i);
  out.released = Math.max(0, a - b);
  return out;
}

/** Every key of a charge plan (preloading). */
export function chargeKeys(plan) {
  const out = new Set();
  for (const list of [plan?.slots, plan?.elite, plan?.eliteS3, plan?.merged]) {
    for (const s of list || []) for (const k of [...s.hold, ...s.gain]) out.add(k);
  }
  return [...out];
}
