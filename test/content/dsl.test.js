// test/content/dsl.test.js — P2 DSL-lite (DESIGN §32.7): the validator agrees with schemas/dsl.schema.json,
// compileDsl throws the PLUGIN_DSL_* code, five official effects match the official kit on the same battle,
// the action budget stops only that plugin, and a dsl-tagged hit does not re-enter hitDealt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeBattle, chessRec, enemyRec } from '../helpers/battleHarness.js';
import { compileDsl } from '../../server/sim/content/dsl/compile.js';
import { validateDsl } from '../../server/sim/content/dsl/validate.js';
import {
  TRIGGERS, CONDITIONS, ACTIONS, TARGETS, META_TRIGGERS, META_ACTIONS, VALUE_OPS, SKILL_KINDS, STAT_NAMES, TICK,
} from '../../server/sim/content/dsl/vocab.js';

const schema = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../schemas/dsl.schema.json'), 'utf8'));
const FORBIDDEN = schema.$defs.forbidden.enum;
const LIMITS = schema.$defs.limits.properties;

const SKGOAT = {
  dsl: 1, pluginId: 'rewrite-skgoat',
  skill: { kind: 'duration', mods: { atkPct: { bb: 'atk' } } },
};
const INSIDE = {
  dsl: 1, pluginId: 'rewrite-inside',
  skill: {
    kind: 'ammo', ammo: { bb: 'attack@trigger_time' },
    mods: { atkPct: { bb: 'atk' }, batPct: { batMod: { bb: 'base_attack_time' } }, taunt: -1 },
    targeting: { priority: 'ranged' },
  },
};
const TEXAS = {
  dsl: 1, pluginId: 'rewrite-texas',
  skill: {
    kind: 'instant',
    targeting: { rangeGrid: 'skill', noRangeExtend: true },
    on: { start: [
      { dp: { amount: { bb: 'cost' }, fx: true } },
      { fx: { kind: 'aoe', radius: 2, skill: 'swordRain' } },
      { damage: {
        target: 'enemiesInRange', times: 2, type: 'arts', isSkill: true, tags: ['skill'],
        amount: { mul: [{ stat: 'atk' }, { bb: 'atk_scale' }] },
        then: [{ status: { target: 'target', key: 'stun', duration: { bb: 'stun' } } }],
      } },
    ] },
  },
  talents: [{ when: 'battleStart', do: [{ dp: { amount: { talent: [0, 'cost'] }, fx: false } }] }],
};
const KAZEMA = {
  dsl: 1, pluginId: 'rewrite-kazema',
  skill: {
    kind: 'duration', mods: { atkPct: { bb: 'atk' } },
    on: { start: [
      { damage: { target: 'self', lose: true, minRemain: 1, amount: { mul: [{ stat: 'hp' }, { bb: 'hp_ratio' }] } } },
      { spawnToken: {
        token: { override: true, match: ['shadow', 'doll'], fallback: 'token_10022_kazema_shadow' },
        tile: 'around', mem: 'doll', fx: true,
      } },
      { fx: { kind: 'aoe', at: 'lastSpawn', radius: 1.5, skill: 'origami' } },
      { damage: {
        target: { enemiesInRadius: 1.5 }, from: 'lastSpawn', type: 'arts', isSkill: true, canDodge: false, tags: ['talent'],
        amount: { mul: [{ stat: 'atk', of: 'lastSpawn' }, { talent: [0, 'damage_scale'] }] },
      } },
    ] },
  },
};

function kitOfSpec(spec) {
  return (bb, chess, def) => compileDsl(spec, { bb, chess, def });
}

function picture(h) {
  const b = h.battle;
  const op = h.allies().find((u) => u.kind === 'op') || h.allies()[0] || null;
  return {
    events: h.events,
    op: op ? { id: op.defId, hp: op.hp, dmg: op.stats ? op.stats.dmg : null, ammo: op.skill ? op.skill.ammoLeft : null } : null,
    enemies: b.units.filter((u) => u.side === 'enemy').map((u) => [u.defId, u.alive, u.hp]),
    tokens: b.allyUnits.filter((u) => u.kind === 'token').map((u) => [u.defId, u.tileR, u.tileC, u.alive, u.hp]),
    dp: b.getPlayer('p1').dp,
    errors: (b.errors || []).map((e) => e.label),
    result: b.finished ? b.result() : null,
  };
}

function assertSame(off, dsl, label) {
  const a = picture(off);
  const b = picture(dsl);
  assert.deepEqual(b.op, a.op, label + ' operator');
  assert.deepEqual(b.enemies, a.enemies, label + ' enemies');
  assert.deepEqual(b.tokens, a.tokens, label + ' tokens');
  assert.equal(b.dp, a.dp, label + ' dp');
  assert.deepEqual(b.errors, a.errors, label + ' errors');
  assert.deepEqual(b.result, a.result, label + ' result');
  assert.equal(b.events.length, a.events.length, `${label} event count official ${a.events.length} dsl ${b.events.length}`);
  for (let i = 0; i < a.events.length; i++) {
    assert.deepEqual(b.events[i], a.events[i], `${label} event ${i}\nofficial ${JSON.stringify(a.events[i])}\ndsl ${JSON.stringify(b.events[i])}`);
  }
}

function fight(chessId, spec, { pos, after, before = 1 }) {
  const base = {
    seed: 3, autoFinish: false, timeLimit: 40, content: 'full',
    units: [{ chessId, row: 10, col: 5 }],
    enemies: [{ key: 'enemy_1422_lrsldr', time: 0, pos }],
  };
  const play = (extra) => {
    const h = makeBattle({ ...base, ...extra });
    h.step(before);
    const u = h.allies()[0];
    assert.equal(u.skill.activate('test', { free: true }), true, chessId + ' activate');
    if (after) h.run(after);
    else h.step(2);
    return h;
  };
  return [play({}), play({ kits: { [chessId]: kitOfSpec(spec) } })];
}

/** A schema-only reading of the fixtures. Enums and limits are read from the schema file, not from validateDsl. */
function schemaCodes(spec) {
  const codes = [];
  const fail = (c) => { if (!codes.includes(c)) codes.push(c); };
  const tick = 1 / LIMITS.tickDenominator.const;
  const actions = schema.$defs.action.enum;
  const triggers = schema.$defs.trigger.enum;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return ['PLUGIN_DSL_SHAPE'];
  if (spec.dsl !== schema.properties.dsl.const) fail('PLUGIN_DSL_VERSION');
  if (spec.pluginId != null && (typeof spec.pluginId !== 'string' || !new RegExp(schema.$defs.pluginId.pattern).test(spec.pluginId))) {
    fail('PLUGIN_DSL_PLUGIN_ID');
  }
  if (spec.budget != null && !(Number.isInteger(spec.budget) && spec.budget > 0 && spec.budget <= LIMITS.budgetMax.const)) {
    fail('PLUGIN_DSL_BUDGET');
  }
  const walkValue = (expr) => {
    if (!expr || typeof expr !== 'object') return;
    if (Array.isArray(expr)) { expr.forEach(walkValue); return; }
    for (const k of Object.keys(expr)) if (FORBIDDEN.includes(k)) fail('PLUGIN_DSL_LOOP');
    if (Array.isArray(expr.div)) {
      for (let i = 1; i < expr.div.length; i++) if (expr.div[i] === 0) fail('PLUGIN_DSL_DIV0');
      expr.div.forEach(walkValue);
    }
  };
  const walkList = (list) => {
    if (!Array.isArray(list)) return;
    for (const node of list) {
      if (!node || typeof node !== 'object') continue;
      for (const k of Object.keys(node)) if (FORBIDDEN.includes(k)) fail('PLUGIN_DSL_LOOP');
      const verbs = Object.keys(node).filter((k) => actions.includes(k));
      if (verbs.length !== 1) fail('PLUGIN_DSL_ACTION');
      const body = verbs.length === 1 ? node[verbs[0]] : null;
      if (body && typeof body === 'object') {
        walkValue(body.amount);
        if (typeof body.target === 'string' && !schema.$defs.target.enum.includes(body.target)) fail('PLUGIN_DSL_TARGET');
      }
      if (node.then) walkList(node.then);
    }
  };
  const walkTalent = (t) => {
    if (!t || typeof t !== 'object') return;
    if (!triggers.includes(t.when)) fail('PLUGIN_DSL_TRIGGER');
    if (t.when === 'every' && !(typeof t.seconds === 'number' && t.seconds >= tick - 1e-12)) fail('PLUGIN_DSL_EVERY');
    walkList(t.do);
  };
  for (const k of Object.keys(spec)) if (FORBIDDEN.includes(k)) fail('PLUGIN_DSL_LOOP');
  if (Array.isArray(spec.talents)) spec.talents.forEach(walkTalent);
  const sk = spec.skill;
  if (sk && sk.on && typeof sk.on === 'object') for (const list of Object.values(sk.on)) walkList(list);
  if (sk && sk.mods) for (const v of Object.values(sk.mods)) walkValue(v);
  return codes;
}

test('schema enums are the compiler vocabulary', () => {
  assert.deepEqual(schema.$defs.trigger.enum, [...TRIGGERS]);
  assert.deepEqual(schema.$defs.condition.enum, [...CONDITIONS]);
  assert.deepEqual(schema.$defs.action.enum, [...ACTIONS]);
  assert.deepEqual(schema.$defs.target.enum, [...TARGETS]);
  assert.deepEqual(schema.$defs.metaTrigger.enum, [...META_TRIGGERS]);
  assert.deepEqual(schema.$defs.metaAction.enum, [...META_ACTIONS]);
  assert.deepEqual(schema.$defs.valueOp.enum, [...VALUE_OPS]);
  assert.deepEqual(schema.$defs.skillKind.enum, [...SKILL_KINDS]);
  assert.deepEqual(schema.$defs.stat.enum, [...STAT_NAMES]);
  assert.equal(LIMITS.tickDenominator.const, Math.round(1 / TICK));
});

test('validator and schema agree on the fixtures, and compileDsl throws the code', () => {
  const fixtures = [
    ['duration skill', SKGOAT, null],
    ['version', { dsl: 2, skill: { kind: 'duration' } }, 'PLUGIN_DSL_VERSION'],
    ['every', { dsl: 1, talents: [{ when: 'every', seconds: 0.01, do: [{ dp: { amount: 1 } }] }] }, 'PLUGIN_DSL_EVERY'],
    ['trigger', { dsl: 1, talents: [{ when: 'nope', do: [{ dp: { amount: 1 } }] }] }, 'PLUGIN_DSL_TRIGGER'],
    ['div0', { dsl: 1, skill: { kind: 'instant', on: { start: [{ damage: { target: 'self', amount: { div: [1, 0] } } }] } } }, 'PLUGIN_DSL_DIV0'],
    ['budget', { dsl: 1, budget: 0, skill: { kind: 'instant' } }, 'PLUGIN_DSL_BUDGET'],
    ['plugin id', { dsl: 1, pluginId: 'has space', skill: { kind: 'instant' } }, 'PLUGIN_DSL_PLUGIN_ID'],
    ['loop', { dsl: 1, loop: true, skill: { kind: 'instant' } }, 'PLUGIN_DSL_LOOP'],
  ];
  for (const [name, spec, code] of fixtures) {
    const checked = validateDsl(spec);
    const fromSchema = schemaCodes(spec);
    if (code == null) {
      assert.equal(checked.ok, true, name + ' ' + JSON.stringify(checked.problems));
      assert.deepEqual(fromSchema, [], name);
    } else {
      assert.equal(checked.ok, false, name);
      assert.equal(checked.problems[0].code, code, name);
      assert.ok(checked.problems[0].zh, name + ' zh');
      assert.ok(fromSchema.includes(code), `${name} schema saw ${fromSchema.join(',')} not ${code}`);
      assert.throws(() => compileDsl(spec, {}), (e) => e instanceof Error && String(e.message).includes(code));
    }
  }
});

test('地灵 duration skill matches the official kit', () => {
  const [off, dsl] = fight('chess_char_1_11_a', SKGOAT, { pos: [10, 6], after: 3 });
  assert.ok(off.events.some((e) => e[0] === 'dmg'), 'official window has damage');
  assertSame(off, dsl, '地灵');
});

test('隐现 ammo skill matches the official kit inside the talent window', () => {
  const [off, dsl] = fight('chess_char_1_01_a', INSIDE, { pos: [10, 6], after: 3 });
  assert.ok(off.battle.time < 20, 'window stays under the 20s talent');
  assert.ok(off.events.some((e) => e[0] === 'dmg'), 'official window has damage');
  assert.ok(off.allies()[0].skill.ammoLeft < off.allies()[0].skill.ammo, 'ammo was spent');
  assertSame(off, dsl, '隐现');
});

test('德克萨斯 sword rain and the battle-start talent match the official kit', () => {
  const [off, dsl] = fight('chess_char_1_08_a', TEXAS, { pos: [10, 4], after: 1 });
  assert.ok(off.events.some((e) => e[0] === 'dmg' && e[3] === 'arts'), 'official sword rain deals arts');
  assert.ok(off.battle.getPlayer('p1').dp > 10, 'talent and skill both add DP');
  assertSame(off, dsl, '德克萨斯');
});

test('风丸 summon matches the official kit before the skill ends', () => {
  const [off, dsl] = fight('chess_char_2_11_a', KAZEMA, { pos: [9, 18], after: 3 });
  assert.ok(off.battle.time < 20, 'window stops before onEnd retreats the token');
  const tok = off.battle.allyUnits.find((u) => u.kind === 'token');
  assert.ok(tok && tok.alive, 'official summon is on the field');
  assert.ok(off.events.some((e) => e[0] === 'dmg' && e[3] === 'true'), 'official self loss');
  assertSame(off, dsl, '风丸');
});

test('the action budget stops only that plugin and records plugin:<id> once', () => {
  const id = 'dsl_budget_a';
  const spec = {
    dsl: 1, pluginId: 'budgetplug', budget: 3,
    talents: [{ when: 'every', seconds: 1 / 30, do: [{ dp: { amount: 1 } }] }],
  };
  const h = makeBattle({
    seed: 1, content: 'generic', autoFinish: false, timeLimit: 5,
    // Natural DP is 1 per second. Turn it off so the delta is only this plugin's three grants.
    flags: { dpPerSec: 0 },
    units: [{ chessId: id, row: 10, col: 5 }],
    defs: { chess: { [id]: chessRec({ id, profession: 'WARRIOR', stats: { atk: 100, bat: 2 } }) } },
    kits: { [id]: kitOfSpec(spec) },
  });
  const dp0 = h.battle.getPlayer('p1').dp;
  h.run(0.5);
  const labels = h.battle.errors.filter((e) => e.label === 'plugin:budgetplug');
  assert.equal(h.battle.getPlayer('p1').dp - dp0, 3);
  assert.equal(labels.length, 1);
  assert.equal(h.battle.finished, false);
  assert.equal(h.battle.errors.filter((e) => String(e.label).startsWith('plugin:')).length, 1);
});

test('dsl damage does not re-enter hitDealt', () => {
  const id = 'dsl_re_a';
  const spec = {
    dsl: 1, pluginId: 'reentry',
    talents: [{ when: 'hitDealt', do: [{ damage: { target: 'target', amount: 50, type: 'true' } }] }],
  };
  const h = makeBattle({
    seed: 2, content: 'generic', autoFinish: false, timeLimit: 8, captureNoisy: true,
    units: [{ chessId: id, row: 10, col: 5 }],
    enemies: [{ key: 'enemy_re', time: 0, pos: [10, 6] }],
    defs: {
      chess: { [id]: chessRec({ id, profession: 'WARRIOR', stats: { atk: 200, bat: 1 }, rangeGrid: [[0, 0], [0, 1]] }) },
      enemies: { enemy_re: enemyRec({ key: 'enemy_re', hp: 100000, atk: 0 }) },
    },
    kits: { [id]: kitOfSpec(spec) },
  });
  h.run(2.5);
  const hits = h.hooksOf('hit').filter((c) => c.source && c.source.defId === id);
  const tagged = hits.filter((c) => c.dmg && Array.isArray(c.dmg.tags) && c.dmg.tags.includes('dsl'));
  const plain = hits.filter((c) => !(c.dmg && Array.isArray(c.dmg.tags) && c.dmg.tags.includes('dsl')));
  assert.ok(plain.length > 0, 'the operator landed a hit');
  assert.equal(tagged.length, plain.length);
  assert.equal(h.battle.errors.filter((e) => String(e.label).startsWith('hookDepth')).length, 0);
});
