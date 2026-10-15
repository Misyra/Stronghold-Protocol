#!/usr/bin/env node
// tools/vfx-skill-coverage.mjs — how many skills of this game's roster get an official-effects plan
// (public/js/render/vfx/skills.js, DESIGN §33 — 0.3.0 Phase 3a), per role, and what stays unmapped and why; and what the
// battle view plays of them (render/vfx/skillfx.js, Phase 3b: every role on its signal; `targets` split into the
// attack-borne buffs it places, the status loops the status wiring draws and the rest; the `pulse` rows a kit's own fx
// can stand for; FX_BINDINGS; the 秘术师 charge). Read-only.
//
// Usage: node tools/vfx-skill-coverage.mjs [--index <path>] [--json] [--list] [--anchors]
//   --index    index.json of an extraction (default public/assets/local/fx/index.json, tools/local-extract fx.py)
//   --json     the report as JSON on stdout
//   --list     also print every unmapped key (unit, skill, key, role, reason) and the skills without a plan
//   --anchors  read the prefab descriptors next to the index for the entries' SpawnLocation (slower)
// Roster: data/chess.json (every record's equipped and selectable skills), data/backups.json `units` (the 补位 / 自选
// forms' skills), the summons (data/tokens.json, data/backups.json `tokens`: the token's own skills) and
// data/enemies.json (each enemy's `skills[].prefabKey`). A skill counts once per (unit, skill). Without an index the
// tool says so and exits 0. Unknown options are errors (exit code 2).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveSkill, skillPlan, chargePlan, chargeKeys, unitKeyOf, targetsOf, CHARGE_EMITTERS, UNMAPPED, SIGNALS, FX_BINDINGS, bindingKeys,
} from '../public/js/render/vfx/skills.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_INDEX = path.join(ROOT, 'public/assets/local/fx/index.json');
const USAGE = 'usage: node tools/vfx-skill-coverage.mjs [--index <path>] [--json] [--list] [--anchors]';

/** The plan groups counted per role (a skill counts in a group when it has ≥ 1 entry there). */
export const ROLE_GROUPS = Object.freeze(['start', 'loop', 'end', 'ready', 'range', 'attack.cast', 'attack.range', 'attack.aim',
  'attack.hit', 'each.cast', 'each.hit', 'trigger', 'targets']);

function parseArgs(argv) {
  const o = { index: DEFAULT_INDEX, json: false, list: false, anchors: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--list') o.list = true;
    else if (a === '--anchors') o.anchors = true;
    else if (a === '--index' && argv[i + 1]) o.index = path.resolve(argv[++i]);
    else return null;
  }
  return o;
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

/** Every `{ skillId }` object under a `skill` key of a token record (its own, per variant, per owner skill / module). */
function tokenSkills(t, out = [], depth = 0) {
  if (!t || typeof t !== 'object' || depth > 5) return out;
  for (const [k, v] of Object.entries(t)) {
    if (k === 'skill' && v && typeof v.skillId === 'string') { if (!out.some((s) => s.skillId === v.skillId)) out.push(v); }
    else if (v && typeof v === 'object') tokenSkills(v, out, depth + 1);
  }
  return out;
}

/**
 * The roster: [{ group: 'operators'|'tokens'|'enemies', id (charId / token / enemy key), skill (our record) }], unique
 * per (id, skill id).
 * @param {{ chess?: any, backups?: any, tokens?: any, enemies?: any }} data
 */
export function roster({ chess = {}, backups = {}, tokens = {}, enemies = {} } = {}) {
  const out = [];
  const seen = new Set();
  const add = (group, id, s) => {
    const sid = s && (s.prefabId || s.skillId || s.prefabKey);
    if (!id || !sid) return;
    const k = `${group}|${id}|${String(sid).toLowerCase().replace(/\[\d+\]$/, '')}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ group, id, skill: s });
  };
  for (const c of Object.values(chess || {})) {
    if (!c || !c.charId) continue;
    for (const s of [c.skill, ...(Array.isArray(c.skills) ? c.skills : [])]) if (s) add('operators', c.charId, s);
  }
  for (const [cid, u] of Object.entries(backups?.units || {})) {
    for (const f of Object.values(u?.forms || {})) for (const s of Array.isArray(f?.skills) ? f.skills : []) add('operators', u.charId || cid, s);
  }
  const toks = { ...(backups?.tokens || {}), ...(tokens || {}) };
  for (const [id, t] of Object.entries(toks)) for (const s of tokenSkills(t)) add('tokens', id, s);
  for (const [key, e] of Object.entries(enemies || {})) {
    for (const s of Array.isArray(e?.skills) ? e.skills : []) add('enemies', key, s);
  }
  return out;
}

const groupStats = () => ({
  skills: 0, resolved: 0, planned: 0, targetsOnly: 0, modeOnly: 0, empty: 0, notResolved: {},
  roles: Object.fromEntries(ROLE_GROUPS.map((g) => [g, 0])), unmapped: {}, entries: 0, placed: 0,
  // Phase 3b (render/vfx/skillfx.js): `targets` entries by what the client can do with them, skills with pulse rows
  targets: { hit: 0, status: 0, none: 0 }, pulseSkills: 0, pulseEntries: 0,
});

/**
 * The coverage report (module header).
 * @param {any} idx index.json
 * @param {{ chess?: any, backups?: any, tokens?: any, enemies?: any }} data
 * @param {{ describe?: (key: string) => any }} [opts]
 */
export function coverage(idx, data, opts = {}) {
  const groups = { operators: groupStats(), tokens: groupStats(), enemies: groupStats() };
  const unmapped = [];
  const unplanned = [];
  const anchors = {};
  const list = roster(data);
  for (const r of list) {
    const g = groups[r.group];
    g.skills++;
    const unitKey = unitKeyOf(idx, [r.id]);
    // an enemy's skill: index v2's `units[enemy].skills`, keyed by the lower-case prefabKey of data/enemies.json
    const ekey = r.group === 'enemies' ? String(r.skill.prefabKey || '').toLowerCase() : null;
    const res = ekey
      ? { unitKey, skillId: ekey, skill: (unitKey && idx.units[unitKey]?.skills?.[ekey]) || null, reason: null }
      : resolveSkill(idx, { unitKey, rec: { charId: r.id, skill: r.skill, skills: [r.skill] }, skillIndex: r.skill.index });
    if (!res.skill) {
      const why = !unitKey ? 'no-unit' : r.group === 'enemies' ? 'enemy-skill' : r.group === 'tokens' ? 'token-skill' : res.reason || 'not-in-index';
      g.notResolved[why] = (g.notResolved[why] || 0) + 1;
      unplanned.push({ group: r.group, unit: r.id, skill: res.skillId || r.skill.skillId || r.skill.prefabKey, reason: why });
      continue;
    }
    g.resolved++;
    const plan = skillPlan(idx, res.unitKey, res.skillId, { rec: r.skill, describe: opts.describe });
    const has = {
      start: plan.start.length, loop: plan.loop.length, end: plan.end.length, ready: plan.ready.length, range: plan.range.length,
      'attack.cast': plan.attacks.some((a) => a.cast.length), 'attack.range': plan.attacks.some((a) => a.range.length),
      'attack.aim': plan.attacks.some((a) => a.aim.length),
      'attack.hit': plan.attacks.some((a) => a.hit.length), 'each.cast': plan.each.cast.length, 'each.hit': plan.each.hit[0].length,
      trigger: plan.trigger.length, targets: plan.targets.length,
    };
    for (const k of ROLE_GROUPS) if (has[k]) g.roles[k]++;
    const drivable = ROLE_GROUPS.some((k) => k !== 'targets' && has[k]);
    if (drivable) g.planned++;
    else if (has.targets) g.targetsOnly++;
    else if (plan.mode != null) g.modeOnly++;
    else g.empty++;
    if (!drivable) unplanned.push({ group: r.group, unit: r.id, skill: res.skillId, reason: has.targets ? 'targets-only' : plan.mode != null ? 'mode-only' : 'no-effects' });
    const tg = targetsOf(idx, plan);
    for (const k of ['hit', 'status', 'none']) g.targets[k] += tg[k].length;
    if (plan.pulse.length) { g.pulseSkills++; g.pulseEntries += plan.pulse.length; }
    const entries = entriesOf(plan);
    g.placed += entries.length;
    g.entries += entries.length + plan.unmapped.length;
    for (const u of plan.unmapped) {
      g.unmapped[u.reason] = (g.unmapped[u.reason] || 0) + 1;
      unmapped.push({ group: r.group, unit: r.id, skill: res.skillId, key: u.key, role: u.role, reason: u.reason, from: u.from });
    }
    if (opts.describe) for (const e of entries) { const k = `${e.at}:${e.point ?? '?'}`; anchors[k] = (anchors[k] || 0) + 1; }
  }
  const charge = [];
  // the 秘术师: index v2's chargeable groups (units[id].charge), the transcribed table for a version-1 index
  const chargeUnits = new Set([...Object.keys(CHARGE_EMITTERS), ...Object.keys(idx?.units || {}).filter((k) => Array.isArray(idx.units[k]?.charge))]);
  for (const unitKey of chargeUnits) {
    const p = chargePlan(idx, unitKey);
    const inRoster = list.some((r) => r.id === unitKey);
    const source = Array.isArray(idx?.units?.[unitKey]?.charge) ? 'index v2' : 'CHARGE_EMITTERS';
    charge.push(p
      ? { unit: unitKey, inRoster, source, slots: p.slots.length, keys: chargeKeys(p).length, missing: p.missing,
        signal: unitKey === 'char_469_indigo' ? 'b.snap energy (PR #636)' : 'none (kit-private store)' }
      : { unit: unitKey, inRoster, source, slots: 0, keys: 0, missing: ['(unit not in index.json)'], signal: null });
  }
  const bindings = Object.entries(FX_BINDINGS).map(([skill, kinds]) => ({ skill, kinds: Object.keys(kinds), keys: bindingKeys(idx, skill) }));
  return {
    index: { set: idx?.set ?? null, client: idx?.source?.client ?? null, version: idx?.version ?? 1, skills: Object.keys(idx?.skills || {}).length },
    groups, unmapped, unplanned, charge, bindings, attacks: attackCoverage(idx), ...(opts.describe ? { anchors } : {}),
  };
}

/**
 * The units' own attacks (render/vfx/wiring.js: every 'atk' plays them): per kind, the units with official attack rows
 * (their modes' `attack` and — index v2 — `combat` and sub-abilities), and the v2 parts — combats, sub-ability groups,
 * MultiHit hit groups, UberAnimation replace groups, other emitters, charge groups.
 */
export function attackCoverage(idx) {
  const out = {};
  const rowsOf = (a, depth = 0) => {
    if (!a || depth > 4) return 0;
    let n = 0;
    for (const l of ['cast', 'hit', 'castTarget', 'inputTarget']) n += (a[l] || []).length;
    for (const x of a.abilities || []) n += rowsOf(x, depth + 1);
    return n;
  };
  for (const u of Object.values(idx?.units || {})) {
    const k = u.kind || 'other';
    const o = out[k] || (out[k] = { units: 0, withRows: 0, combat: 0, combatOnly: 0, groups: 0, multiHit: 0, animGroups: 0, emitters: {}, charge: 0 });
    o.units++;
    let rows = 0;
    for (const m of u.modes || []) {
      rows += rowsOf(m.attack) + rowsOf(m.combat);
      if (m.combat) { o.combat++; if (!m.attack) o.combatOnly++; }
      for (const a of [m.attack, m.combat]) {
        if (!a) continue;
        if ((a.abilities || []).length) o.groups++;
        for (const em of a.emitters || []) {
          o.emitters[em.class] = (o.emitters[em.class] || 0) + 1;
          if (em.class === 'MultiHitUberEffectEmitter') o.multiHit++;
          if (em.class === 'UberAnimationEffectEmitter') o.animGroups++;
        }
      }
    }
    if (rows) o.withRows++;
    if (Array.isArray(u.charge) && u.charge.length) o.charge++;
  }
  return out;
}

/** What the battle view does with each role (render/vfx/skillfx.js, Phase 3b): the coverage tool prints it. */
export const RUNTIME = Object.freeze({
  'start / range / loop / end': "played on ['skill', id, 1 / 0]; loops held for the skill (UF.SKILL for a view built mid-battle, the deploy for a passive)",
  ready: 'looped while b.snap sp >= spMax > 0 and the skill is off',
  'attack.*': "each 'atk' of the owner while on: the skill's own ability replaces the mode's rows (cast / range on the owner, aim on the target, hit groups by the frame's damage order, its projectile)",
  'each.*': "each 'atk' while on, beside the mode's rows",
  trigger: "a 'dmg' on the owner while on (once a frame)",
  'targets.hit': "on each target of the skill's attacks, for the buff's blackboard duration (else while the skill lasts); a status loop of the same key takes over",
  'targets.status': 'drawn by the status wiring when the sim reports that status',
  'targets.none': 'not drawn (no signal names the carrier)',
  pulse: "bound to the kit's own fx of the skill (extra.skill) at the owner (a tick) or away from it (the skill's hits)",
  charge: 'b.snap energy (深靛 and the shared mystic store); 黑键 / 维伊 keep their stores kit-private',
  'enemy skills': "b.ev ['cast', id, slot] (none on this line yet), else the snapshot's skill window (anim SKILL) of a single-skill enemy",
  'mode attacks (v2)': "a blocked melee blow plays the mode's combat; a group plays its sub-abilities; MultiHit groups by the hit's order; UberAnimation groups by the animation",
});

/** Every placed entry of a plan. */
function entriesOf(plan) {
  const out = [];
  for (const g of ['start', 'loop', 'end', 'ready', 'range', 'trigger', 'targets']) out.push(...plan[g]);
  for (const a of plan.attacks) { out.push(...a.cast, ...a.range, ...a.aim); for (const h of a.hit) out.push(...h); }
  out.push(...plan.each.cast);
  for (const h of plan.each.hit) out.push(...h);
  return out;
}

/** Prefab descriptors next to an index.json (for --anchors), cached. */
function descriptorReader(indexPath, idx) {
  const dir = path.dirname(indexPath);
  const cache = new Map();
  return (key) => {
    if (cache.has(key)) return cache.get(key);
    const file = idx?.prefabs?.[key]?.file;
    const d = file ? readJson(path.join(dir, file)) : null;
    cache.set(key, d);
    return d;
  };
}

function printReport(rep, { list = false } = {}) {
  const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10} %` : '—');
  console.log(`index.json: set ${rep.index.set}, client ${rep.index.client}, ${rep.index.skills} skills`);
  for (const [name, g] of Object.entries(rep.groups)) {
    console.log(`\n${name}: ${g.skills} (unit, skill) pairs — ${g.resolved} found in index.json, ${g.planned} with a plan the client can drive (${pct(g.planned, g.skills)}), ${g.targetsOnly} targets only, ${g.modeOnly} mode only, ${g.empty} without effects`);
    const nr = Object.entries(g.notResolved);
    if (nr.length) console.log(`  not in index.json: ${nr.map(([k, v]) => `${k} ${v}`).join(', ')}`);
    if (g.resolved) {
      console.log(`  skills per role: ${ROLE_GROUPS.map((k) => `${k} ${g.roles[k]}`).join(', ')}`);
      console.log(`  effect keys: ${g.entries} — ${g.placed} placed, ${g.entries - g.placed} unmapped${Object.keys(g.unmapped).length ? ` (${Object.entries(g.unmapped).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
      console.log(`  targets entries: ${g.targets.hit} on the skill attacks' targets, ${g.targets.status} by the status wiring, ${g.targets.none} not drawn; pulse rows: ${g.pulseEntries} in ${g.pulseSkills} skills (bound to the kit's own fx)`);
    }
  }
  if (rep.attacks) {
    console.log(`\nunits' own attacks (index version ${rep.index.version}; render/vfx/wiring.js):`);
    for (const [k, o] of Object.entries(rep.attacks)) {
      console.log(`  ${k}: ${o.withRows} of ${o.units} with attack rows; ${o.combat} modes with a combat (${o.combatOnly} its only attack), ${o.groups} sub-ability groups, ${o.multiHit} MultiHit and ${o.animGroups} UberAnimation emitters, ${o.charge} charge groups`);
    }
  }
  console.log('\nwired at runtime (render/vfx/skillfx.js, Phase 3b / 3c):');
  for (const [k, v] of Object.entries(RUNTIME)) console.log(`  ${k.padEnd(27)} ${v}`);
  console.log('\nkit fx bound to official effects (FX_BINDINGS):');
  for (const b of rep.bindings) console.log(`  ${b.skill}: ${b.kinds.join(', ')} → ${b.keys.join(' ') || '(keys not in this index)'}`);
  console.log('\nunmapped reasons:');
  for (const [k, v] of Object.entries(UNMAPPED)) console.log(`  ${k.padEnd(14)} ${v}`);
  console.log('\nsignals:');
  for (const [k, v] of Object.entries(SIGNALS)) console.log(`  ${k.padEnd(8)} ${v}`);
  console.log('\n秘术师 charge (index v2 units[id].charge; CHARGE_EMITTERS for a version-1 index):');
  for (const c of rep.charge) console.log(`  ${c.unit}${c.inRoster ? '' : ' (not in the roster)'}: ${c.source}, ${c.slots} slots, ${c.keys} keys${c.missing.length ? `, missing ${c.missing.join(' ')}` : ''}; signal: ${c.signal}`);
  if (rep.anchors) {
    console.log('\nanchors (at:SpawnLocation):');
    for (const [k, v] of Object.entries(rep.anchors).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)} ${k}`);
  }
  if (list) {
    console.log('\nunmapped keys:');
    for (const u of rep.unmapped) console.log(`  ${u.group} ${u.unit} ${u.skill} ${u.key} ${u.role} ${u.reason}  (${u.from})`);
    console.log('\nskills without a drivable plan:');
    for (const u of rep.unplanned) console.log(`  ${u.group} ${u.unit} ${u.skill} ${u.reason}`);
  }
}

const isMain = import.meta.url === new URL(process.argv[1] ?? '', 'file://').href || process.argv[1]?.endsWith('vfx-skill-coverage.mjs');
if (isMain) {
  const o = parseArgs(process.argv.slice(2));
  if (!o) { console.error(USAGE); process.exit(2); }
  const idx = readJson(o.index);
  if (!idx || !idx.units) {
    const shown = o.index.startsWith(ROOT + path.sep) ? path.relative(ROOT, o.index) : o.index;
    console.log(`no extracted effects at ${shown} (tools/local-extract: extract.py --only fx --fx-set used) — nothing to report`);
    process.exit(0);
  }
  const data = Object.fromEntries(['chess', 'backups', 'tokens', 'enemies'].map((n) => [n, readJson(path.join(ROOT, 'data', `${n}.json`)) || {}]));
  const rep = coverage(idx, data, o.anchors ? { describe: descriptorReader(o.index, idx) } : {});
  if (o.json) console.log(JSON.stringify(rep, null, 1));
  else printReport(rep, o);
}

