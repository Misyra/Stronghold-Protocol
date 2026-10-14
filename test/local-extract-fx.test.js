// tools/local-extract/fx.py (DESIGN §33, docs/design/vfx-format.md): the encodings of the official battle effects'
// descriptors — curves, gradients, render states, decoded animation clips, mount-point matrices, the file names of
// effect keys — and extract.py's opt-in fx run. The Python helpers run without UnityPy (pure functions; plain
// python3). When the effects were extracted on this machine (data/local-fx.json, the list of the fx files, exists), the
// output is checked for consistency: every listed file exists, the index and the list agree, every key the index names
// has a descriptor, and data/local-assets.json holds no fx group.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools/local-extract');
const PY = ['python3', 'python'].find((bin) => spawnSync(bin, ['--version']).status === 0);
const ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
const readJson = (rel) => { try { return JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8')); } catch { return null; } };
const manifest = readJson('data/local-assets.json');
const fxList = readJson('data/local-fx.json');

/** Run python code with `fx` imported; returns the parsed JSON it prints. */
function py(code) {
  const src = `import sys, json, math, struct, zlib\nsys.path.insert(0, ${JSON.stringify(TOOL)})\nimport fx\n${code}`;
  const r = spawnSync(PY, ['-c', src], { encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

describe('fx.py encodings (no UnityPy needed)', { skip: !PY && 'no python3' }, () => {
  test('fx_file: URL-safe keys are their own file stem; others get the safe form + the key\'s CRC32', () => {
    const out = py(`print(json.dumps([fx.fx_file(k) for k in ['common_hit_01', 'buff_ fragile_01', 'buff_weak[limit]', 'x#1', 'x_1']]))`);
    assert.equal(out[0], 'common_hit_01');
    assert.match(out[1], /^buff__fragile_01-[0-9a-f]{8}$/);
    assert.match(out[2], /^buff_weak_limit-[0-9a-f]{8}$/);
    assert.notEqual(out[3], out[4], 'x#1 and x_1 do not collide');
    assert.equal(out[4], 'x_1');
  });

  test('f6: six significant digits, -0 → 0, integers stay, NaN / ±inf → null', () => {
    const out = py(`print(json.dumps([fx.f6(x) for x in [1.0000004, -0.0, 3, 0.258819049, 1e-13, float('nan'), float('inf'), True, 2.0, 1234567.8]]))`);
    assert.deepEqual(out, [1, 0, 3, 0.258819, 0, null, null, true, 2, 1234570]);
  });

  test('curve keys, MinMaxCurve modes, gradients, MinMaxGradient modes', () => {
    const out = py(`
k = lambda t, v, i, o, w=0: {'time': t, 'value': v, 'inSlope': i, 'outSlope': o, 'weightedMode': w, 'inWeight': 0.25, 'outWeight': 0.5}
curve = {'m_Curve': [k(0, 1, 0, -1), k(0.5, 0.2, float('inf'), 0, 3), k(1, 0, -1, -1)]}
mmc = lambda st, s=2.0, mn=0.5: {'minMaxState': st, 'scalar': s, 'minScalar': mn, 'maxCurve': curve, 'minCurve': {'m_Curve': [k(0, 0, 0, 0)]}}
col = lambda r, g, b, a: {'r': r, 'g': g, 'b': b, 'a': a}
g = {'m_Mode': 1, 'm_NumColorKeys': 2, 'm_NumAlphaKeys': 3, 'key0': col(1, 0, 0, 1), 'key1': col(0, 0, 1, 0.5), 'key2': col(0, 0, 0, 0),
     'ctime0': 0, 'ctime1': 65535, 'atime0': 0, 'atime1': 32768, 'atime2': 65535}
mmg = lambda st: {'minMaxState': st, 'minColor': col(0, 0, 0, 1), 'maxColor': col(1, 1, 1, 1), 'minGradient': g, 'maxGradient': g}
print(json.dumps({'keys': fx.enc_keys(curve), 'mmc': [fx.enc_mmc(mmc(s)) for s in (0, 3, 1, 2)],
                  'grad': fx.enc_gradient(g), 'mmg': [fx.enc_mmg(mmg(s)) for s in (0, 2, 1, 3, 4)]}))`);
    assert.deepEqual(out.keys, [[0, 1, 0, -1], [0.5, 0.2, null, 0, 3, 0.25, 0.5], [1, 0, -1, -1]], 'infinite slope = stepped (null); weighted keys carry their weights');
    assert.deepEqual(out.mmc[0], 2);
    assert.deepEqual(out.mmc[1], { min: 0.5, max: 2 });
    assert.deepEqual(Object.keys(out.mmc[2]), ['scalar', 'curve']);
    assert.deepEqual(Object.keys(out.mmc[3]), ['scalar', 'minCurve', 'maxCurve']);
    assert.deepEqual(out.grad, { mode: 'fixed', color: [[0, 1, 0, 0], [1, 0, 0, 1]], alpha: [[0, 1], [0.500008, 0.5], [1, 0]] });
    assert.deepEqual(out.mmg[0], [1, 1, 1, 1]);
    assert.deepEqual(out.mmg[1], { min: [0, 0, 0, 1], max: [1, 1, 1, 1] });
    assert.deepEqual(Object.keys(out.mmg[2]), ['gradient']);
    assert.deepEqual(Object.keys(out.mmg[3]), ['minGradient', 'maxGradient']);
    assert.deepEqual(Object.keys(out.mmg[4]), ['random']);
  });

  test('render_state: constants as written; a property-driven state takes the material value, else the shader default', () => {
    const out = py(`
v = lambda val, name='<noninit>': {'val': val, 'name': name}
rt = {'srcBlend': v(0, '_PremultiplyAlpha'), 'destBlend': v(10), 'srcBlendAlpha': v(0), 'destBlendAlpha': v(10), 'blendOp': v(0), 'colMask': v(15)}
state = {'rtBlend0': rt, 'zTest': v(0, '_ZTest'), 'zWrite': v(0), 'culling': v(0, '_CullMode')}
print(json.dumps([fx.render_state(state, {'_ZTest': 0}, {'_PremultiplyAlpha': 5, '_ZTest': 4, '_CullMode': 2}),
                  fx.render_state(state, {'_PremultiplyAlpha': 1, '_ZTest': 4}, {'_PremultiplyAlpha': 5})]))`);
    assert.deepEqual(out[0], { blend: ['SrcAlpha', 'OneMinusSrcAlpha', 'Zero', 'OneMinusSrcAlpha'], blendOp: 'Add', zTest: 'Disabled', zWrite: false, cull: 'Back', colorMask: 15 });
    assert.deepEqual(out[1].blend.slice(0, 2), ['One', 'OneMinusSrcAlpha'], 'a premultiplied material');
    assert.equal(out[1].zTest, 'LessEqual');
  });

  test('streamed clips: Hermite keys from cubic segments (buff_stun\'s 0 → −720° spin), stepped jumps, sentinels dropped', () => {
    const out = py(`
FLT_MAX = 3.4028234663852886e+38
def stream(frames):
    words = b''
    for t, keys in frames:
        words += struct.pack('<fI', t, len(keys))
        for k in keys:
            words += struct.pack('<i4f', *k)
    return list(struct.unpack('<%dI' % (len(words) // 4), words))
frames = [(-FLT_MAX, [(0, 0, 0, 0, 0), (1, 0, 0, 0, 1)]),
          (0.0, [(0, 1.4257, -21.4567, 0, 0), (1, 0, 0, 0, 1)]),
          (10.033333778381348, [(0, 0, 0, 0, -720), (1, 0, 0, 0, 5)]),
          (float('inf'), [])]
c = fx.streamed_curves(fx.decode_streamed(stream(frames)))
d = fx.dense_curves({'m_FrameCount': 3, 'm_CurveCount': 2, 'm_SampleRate': 10, 'm_BeginTime': 0.5, 'm_SampleArray': [0, 1, 1, 1, 3, 0]}, 4)
print(json.dumps({'c': {str(k): v for k, v in c.items()}, 'd': {str(k): v for k, v in d.items()}}))`);
    const spin = out.c['0'];
    assert.equal(spin.length, 2);
    assert.deepEqual(spin[0], [0, 0, 0, 0]);
    assert.equal(spin[1][0], 10.0333);
    assert.equal(spin[1][1], -720);
    assert.ok(Math.abs(spin[1][2]) < 0.05, `the in-slope at the end is the cubic's derivative (≈ 0): ${spin[1][2]}`);
    assert.deepEqual(out.c['1'], [[0, 1, 0, null], [10.0333, 5, null, 0]], 'a flat segment ending in a jump is stepped');
    assert.deepEqual(out.d['4'], [[0.5, 0, 0, 10], [0.6, 1, 10, 20], [0.7, 3, 20, 0]], 'dense samples become linear keys');
    assert.deepEqual(out.d['5'].map((k) => k[1]), [1, 1, 0]);
  });

  test('clip bindings: transform dimensions, material property attributes (CRC32 & 0x0FFFFFFF | component << 28), field paths', () => {
    const out = py(`
tc = zlib.crc32(b'_TintColor') & 0x0FFFFFFF
print(json.dumps({
  'dims': [fx.binding_dims({'typeID': 4, 'attribute': a}) for a in (1, 2, 3, 4)] + [fx.binding_dims({'typeID': 23, 'attribute': 1})],
  'attr': [list(fx.material_attribute(tc | (c << 28))) for c in (0, 3, 4, 7, 8)], 'tc': tc,
  'paths': sorted(fx.typetree_paths({'m_Parameters': {'widthMultiplier': 1, 'colorGradient': {'key0': {'r': 1}}}, 'm_Time': 0.2})),
}))`);
    assert.deepEqual(out.dims, [3, 4, 3, 3, 1]);
    assert.deepEqual(out.attr, [[out.tc, 'x'], [out.tc, 'w'], [out.tc, 'r'], [out.tc, 'a'], [out.tc, '']]);
    assert.deepEqual(out.paths, ['m_Parameters', 'm_Parameters.colorGradient', 'm_Parameters.colorGradient.key0',
      'm_Parameters.colorGradient.key0.r', 'm_Parameters.widthMultiplier', 'm_Time']);
  });

  test('mount points: a skin point composed through Graphic (−30° about X) and the FaceSwitcher (隐现\'s HitPoint)', () => {
    const out = py(`
m = fx.trs_matrix([0, 0, 0], [-0.258819, 0, 0, 0.965926], [1, 1, 1])
for t in ([[0, 0, 0], [0, 0, 0, 1], [1, 1, 1]], [[0, -0.16, -0.1], [0, 0, 0, 1], [0.27, 0.27, 0.27]], [[0, 0, 0], [0, 0, 0, 1], [1, 1, 1]], [[0, 1.8, 0], [0, 0, 0, 1], [1, 1, 1]]):
    m = fx.mat_mul(m, fx.trs_matrix(*t))
print(json.dumps(fx.mat_point(m)))`);
    assert.equal(out[0], 0);
    assert.ok(Math.abs(out[1] - 0.232324) < 1e-5 && Math.abs(out[2] + 0.249603) < 1e-5, JSON.stringify(out));
  });

  test('emitter lists and the live-particle estimate', () => {
    const out = py(`
f = {'_castEffects': [{'_directionType': 0, '_effects': ['x_attack_01_start', '', '', ''], '_startEvent': 2, '_endEvent': 3},
                      {'_directionType': 1, '_effects': ['', 'x_right', '', 'x_left', '', ''], '_startEvent': 2, '_endEvent': 3}],
     '_hitEffects': [{'_effects': ['', '', '', '']}], '_attachEffects': []}
ps = {'lengthInSec': 1, 'looping': False, 'InitialModule': {'startLifetime': {'min': 0.2, 'max': 0.6}, 'maxNumParticles': 1000},
      'EmissionModule': {'rateOverTime': 10, 'm_Bursts': [{'countCurve': {'min': 2, 'max': 5}, 'cycleCount': 1}]}}
print(json.dumps({'lists': fx.emitter_lists(f), 'live': fx.est_live(ps)}))`);
    assert.deepEqual(out.lists, { cast: [{ directionType: 0, effects: ['x_attack_01_start'], startEvent: 2, endEvent: 3 },
      { directionType: 1, effects: ['x_right', 'x_left'], slots: [null, 'x_right', null, 'x_left'], startEvent: 2, endEvent: 3 }] },
    'a directional row keeps the effect per facing (0 UP, 1 RIGHT, 2 DOWN, 3 LEFT)');
    assert.equal(out.live, 11, '10/s × 0.6 s + a burst of 5');
  });
});

describe('fx.py skill effect roles (index.json skills, DESIGN §33.12)', { skip: !PY && 'no python3' }, () => {
  const EK = `KEYS = {'ifrit_skill_02_start', 'ifrit_skill_02_range', 'common_firemagic_hit_01', 'buff_burn', 'x_skill_buff',
  'x_skill_end', 'x_hit', 'x_start_up', 'x_start', 'x_start_down', 'x_hook', 'x_ready', 'x_tpl_start', 'x_tpl_finish', 'x_tpl_derived'}
ek = lambda s: s.lower() if isinstance(s, str) and s.lower() in KEYS else None`;

  test('emit_role / name_role: list kind, one-shot, events and names place an effect in the skill\'s time', () => {
    const out = py(`${EK}
print(json.dumps([fx.emit_role('hit', {}, 'x_hit'), fx.emit_role('attach', {}, 'x'), fx.emit_role('cast', {'_oneshot': 1, '_startEvent': 2}, 'x_skill_02_range'),
  fx.emit_role('cast', {'_oneshot': 0, '_startEvent': 2, '_endEvent': 3}, 'x_skill_buff'), fx.emit_role('cast', {'_oneshot': 1, '_startEvent': 2}, 'x_start'),
  fx.emit_role('cast', {'_oneshot': 1, '_startEvent': 3}, 'x'), fx.emit_role('cast', {'_oneshot': 1, '_startEvent': 2}, 'x_buff_end'),
  fx.name_role('nian_skill_01_hit'), fx.name_role('humus_buff_01'), fx.name_role('x', 'ON_CAST_START'), fx.name_role('x'),
  fx.event_name(fx.ABILITY_EVENTS, 4), fx.event_name(fx.BUFF_EVENTS, 11), fx.event_name(fx.ABILITY_EVENTS, 99), len(fx.BUFF_EVENTS)]))`);
    assert.deepEqual(out, ['hit', 'loop', 'range', 'loop', 'start', 'end', 'end', 'hit', 'loop', 'start', 'other',
      'ON_SPELL_ON', 'ON_OUTPUT_DAMAGE', null, 109]);
  });

  test('behaviour_uses: emitter rows (directional slots, hooks), buffs with their carrier and template, mode switches', () => {
    const out = py(`${EK}
tpl = {'burn': {'effect': None, 'graph': []}, 'empty': {'effect': 'x_skill_buff', 'graph': []},
       'x_t': {'effect': None, 'graph': [['ON_BUFF_START', 'CreateEffect', '_effectKey', 'x_tpl_start'],
                                         ['ON_BUFF_FINISH', 'CreateEffect', '_effectKey', 'x_tpl_finish'],
                                         ['ON_BUFF_TRIGGER', 'CreateBuff', 'overrideEffectKey', 'x_tpl_derived']]}}
emitter = {'_hitEffects': [{'_directionType': 0, '_effects': ['common_firemagic_hit_01', '', '', ''], '_oneshot': 1, '_endEvent': 3}],
           '_castEffects': [{'_directionType': 0, '_effects': ['ifrit_skill_02_start', 'x_hit', '', ''], '_oneshot': 1, '_startEvent': 2, '_endEvent': 3},
                            {'_directionType': 0, '_effects': ['IFRIT_skill_02_range'], '_oneshot': 0, '_startEvent': 2, '_endEvent': 3},
                            {'_directionType': 3, '_effects': ['x_start_up', 'x_start', 'x_start_down', 'x_start', '', ''], '_oneshot': 1, '_startEvent': 4, '_endEvent': 3},
                            {'_directionType': 0, '_effects': [''], '_oneshot': 0, '_startEvent': 2, '_endEvent': 3, '_hookEffectAfterFirstAttack': 'x_hook'}]}
attack = {'_activeBuffs': [{'buffKey': 'ifrit_s_2', 'templateKey': 'burn', 'overrideEffectKey': 'buff_burn', 'blackboard': []}]}
own = {'_selector': {'m_FileID': 0, 'm_PathID': 0}, '_buffs': [{'buffKey': 'x_s', 'templateKey': 'empty', 'overrideEffectKey': '', 'blackboard': []},
       {'buffKey': 'x_s[t]', 'templateKey': 'x_t', 'overrideEffectKey': '', 'blackboard': [{'key': 'effect', 'value': 0, 'valueStr': 'x_hit'}]}]}
switch = {'_buffs': [{'buffKey': 'x_s[switch]', 'templateKey': 'switch_mode', 'overrideEffectKey': '', 'blackboard': [{'key': 'mode', 'value': 2.0, 'valueStr': ''}]}]}
u1 = fx.behaviour_uses('UberEffectEmitter', emitter, ek, tpl, node='skchr_x', ability='MeleeAttack')
u2 = fx.behaviour_uses('MeleeAttack', attack, ek, tpl)
u3 = fx.behaviour_uses('ActiveBuffAbility', own, ek, tpl)
u4 = fx.behaviour_uses('ReadySkillEffect', {'_effects': ['x_ready'], '_stopBeforeCast': 1}, ek, tpl)
print(json.dumps({'u1': u1, 'u2': u2, 'u3': u3, 'u4': u4, 'roles': fx.roles_of(u1 + u2 + u3 + u4),
                  'modes': [fx.skill_mode(switch), fx.skill_mode({'_switchToMode': 1}), fx.skill_mode(own)],
                  'on': [fx.buff_target('ActiveBuffAbility', '_buffs', {'_selector': {'m_PathID': 5}}), fx.buff_target('AuraAbility', '_buffs', {}),
                         fx.buff_target('BuffDuringSkill', '_buffs', {}), fx.buff_target('SpawnTokenOnTileByIDAbility', '_buffsToToken', {}),
                         fx.buff_target('SomethingNew', '_buffs', {})],
                  'graph': fx.graph_effects(json.dumps([{'$type': 'Torappu.Battle.Action.Nodes+CreateEffect', '_effectKey': 'X_tpl_start'},
                                                        {'$type': 'Torappu.Battle.Action.Nodes+CreateBuff', '_buff': {'buffKey': 'b', 'overrideEffectKey': 'x_tpl_derived'}}]), ek)}))`);
    const hit = out.u1.find((u) => u.list === 'hit');
    assert.deepEqual(hit, { role: 'hit', keys: ['common_firemagic_hit_01'], from: 'UberEffectEmitter._hitEffects', node: 'skchr_x', ability: 'MeleeAttack', endEvent: 'ON_CAST_END', oneshot: true, list: 'hit' });
    const casts = out.u1.filter((u) => u.list === 'cast');
    assert.deepEqual(casts.map((u) => [u.role, u.keys, u.startEvent ?? null]), [
      ['start', ['ifrit_skill_02_start'], 'ON_CAST_START'],           // directionType 0: the first slot only (x_hit is a leftover)
      ['range', ['ifrit_skill_02_range'], 'ON_CAST_START'],           // keys lower case
      ['start', ['x_start_up', 'x_start', 'x_start_down'], 'ON_SPELL_ON'],
      ['loop', ['x_hook'], 'ON_CAST_START'],                          // a row without an effect of its own: its hook
    ]);
    assert.deepEqual(casts[2].slots, ['x_start_up', 'x_start', 'x_start_down', 'x_start']);
    assert.equal(casts[2].directionType, 3);
    assert.equal(casts[3].from, 'UberEffectEmitter._castEffects._hookEffectAfterFirstAttack');
    assert.deepEqual(out.u2, [{ role: 'loop', keys: ['buff_burn'], from: 'MeleeAttack._activeBuffs', on: 'targets', buff: 'ifrit_s_2', template: 'burn' }]);
    assert.deepEqual(out.u3.map((u) => [u.role, u.keys[0], u.on, u.event ?? u.bb ?? null]), [
      ['loop', 'x_skill_buff', 'owner', null],                       // no override: the template's effectKey
      ['start', 'x_tpl_start', 'owner', 'ON_BUFF_START'],
      ['end', 'x_tpl_finish', 'owner', 'ON_BUFF_FINISH'],
      ['loop', 'x_tpl_derived', 'owner', 'ON_BUFF_TRIGGER'],         // a buff the template creates loops
      ['hit', 'x_hit', 'owner', 'effect'],                           // a blackboard effect, placed by its name
    ]);
    assert.equal(out.u3[1].from, 'ActiveBuffAbility._buffs → template x_t');
    assert.deepEqual(out.u4, [{ role: 'ready', keys: ['x_ready'], from: 'ReadySkillEffect._effects' }]);
    assert.deepEqual(Object.keys(out.roles), ['start', 'loop', 'range', 'hit', 'end', 'ready'], 'roles in SKILL_ROLES order');
    assert.deepEqual(out.roles.start, ['ifrit_skill_02_start', 'x_start_up', 'x_start', 'x_start_down', 'x_tpl_start']);
    assert.deepEqual(out.modes, [2, 1, null]);
    assert.deepEqual(out.on, ['targets', 'targets', 'owner', 'token', null]);
    assert.deepEqual(out.graph, [['CreateEffect', '_effectKey', 'x_tpl_start'], ['CreateBuff', 'overrideEffectKey', 'x_tpl_derived']]);
  });
});

describe('extract.py: the fx run is opt-in', { skip: !PY && 'no python3' }, () => {
  test('fx_selected: only an --only prefix naming fx runs it (a plain run leaves the effects out)', () => {
    const src = `import sys, json\nsys.path.insert(0, ${JSON.stringify(TOOL)})\nimport extract as e\n`
      + `print(json.dumps([e.fx_selected(o) for o in ([], ['fx'], ['fx/'], ['fx/prefabs'], ['map'], ['f'], ['map', 'fx'])]))`;
    const r = spawnSync(PY, ['-c', src], { encoding: 'utf8', env: ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [false, true, true, true, false, false, true]);
  });

  test('an fx run drops the fx groups an earlier run left in data/local-assets.json (the files have data/local-fx.json)', () => {
    const src = `import sys, json\nsys.path.insert(0, ${JSON.stringify(TOOL)})\nimport extract as e, fx\n`
      + "old = {'fx': {'index': {}}, 'fx/prefabs': {'a': {}}, 'fx/tex': {}, 'map/fx': {'m': {}}, 'emoticon/x': {}}\n"
      + "print(json.dumps([sorted(e.ran_groups(old, {}, True)), sorted(e.ran_groups(old, {'map/fx': {}})),\n"
      + "  sorted(e.merge_manifest(old, {}, e.ran_groups(old, {}, True))), fx.FX_MANIFEST, list(fx.FX_GROUPS)]))";
    const r = spawnSync(PY, ['-c', src], { encoding: 'utf8', env: ENV });
    assert.equal(r.status, 0, r.stderr);
    const [afterFx, afterMap, merged, name, groups] = JSON.parse(r.stdout);
    assert.deepEqual(afterFx, ['fx', 'fx/prefabs', 'fx/tex'], 'map/fx is not an fx group');
    assert.deepEqual(afterMap, ['map/fx'], 'another run keeps the groups it did not write');
    assert.deepEqual(merged, ['emoticon/x', 'map/fx']);
    assert.equal(name, 'local-fx.json');
    assert.deepEqual(groups, ['fx', 'fx/prefabs', 'fx/tex', 'fx/mesh']);
  });

  test('--print-jobs lists the fx run: its output dir, format version and the Phase 1a sample', () => {
    const r = spawnSync(PY, [path.join(TOOL, 'extract.py'), '--print-jobs'], { encoding: 'utf8', env: ENV });
    assert.equal(r.status, 0, r.stderr);
    const { fx, jobs } = JSON.parse(r.stdout);
    assert.equal(fx.sub, 'fx');
    assert.equal(fx.version, 1);
    assert.equal(fx.optIn, true);
    for (const k of ['common_hit_01', 'buff_stun', 'buff_autochess_frozen', 'inside_attack_01_trail_front', 'ifrit_skill_03_buff', 'enemy_tidmag_attack_01_hit']) {
      assert.ok(fx.sample.keys.includes(k), k);
    }
    assert.ok(fx.sample.units.includes('char_498_inside') && fx.sample.units.includes('enemy_1041_lazerd'));
    assert.ok(!jobs.some((j) => j.sub === 'fx' || j.sub.startsWith('fx/')), 'not a plain job: the fx run has its own entry');
  });
});

describe('extracted effects (when fx was extracted on this machine)', { skip: !fxList?.groups?.fx?.index && 'fx not extracted' }, () => {
  const groups = fxList?.groups || {};
  const onDisk = (p) => path.join(ROOT, 'public', p);
  const hasFiles = existsSync(path.join(ROOT, 'public/assets/local/fx/index.json'));

  test('data/local-fx.json lists the fx files in its groups; data/local-assets.json has none of them', () => {
    assert.equal(fxList.format, 'fx-manifest');
    assert.deepEqual(Object.keys(fxList.groups).sort(), ['fx', 'fx/mesh', 'fx/prefabs', 'fx/tex']);
    assert.equal(fxList.count, Object.values(fxList.groups).reduce((n, g) => n + Object.keys(g).length, 0));
    for (const g of Object.keys(manifest?.groups || {})) assert.ok(g !== 'fx' && !g.startsWith('fx/'), `${g} left in data/local-assets.json`);
  });

  test('the list names every file, the index and the list agree, every named key has a descriptor', { skip: !hasFiles && 'files not here' }, () => {
    const index = JSON.parse(readFileSync(onDisk(groups.fx.index.path), 'utf8'));
    assert.equal(index.format, 'fx-index');
    assert.equal(index.version, groups.fx.index.version);
    assert.deepEqual(Object.keys(index.prefabs).sort(), Object.keys(groups['fx/prefabs']).sort(), 'one manifest entry per descriptor');
    for (const g of ['fx/prefabs', 'fx/tex', 'fx/mesh']) {
      for (const [k, e] of Object.entries(groups[g] || {})) {
        assert.ok(existsSync(onDisk(e.path)), `${g} ${k}: ${e.path}`);
        if (e.half) assert.ok(existsSync(onDisk(e.half)), `${g} ${k}: ${e.half}`);
      }
    }
    const named = new Set();
    for (const [id, u] of Object.entries(index.units)) {
      if (u.aliasOf) assert.ok(index.units[u.aliasOf] && !index.units[u.aliasOf].aliasOf, `${id}: aliasOf ${u.aliasOf} is a unit of its own`);
      for (const k of u.refs) named.add(k);
      for (const m of u.modes) {
        for (const l of ['cast', 'hit', 'attach', 'inputTarget', 'castTarget']) {
          for (const e of m.attack?.[l] || []) {
            for (const k of e.effects) named.add(k);
            for (const k of e.slots || []) if (k) named.add(k);
            if (e.hookEffectAfterFirstAttack) named.add(e.hookEffectAfterFirstAttack);
          }
        }
      }
    }
    for (const [sid, s] of Object.entries(index.skills)) {
      assert.ok(Array.isArray(s.uses) && Array.isArray(s.unclassified) && s.roles && typeof s.roles === 'object', `${sid}: uses / roles / unclassified`);
      for (const use of s.uses) {
        assert.ok(['start', 'loop', 'range', 'cast', 'hit', 'end', 'ready', 'trigger', 'other'].includes(use.role), `${sid}: role ${use.role}`);
        for (const k of [...use.keys, ...(use.slots || [])]) if (k) named.add(k);
      }
      if (s.mode !== null) assert.ok(Number.isInteger(s.mode) && ['data', 'name'].includes(s.modeBy), `${sid}: mode ${s.mode} by ${s.modeBy}`);
    }
    for (const p of Object.values(index.projectiles)) { if (p.main) named.add(p.main); for (const k of p.effects) named.add(k); }
    for (const v of Object.values(index.prefabs)) for (const k of v.refs) named.add(k);
    for (const g of ['hit', 'die', 'birth']) for (const k of Object.values(index.generic[g])) named.add(k);
    for (const k of named) assert.ok(index.prefabs[k], `${k} is named by the index and exported`);
    for (const [k, v] of Object.entries(index.prefabs)) {
      assert.equal(k, k.toLowerCase(), 'keys are lower case');
      const d = JSON.parse(readFileSync(onDisk(groups['fx/prefabs'][k].path), 'utf8'));
      assert.equal(d.format, 'fx-prefab');
      assert.equal(d.key, k);
      assert.equal(d.nodes.length, v.nodes);
      for (const t of d.textures) assert.ok(groups['fx/tex'][t], `${k}: texture ${t} listed`);
      for (const m of d.meshes) assert.ok(groups['fx/mesh'][m], `${k}: mesh ${m} listed`);
      for (const n of d.nodes) {
        for (const r of ['particleSystemRenderer', 'meshRenderer', 'trailRenderer', 'lineRenderer', 'skinnedMeshRenderer']) {
          for (const mi of n[r]?.materials || []) assert.ok(mi === null || (mi >= 0 && mi < d.materials.length), `${k} ${n.name}: material ${mi}`);
        }
      }
    }
  });
});
