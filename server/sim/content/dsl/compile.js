// server/sim/content/dsl/compile.js — compile a P2 DSL spec into a Kit (DESIGN §32.7).
//
// C2: compileDsl(spec, { bb, chess, def }) → Kit, the same shape a kit function returns. WP-A dispatches
// def.raw.dsl from kitOf and may leave a stub at this path; this module is the real compiler. Tests call
// compileDsl directly and inject the kit with makeBattle({ kits }). This file does not edit kitOf.
//
// Values inside SkillSpec fields (mods, ammo, attack, targeting) are resolved when the kit is built, because the
// engine stores those numbers on the spec. Action lists resolve again when they fire, so {stat} sees the live unit.
// Omitting duration / spCost / initSp keeps the chess record's values. Omitting ammo does not: the engine reads
// `+spec.ammo || 0`, so an ammo skill must set ammo.

import { num } from '../kits/shared/tier1.js';
import { validateDsl, formatProblems } from './validate.js';
import {
  resolveValue, resolveMods, skillCallback, installTrigger, DEFAULT_BUDGET,
} from './vocab.js';

export { DEFAULT_BUDGET };

function pluginIdOf(spec, opts) {
  return (spec && spec.pluginId) || (opts && opts.pluginId) || (opts && opts.def && opts.def.raw && opts.def.raw.pluginId) || 'dsl';
}

function rangeGridOf(v, env) {
  if (v === 'skill') return env.def && env.def.skill ? env.def.skill.rangeGrid ?? null : null;
  if (v === 'own') return env.def ? env.def.rangeGrid ?? null : null;
  if (Array.isArray(v)) return v;
  return null;
}

function compileTargeting(tg, env) {
  if (!tg || typeof tg !== 'object') return null;
  const out = {};
  if (tg.rangeGrid != null) {
    const g = rangeGridOf(tg.rangeGrid, env);
    if (g) out.rangeGrid = g;
  }
  if (typeof tg.priority === 'string') out.priority = tg.priority;
  if (tg.maxTargets != null) out.maxTargets = resolveValue(tg.maxTargets, env, null);
  if (tg.rangeExtend != null) out.rangeExtend = resolveValue(tg.rangeExtend, env, null);
  if (tg.noRangeExtend) out.noRangeExtend = true;
  if (tg.showOwnRange) out.showOwnRange = true;
  if (tg.allInRange) out.allInRange = true;
  return Object.keys(out).length ? out : null;
}

function compileAttack(atk, env) {
  if (!atk || typeof atk !== 'object') return null;
  const out = {};
  for (const k of ['atkScale', 'splashRadius', 'maxTargets']) {
    if (atk[k] != null) out[k] = typeof atk[k] === 'number' ? atk[k] : resolveValue(atk[k], env, null);
  }
  if (typeof atk.dmgType === 'string') out.dmgType = atk.dmgType;
  if (atk.onHitStatus && typeof atk.onHitStatus === 'object') {
    out.onHitStatus = {
      key: atk.onHitStatus.key,
      duration: atk.onHitStatus.duration != null ? resolveValue(atk.onHitStatus.duration, env, null) : undefined,
    };
  }
  return Object.keys(out).length ? out : null;
}

function compileSkill(sk, env) {
  const spec = {};
  if (sk.kind) spec.kind = sk.kind;
  if (typeof sk.id === 'string') spec.id = sk.id;
  for (const k of ['duration', 'ammo', 'spCost', 'initSp']) {
    if (sk[k] != null) spec[k] = typeof sk[k] === 'number' ? sk[k] : resolveValue(sk[k], env, null);
  }
  if (sk.charges != null) spec.charges = typeof sk.charges === 'number' ? sk.charges : resolveValue(sk.charges, env, null);
  if (typeof sk.spType === 'string') spec.spType = sk.spType;
  if (sk.trigger != null) spec.trigger = sk.trigger;
  if (sk.heal != null) spec.heal = !!sk.heal;
  if (sk.activateOnDeploy) spec.activateOnDeploy = true;
  if (sk.mods) spec.mods = resolveMods(sk.mods, env, null);
  if (sk.flags) {
    const flags = {};
    for (const [k, v] of Object.entries(sk.flags)) flags[k] = typeof v === 'boolean' ? v : !!resolveValue(v, env, null);
    spec.flags = flags;
  }
  const tg = compileTargeting(sk.targeting, env);
  if (tg) spec.targeting = tg;
  const attack = compileAttack(sk.attack, env);
  if (attack) spec.attack = attack;
  const on = sk.on || null;
  if (on && Array.isArray(on.start)) spec.onStart = skillCallback(on.start, env);
  if (on && Array.isArray(on.end)) spec.onEnd = skillCallback(on.end, env);
  if (on && Array.isArray(on.hit)) spec.onHit = skillCallback(on.hit, env);
  if (on && Array.isArray(on.attack)) spec.onAttack = skillCallback(on.attack, env);
  if (on && Array.isArray(on.tick)) spec.onTick = skillCallback(on.tick, env);
  return spec;
}

function compileTrait(tr, env) {
  const out = {};
  if (tr.onHitStatus && typeof tr.onHitStatus === 'object') {
    out.onHitStatus = {
      key: tr.onHitStatus.key,
      duration: tr.onHitStatus.duration != null ? resolveValue(tr.onHitStatus.duration, env, null) : undefined,
    };
  }
  if (tr.mods) out.mods = resolveMods(tr.mods, env, null);
  return Object.keys(out).length ? out : null;
}

/**
 * Compile `spec` into a Kit. Throws when validateDsl reports a problem; the message includes the PLUGIN_DSL_* code.
 * @param {object} spec
 * @param {{ bb?: object, chess?: object, def?: object, pluginId?: string }} [opts]
 * @returns {object} Kit
 */
export function compileDsl(spec, opts = {}) {
  const checked = validateDsl(spec);
  if (!checked.ok) {
    const err = new Error(formatProblems(checked.problems));
    err.code = checked.problems[0] && checked.problems[0].code;
    throw err;
  }
  const env = {
    bb: opts.bb || {},
    chess: opts.chess || null,
    def: opts.def || null,
    pluginId: pluginIdOf(spec, opts),
    // [ASSUMED] default 8000, overridable by spec.budget.
    budget: spec.budget != null ? spec.budget : DEFAULT_BUDGET,
    spec,
  };
  const kit = {};
  const skills = {};
  if (spec.skills && typeof spec.skills === 'object') {
    for (const [id, sk] of Object.entries(spec.skills)) skills[id] = compileSkill(sk, env);
  }
  if (Object.keys(skills).length) kit.skills = skills;
  if (spec.skill && typeof spec.skill === 'object') kit.skill = compileSkill(spec.skill, env);
  else if (skills.default) {
    kit.skill = skills.default;
    delete skills.default;
    if (!Object.keys(skills).length) delete kit.skills;
  }
  if (Array.isArray(spec.talents) && spec.talents.length) {
    kit.talents = spec.talents.map((talent) => ({
      install(battle, unit) { installTrigger(talent, battle, unit, env); },
    }));
  }
  if (spec.trait) {
    const trait = compileTrait(spec.trait, env);
    if (trait) kit.trait = trait;
  }
  // Touch num so a numeric blackboard string still follows the kit helper if a caller resolves ahead of us.
  void num;
  return kit;
}
