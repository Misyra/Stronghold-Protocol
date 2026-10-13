// server/match/dslMeta.js — prep-phase minimum of a P2 DSL spec (DESIGN §32.7).
//
// roundStart / income / buy / sell / refresh / merge / levelUp / battleResult map onto MetaRegistry hooks.
// Actions are funds / layers / gainItem, through the ctx helpers (addFunds / addLayers / grantItem).
// This module is not imported by the sim, and it does not register itself on the default registry: a test or a
// later content-set builder calls registerDslMeta on a registry it owns.
//
// [ASSUMED] The battle action budget does not apply here. Prep work is one dispatch per hook, already capped by
// EffectDispatcher. [ASSUMED] `funds.setIncome: true` writes `ev.income` (Math.trunc, never below 0), including 0,
// and leaves a pre-set income alone when the condition does not match — the shape of 老鲤's give_coin_in_round,
// which does not call addFunds. [ASSUMED] `if.round` is an integer compared with `ctx.round`.

import { validateDsl, formatProblems } from '../sim/content/dsl/validate.js';
import { evalCond, resolveValue } from '../sim/content/dsl/vocab.js';

const HOOK = Object.freeze({
  roundStart: 'onRoundStart',
  income: 'onIncome',
  buy: 'onBuy',
  sell: 'onSold',
  refresh: 'onRefresh',
  merge: 'onMerge',
  levelUp: 'onLevelUp',
  battleResult: 'onBattleResult',
});

function fail(code, path, zh) {
  const err = new Error(`${code} ${path}: ${zh}`);
  err.code = code;
  return err;
}

function prepCond(cond, ctx, env) {
  if (cond == null) return true;
  if (typeof cond !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(cond, 'round') && ctx.round !== cond.round) return false;
  const rest = { ...cond };
  delete rest.round;
  if (!Object.keys(rest).length) return true;
  // Battle conditions (chance last). Without a unit, a unit condition is false and does not draw rng.
  const rt = { battle: { rng: ctx.rng || null }, unit: null, env, target: null, source: null, pluginId: env.pluginId };
  return evalCond(rest, rt);
}

function runPrep(node, ctx, ev, env) {
  if (!node || typeof node !== 'object') return;
  if (node.funds && typeof node.funds === 'object') {
    const n = Math.trunc(resolveValue(node.funds.amount, env, null));
    if (node.funds.setIncome) {
      if (ev) ev.income = Math.max(0, n);
      return;
    }
    if (typeof ctx.addFunds === 'function') ctx.addFunds(n);
    return;
  }
  if (node.layers && typeof node.layers === 'object') {
    const n = Math.trunc(resolveValue(node.layers.amount, env, null));
    if (n !== 0 && typeof node.layers.bond === 'string' && typeof ctx.addLayers === 'function') {
      ctx.addLayers(node.layers.bond, n, { reason: 'plugin:' + env.pluginId });
    }
    return;
  }
  if (node.gainItem && typeof node.gainItem === 'object') {
    const id = node.gainItem.item;
    if (typeof id === 'string' && id && typeof ctx.grantItem === 'function') {
      ctx.grantItem(id, { source: 'plugin:' + env.pluginId });
    }
  }
}

/**
 * Compile `spec.meta` into a MetaRegistry handler object. Throws when the spec is not valid; the message
 * contains the PLUGIN_DSL_* code. Does not register anything.
 * @param {object} spec
 * @returns {object}
 */
export function compileDslMeta(spec) {
  const checked = validateDsl(spec);
  if (!checked.ok) throw fail(checked.problems[0].code, checked.problems[0].path, formatProblems(checked.problems));
  const meta = spec && spec.meta;
  if (!meta || !Array.isArray(meta.on)) throw fail('PLUGIN_DSL_META', 'meta', '备战规格需要 meta.on');
  const env = {
    bb: {},
    chess: null,
    def: null,
    pluginId: (spec && spec.pluginId) || 'dsl',
    budget: spec.budget != null ? spec.budget : 0,
    spec,
  };
  const lists = {};
  for (const entry of meta.on) {
    const name = HOOK[entry.when];
    if (!name) continue;
    if (!lists[name]) lists[name] = [];
    lists[name].push(entry);
  }
  const handler = {};
  for (const [name, entries] of Object.entries(lists)) {
    handler[name] = (ctx, ev) => {
      for (const entry of entries) {
        if (!prepCond(entry.if, ctx, env)) continue;
        const actions = Array.isArray(entry.do) ? entry.do : [];
        for (const action of actions) runPrep(action, ctx, ev, env);
      }
    };
  }
  return handler;
}

/**
 * Validate, compile and register under `spec.meta.key` (a later register of the same key replaces this one,
 * which is MetaRegistry's own rule).
 * @param {{ register: Function }} registry
 * @param {object} spec
 */
export function registerDslMeta(registry, spec) {
  const key = spec && spec.meta && spec.meta.key;
  if (typeof key !== 'string' || !key) throw fail('PLUGIN_DSL_META', 'meta.key', '注册需要 meta.key');
  const handler = compileDslMeta(spec);
  registry.register(key, handler);
  return handler;
}
