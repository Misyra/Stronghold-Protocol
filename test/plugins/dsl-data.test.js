// A data plugin's DSL operator fights on the server and through the browser-style loader, and a bad spec
// refuses the content set (DESIGN §32.5 / §32.7, PLUGIN-DSL.md §9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeBattle } from '../helpers/battleHarness.js';
import { fixture } from '../helpers/contentFixtures.js';
import { buildContentSet, contentSetFiles } from '../../server/plugins/contentSet.js';
import { DataSource } from '../../server/sim/simdata.js';
import { setGameData } from '../../server/sim/content/support/index.js';
import { DATA_SHIM_JS } from '../../server/http/static.js';
import { loadBrowserSim } from '../../public/js/battle/runner.js';
import { buildBattleSpec, createBattleFromSpec, resultDigest } from '../../server/sim/spec.js';
import { budgetUsed } from '../../server/sim/content/dsl/budget.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

function operator(id, dsl) {
  const ns = id.replace(/-/g, '_');
  return {
    op: 1,
    charId: `char_x_${ns}_caster`,
    name: 'Demo caster',
    profession: 'CASTER',
    subProfessionId: 'corecaster',
    position: 'RANGED',
    rarity: 3,
    as: 'both',
    chess: { tier: 1, bonds: ['deputShip'] },
    forms: {
      normal: { stats: { maxHp: 2000, atk: 200, def: 50, bat: 1.2, blockCnt: 1 }, rangeGrid: [[0, 0], [0, 1]] },
      elite: { stats: { maxHp: 3000, atk: 300, def: 80, bat: 1.2, blockCnt: 1 }, rangeGrid: [[0, 0], [0, 1]] },
    },
    skills: [{ skillId: `skx_${ns}_caster_1`, name: 'Cast', duration: 10, spCost: 10, initSp: 10, default: true }],
    trait: { desc: 'Ranged arts' },
    kit: { dsl },
    art: { ref: 'char_199_yak' },
  };
}

function melee(id, dsl) {
  const ns = id.replace(/-/g, '_');
  return {
    op: 1,
    charId: `char_x_${ns}_keep`,
    name: 'Keep',
    profession: 'WARRIOR',
    subProfessionId: 'fearless',
    position: 'MELEE',
    rarity: 3,
    as: 'chess',
    chess: { tier: 1, bonds: ['deputShip'] },
    forms: {
      normal: { stats: { maxHp: 2000, atk: 100, def: 0, bat: 2, blockCnt: 1 }, rangeGrid: [[0, 0], [0, 1]] },
      elite: { stats: { maxHp: 2000, atk: 100, def: 0, bat: 2, blockCnt: 1 }, rangeGrid: [[0, 0], [0, 1]] },
    },
    skills: [{ skillId: `skx_${ns}_keep_1`, name: 'K', duration: 10, spCost: 10, initSp: 0, default: true }],
    trait: { desc: 'Melee' },
    kit: { dsl },
    art: { ref: 'char_199_yak' },
  };
}

const passive = { dsl: 1, skill: { kind: 'passive', mods: { atkPct: 0.5 } } };

test('a data-plugin DSL operator fights the same battle on the server and in the browser loader', async (t) => {
  const f = fixture(t);
  f.put('data-demo', { permissions: ['data.add', 'dsl'], operators: ['op.json'] }, { 'op.json': operator('data-demo', passive) });
  const set = buildContentSet({ registry: f.registry, ids: ['data-demo'] });
  assert.deepEqual(set.problems, []);
  assert.equal(Object.hasOwn(set.data, 'dsl'), false, 'a battle spec is on the chess record, not data.dsl');
  const id = 'chess_x_data_demo_caster_a';
  const rec = set.data.chess[id];
  assert.equal(rec.pluginId, 'data-demo');
  assert.equal(rec.dsl.pluginId, undefined, 'the author spec is not rewritten');
  assert.equal(rec.dsl.skill.mods.atkPct, 0.5);
  assert.equal(set.data.backups.units.char_x_data_demo_caster.pluginId, 'data-demo');
  const chessBytes = contentSetFiles(set).get('data/chess.json').body.toString('utf8');
  assert.match(chessBytes, /"pluginId":"data-demo"/);
  assert.match(chessBytes, /"atkPct":0\.5/);
  setGameData(set.data);
  t.after(() => setGameData(null));

  const h = makeBattle({ data: new DataSource(set.data), units: [{ chessId: id, row: 10, col: 5 }] });
  h.step();
  const u = h.unit(id);
  assert.notEqual(u.kit.generic, true);
  assert.equal(u.def.raw.pluginId, 'data-demo');
  close(u.s.atk, 300);

  const runtime = path.join(f.dir, 'runtime');
  fs.mkdirSync(path.join(runtime, 'server'), { recursive: true });
  fs.cpSync('server/sim', path.join(runtime, 'server/sim'), { recursive: true, filter: (src) => !src.endsWith('/nodeData.js') });
  fs.cpSync('shared', path.join(runtime, 'shared'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(runtime, 'server/data.js'), DATA_SHIM_JS);
  const table = contentSetFiles(set);
  const base = pathToFileURL(path.join(runtime, 'server/sim')).href + '/';
  const files = Object.fromEntries([...table].filter(([rel]) => /^data\/[^/]+\.json$/.test(rel)).map(([rel, file]) => [rel.slice(5, -5), JSON.parse(file.body.toString('utf8'))]));
  const bounds = JSON.parse(table.get('bounds/official.json').body.toString('utf8'));
  const noFetch = async (url) => assert.fail(`no fetch for a content set (${url})`);
  const loaded = await loadBrowserSim({ base, data: files, cs: set.cs, bounds, fetchFn: noFetch });
  assert.equal(loaded.cs, set.cs);
  assert.equal(files.chess[id].pluginId, 'data-demo');
  const spec = buildBattleSpec({ ...h.b.opts, stageId: 'flat' });
  const server = createBattleFromSpec(spec, new DataSource(set.data));
  const browser = loaded.spec.createBattleFromSpec(spec, loaded.ds);
  server.start();
  browser.start();
  for (let i = 0; i < 30; i++) { server.step(); browser.step(); }
  close(browser.allyUnits[0].s.atk, 300);
  close(server.allyUnits[0].s.atk, 300);
  assert.deepEqual(browser.snapshot(), server.snapshot());
  assert.deepEqual(resultDigest(browser.result()), resultDigest(server.result()));
});

test('a bad DSL spec, a spoofed pluginId, a missing permission and an official chess are refused', (t) => {
  const f = fixture(t);
  const put = (manifest, documents) => {
    f.put('data-demo', manifest, documents);
    return buildContentSet({ registry: f.registry, ids: ['data-demo'] });
  };
  const bad = put(
    { permissions: ['data.add', 'dsl'], operators: ['op.json'] },
    { 'op.json': operator('data-demo', {}) },
  );
  assert.equal(bad.cs, undefined);
  assert.equal(bad.problems[0].code, 'PLUGIN_DSL_VERSION');
  assert.equal(f.registry.plugin('data-demo').status, 'loaded');

  const spoof = put(
    { permissions: ['data.add', 'dsl'], operators: ['op.json'] },
    { 'op.json': operator('data-demo', { ...passive, pluginId: 'other-plug' }) },
  );
  assert.equal(spoof.cs, undefined);
  assert.equal(spoof.problems[0].code, 'PLUGIN_DSL_PLUGIN_ID');

  const bare = put(
    { permissions: ['data.add'], operators: ['op.json'] },
    { 'op.json': operator('data-demo', passive) },
  );
  assert.equal(bare.cs, undefined);
  assert.ok(bare.problems.some((p) => p.code === 'PLUGIN_CONTENT_PERMISSION'));

  const official = put(
    { permissions: ['data.patch', 'dsl'], data: ['p.json'] },
    { 'p.json': { patch: 1, ops: [{ op: 'merge', file: 'chess', id: 'chess_char_1_02_a', value: { dsl: passive, pluginId: 'data-demo' } }] } },
  );
  assert.equal(official.cs, undefined);
  assert.ok(official.problems.some((p) => p.code === 'PLUGIN_DSL_PLUGIN_ID'));

  f.put('data-demo', { permissions: ['dsl'], dsl: ['p.json'] }, { 'p.json': { dsl: 1 } });
  assert.equal(f.registry.plugin('data-demo'), null);
  assert.ok(f.registry.report().skipped.some((p) => p.problems.some((s) => s.includes('PLUGIN_DSL_META'))));

  f.put('data-demo', { permissions: ['dsl'], dsl: ['p.json'] }, {
    'p.json': { dsl: 1, pluginId: 'other-plug', meta: { key: 'effect:other-plug:income', on: [{ when: 'income', do: [{ funds: { amount: 1, setIncome: true } }] }] } },
  });
  assert.equal(f.registry.plugin('data-demo'), null);
  assert.ok(f.registry.report().skipped.some((p) => p.problems.some((s) => s.includes('PLUGIN_DSL_PLUGIN_ID'))));
});

test('DSL in two data plugins spends each plugin id budget', (t) => {
  const f = fixture(t);
  const wide = { dsl: 1, talents: [{ when: 'deploy', do: [{ buff: { target: 'self', key: 'keep', duration: 30, mods: { atkFlat: 50 } } }] }] };
  const tiny = { dsl: 1, budget: 2, talents: [{ when: 'every', seconds: 1 / 30, do: [{ dp: { amount: 1 } }] }] };
  f.put('wideplug', { permissions: ['data.add', 'dsl'], operators: ['op.json'] }, { 'op.json': melee('wideplug', wide) });
  f.put('tinyplug', { permissions: ['data.add', 'dsl'], operators: ['op.json'] }, { 'op.json': melee('tinyplug', tiny) });
  const set = buildContentSet({ registry: f.registry, ids: ['wideplug', 'tinyplug'] });
  assert.deepEqual(set.problems, [], JSON.stringify(set.problems));
  assert.equal(set.data.chess.chess_x_wideplug_keep_a.pluginId, 'wideplug');
  assert.equal(set.data.chess.chess_x_tinyplug_keep_a.pluginId, 'tinyplug');
  const h = makeBattle({
    data: new DataSource(set.data),
    autoFinish: false,
    timeLimit: 5,
    flags: { dpPerSec: 0 },
    units: [
      { chessId: 'chess_x_wideplug_keep_a', row: 10, col: 5 },
      { chessId: 'chess_x_tinyplug_keep_a', row: 10, col: 6 },
    ],
  });
  h.step(1);
  h.run(0.4);
  const v = h.unit('chess_x_wideplug_keep_a');
  const buff = v.findBuff('keep');
  assert.ok(buff, 'the wide budget still holds its buff');
  assert.ok(buff.tags.includes('plugin:wideplug'));
  assert.notEqual(v.s.atk, 100);
  assert.ok(budgetUsed(h.battle, 'tinyplug') > 0);
  assert.notEqual(budgetUsed(h.battle, 'wideplug'), budgetUsed(h.battle, 'tinyplug'));
  assert.equal(h.battle.errors.filter((e) => e.label === 'plugin:wideplug').length, 0);
  assert.equal(h.battle.errors.filter((e) => e.label === 'plugin:tinyplug').length, 1);
});

test('a PLUGIN_DSL_* kit throw is not the generic kit; any other throw still is', () => {
  const id = 'chess_char_1_02_a';
  const boom = (code) => () => { const e = new Error('kit'); if (code) e.code = code; throw e; };
  const bad = makeBattle({ units: [{ chessId: id, row: 10, col: 5 }], kits: { [id]: boom('PLUGIN_DSL_VERSION') } });
  bad.step();
  const u = bad.unit(id);
  assert.notEqual(u.kit.generic, true);
  // The engine still builds a SkillRuntime from the chess record. With no kit spec it is marked noSkill,
  // which is the empty kit ({ skill: null }), not the generic kit's implemented skill.
  assert.equal(u.kit.skill ?? null, null);
  assert.equal(u.skill.noSkill, true);
  const plain = makeBattle({ units: [{ chessId: id, row: 10, col: 5 }], kits: { [id]: boom(null) } });
  plain.step();
  const g = plain.unit(id);
  assert.equal(g.kit.generic, true);
  assert.equal(g.skill.noSkill, false);
});
