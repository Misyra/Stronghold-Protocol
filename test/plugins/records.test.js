import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getData } from '../../server/data.js';
import { expandRecords } from '../../shared/plugins/records.js';
import { validateData, validateReferences } from '../../shared/plugins/validate.js';
import { validateSkillSpec, matchesSchema } from '../../shared/plugins/skillSpec.js';
import { RECORDS_SCHEMA } from '../../shared/plugins/recordsSchema.js';
import { guard } from '../helpers/contentFixtures.js';
import { diyRecord } from '../../shared/diy.js';
const base = getData(), context = { pluginId: 'data-demo' };
test('complete normal/elite pair and all DIY forms; behavior survives production DIY composition', () => {
  const r = expandRecords(base, [guard()], context); assert.deepEqual(r.problems, []);
  assert.deepEqual(validateData(r.data), []);
  for (const elite of [false, true]) {
    const c = r.data.chess[`chess_x_data_demo_guard_${elite ? 'b' : 'a'}`];
    assert.equal(c.stats.maxHp, elite ? 3000 : 2000); assert.equal(c.skill.skillId, c.skills.find(s => s.isDefault).skillId);
    const d = diyRecord('chess_char_5_diy1_a', { charId: 'char_x_data_demo_guard', skillIndex: 0 }, { elite, data: r.data });
    assert.equal(d.kitRef, 'chess_char_1_02_a');
  }
  assert.ok(!base.chess.chess_x_data_demo_guard_a);
});
test('new enemies, waves, stages, modes, items, bands, garrisons and choices reuse data and effects', () => {
  const r = expandRecords(base, [
    { file: 'enemies', id: 'enemy_x_data_demo_slug', base: 'enemy_1422_lrsldr', set: { stats: { maxHp: 6000 } } },
    { file: 'waves', id: 'wave_x_data_demo_one', value: { routes: [{ start: [9,10], end: [9,2], motion: 'WALK' }], spawns: [{ key: 'enemy_x_data_demo_slug', time: 0, count: 1, interval: 0, routeIndex: 0 }] } },
    { file: 'stages', id: 'stage_x_data_demo_one', base: 'act1autochess_m01', set: { name: 'Example' } },
    { file: 'modes', id: 'mode_x_data_demo_one', base: 'mode_single_normal', set: { economy: { refreshPrice: 0 } } },
    { file: 'items', id: 'item_x_data_demo_one', base: 'chess_item_3_02_e_a' },
    { file: 'bands', id: 'band_x_data_demo_one', base: 'band_amiya' },
    { file: 'garrisons', id: 'garrison_x_data_demo_one', base: Object.keys(base.garrisons)[0] },
    { file: 'choices', id: 'effect_x_data_demo_one', kind: 'tactic', base: base.choices.cards.tactic[0].effectId },
  ], context);
  assert.deepEqual(r.problems, []); assert.deepEqual(validateData(r.data), []);
  assert.equal(r.data.config.modes.mode_x_data_demo_one.lastRound, base.config.modes.mode_single_normal.lastRound);
  assert.equal(r.data.items.item_x_data_demo_one.effectRef, 'chess_item_3_02_e_a');
});
test('record expansion errors are coded and atomic', () => {
  for (const [r, want] of [
    [{ ...guard(), charId: 'char_x_another_guard' }, 'PLUGIN_RECORD_ID'],
    [{ ...guard(), as: 'unknown' }, 'PLUGIN_RECORD_TYPE'],
    [{ ...guard(), skills: [{ ...guard().skills[0], default: false }] }, 'PLUGIN_RECORD_SKILLS'],
    [{ file: 'modes', id: 'mode_x_data_demo_bad', base: 'missing' }, 'PLUGIN_DATA_REFERENCE'],
  ]) { const v = expandRecords(base, [r], context); assert.equal(v.data, base); assert.equal(v.problems[0].code, want); }
  const a = expandRecords(base, [guard()], context); assert.equal(expandRecords(a.data, [guard()], context).problems[0].code, 'PLUGIN_RECORD_EXISTS');
});
test('merged data validation: required fields, pairs, references, skills, kitRef/effectRef, nonfinite, DSL', () => {
  assert.deepEqual(validateReferences(base), []);
  for (const [change, want] of [
    [d => { delete d.config; }, 'PLUGIN_DATA_REQUIRED'],
    [d => { d.chess.chess_char_1_02_a.goldenId = 'missing'; }, 'PLUGIN_DATA_PAIR'],
    [d => { d.chess.chess_char_1_02_a.bonds.push('missing'); }, 'PLUGIN_DATA_REFERENCE'],
    [d => { d.chess.chess_char_1_02_a.skills[0].isDefault = true; }, 'PLUGIN_RECORD_SKILLS'],
    [d => { d.chess.chess_char_1_02_a.kitRef = 'missing'; }, 'PLUGIN_KIT_REF'],
    [d => { d.items.chess_item_1_01_e_a.effectRef = 'missing'; }, 'PLUGIN_EFFECT_REF'],
    [d => { d.config.economy.refreshPrice = NaN; }, 'PLUGIN_DATA_NUMBER'],
    [d => { d.chess.chess_char_1_02_a.dsl = {}; }, 'PLUGIN_DSL_UNAVAILABLE'],
  ]) { const d = structuredClone(base); change(d); assert.ok(validateData(d, { kitExists: () => false }).some(p => p.code === want), want); }
});
test('SkillSpec exposes only the JSON subset, including nested attack fields and typed mods', () => {
  assert.deepEqual(validateSkillSpec({ kind: 'passive', mods: { atkPct: 0.5 }, attack: { hits: 2, onHitStatus: { key: 'stun', duration: 1 } } }), []);
  for (const s of [{ kind: 'passive', onStart: 'evil()' }, { kind: 'ammo', ammo: 1e9 }, { kind: 'passive', attack: { onHit: () => 1 } }, { kind: 'passive', mods: { unknown: 1 } }]) assert.ok(validateSkillSpec(s).some(p => p.code === 'PLUGIN_SKILL_SPEC'));
});
test('checked-in schema equals the runtime schema and accepts/rejects the same structural fixtures', () => {
  assert.deepEqual(JSON.parse(fs.readFileSync('schemas/records.schema.json')), RECORDS_SCHEMA);
  for (const r of [guard(), { ...guard(), as: 'bad' }, { ...guard(), forms: {} }, { file: 'modes', id: 'mode_x_data_demo_one', base: 'mode_single_normal' }]) {
    const valid = matchesSchema(r, RECORDS_SCHEMA);
    const problems = expandRecords(base, [r], context).problems;
    assert.equal(!problems.some(p => p.code === 'PLUGIN_RECORD_TYPE'), valid);
  }
});

test('compact rich text fills the form blackboard and keeps literal trigger labels', () => {
  const op = guard(); op.skills[0].desc = '<获得时>攻击<@ba.vup>+{def:0%}</>';
  const r = expandRecords(base, [op], context); assert.deepEqual(r.problems, []);
  assert.equal(r.data.chess.chess_x_data_demo_guard_a.skill.desc, '<获得时>攻击+50%');
});
test('malformed nested arrays return diagnostics without throwing', () => {
  for (const edit of [d => { d.waves[Object.keys(d.waves)[0]].spawns = {}; }, d => { d.bonds.deputShip = null; }]) {
    const d = structuredClone(base); edit(d); assert.ok(validateData(d).length);
  }
});
