// tools/local-extract/fx.py (DESIGN §33, docs/design/vfx-format.md): the encodings of the official battle effects'
// descriptors — curves, gradients, render states, decoded animation clips, mount-point matrices, the file names of
// effect keys — and extract.py's opt-in fx run. The Python helpers run without UnityPy (pure functions; plain
// python3). When the effects were extracted on this machine (data/local-assets.json has the fx groups), the output is
// checked for consistency: every listed file exists, the index and the manifest agree, every key the index names has
// a descriptor.

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
const manifest = (() => { try { return JSON.parse(readFileSync(path.join(ROOT, 'data/local-assets.json'), 'utf8')); } catch { return null; } })();

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
f = {'_castEffects': [{'_directionType': 0, '_effects': ['x_attack_01_start', '', '', ''], '_startEvent': 2, '_endEvent': 3}],
     '_hitEffects': [{'_effects': ['', '', '', '']}], '_attachEffects': []}
ps = {'lengthInSec': 1, 'looping': False, 'InitialModule': {'startLifetime': {'min': 0.2, 'max': 0.6}, 'maxNumParticles': 1000},
      'EmissionModule': {'rateOverTime': 10, 'm_Bursts': [{'countCurve': {'min': 2, 'max': 5}, 'cycleCount': 1}]}}
print(json.dumps({'lists': fx.emitter_lists(f), 'live': fx.est_live(ps)}))`);
    assert.deepEqual(out.lists, { cast: [{ directionType: 0, effects: ['x_attack_01_start'], startEvent: 2, endEvent: 3 }] });
    assert.equal(out.live, 11, '10/s × 0.6 s + a burst of 5');
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

describe('extracted effects (when fx was extracted on this machine)', { skip: !manifest?.groups?.fx?.index && 'fx not extracted' }, () => {
  const groups = manifest?.groups || {};
  const onDisk = (p) => path.join(ROOT, 'public', p);
  const hasFiles = existsSync(path.join(ROOT, 'public/assets/local/fx/index.json'));

  test('the manifest lists every file, the index and the manifest agree, every named key has a descriptor', { skip: !hasFiles && 'files not here' }, () => {
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
    for (const u of Object.values(index.units)) {
      for (const k of u.refs) named.add(k);
      for (const m of u.modes) for (const l of ['cast', 'hit', 'attach', 'inputTarget', 'castTarget']) for (const e of m.attack?.[l] || []) for (const k of e.effects) named.add(k);
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
