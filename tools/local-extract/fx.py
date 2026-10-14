"""The official battle effects (特效) of 卫戍协议：盟约 from a locally installed client
(DESIGN §33, docs/design/vfx-format.md: the format every file below follows).

Run through extract.py (needs the client and .venv-extract; nothing is extracted on a plain `extract.py` run):
  .venv/bin/python tools/local-extract/extract.py --only fx                 the Phase 1a sample (FX_SAMPLE_*)
  .venv/bin/python tools/local-extract/extract.py --only fx --fx-set used   every effect the mode's units reference
  .venv/bin/python tools/local-extract/extract.py --only fx --fx-keys common_hit_01,buff_stun

What is read (paths relative to the AB root, see extract.py CANDIDATES):
  battle/prefabs/effects/<code>.ab, pkgrps/btl_pfb_fx_*.ab   the effect prefabs (one prefab = one effect key)
  refs/fx/**, [uc]shaders.ab, shaders/*.ab, anon/*.bin       their shared materials / textures / meshes, the shaders
                                                             (only their names and render states are read), the
                                                             MonoScripts (class names of the behaviours)
  charpack/<charId>.ab, chararts/<charId>.ab                 the operators' attack modes / effect emitters, the skin
                                                             mount points (HitPoint, Muzzle, HeadPoint, …)
  battle/prefabs/[uc]projectiles.ab, [uc]skills.ab           projectile flight + effects, the skills' effect keys
  battle/enm_pfb_*.ab, pkgrps/btl_pfb_tokens_*.ab            enemies and tokens

What is written under <out>/fx (each file is listed in data/local-assets.json, so the server hashes its URL):
  index.json           per unit (charId / enemy key / token id): attack modes (cast / hit / projectile), skill effect
                       keys, mount points; the projectiles; the generic keys (hits, deaths, deploy, status loops)
  textures.json        texture key → size, wrap, filter, alpha, the WebP files
  prefabs/<file>.json  one descriptor per effect prefab: nodes (Unity-native transforms), ParticleSystems (every
                       enabled module), renderers, materials (shader name + resolved render state), decoded clips,
                       behaviours
  tex/<key>.webp       textures (WebP q90, alpha kept); tex/half/<key>.webp the half-size copy of the light tier
  mesh/<key>.json      meshes of mesh particles, MeshRenderers, SkinnedMeshRenderers and mesh shapes
Everything is (c) Hypergryph; for private, non-commercial fan use only. Nothing of it is ever committed.
"""
import hashlib
import json
import math
import os
import re
import struct
import sys
import time
import zlib
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

FX_SUB = 'fx'
FORMAT_VERSION = 1

# effect prefabs: battle/prefabs/effects/<prefix>.ab holds the keys `<prefix>_…`; the enemy / token / map effects are
# grouped in pkgrps packs (looked up through the container index)
EFFECT_GLOBS = ('battle/prefabs/effects/*.ab', 'pkgrps/btl_pfb_fx_*.ab')
# where the CABs an effect bundle depends on live (found by CAB name: their file names change between client versions)
CAB_DIRS = ('refs/fx', 'shaders', 'anon', 'arts/effects', 'battle/prefabs/effects', 'pkgrps')
CAB_FILES = ('[uc]shaders.ab', 'arts/maps/effect.ab')
PROJECTILES = 'battle/prefabs/[uc]projectiles.ab'
SKILLS = 'battle/prefabs/[uc]skills.ab'
ENEMY_GLOB = 'battle/enm_pfb_*.ab'
TOKEN_GLOB = 'pkgrps/btl_pfb_tokens_*.ab'

# The Phase 1a sample (handoff/vfx-feasibility.md): these effect keys, every effect the sample units reference, the
# generic keys (FX_GENERIC + every buff_* of buff.ab) and a few prefabs that cover the rarer features of the format
FX_SAMPLE_KEYS = [
    'common_hit_01', 'common_firemagic_hit_01', 'common_enemy_hit_01', 'common_char_die_01', 'common_enemy_die_01',
    'common_char_birth_01', 'buff_stun', 'buff_frozen', 'buff_autochess_frozen', 'buff_sleep', 'buff_burn', 'buff_cold',
    'inside_attack_01_start_front', 'inside_attack_01_trail_front', 'inside_attack_01_hit',
    'greyy_attack_01_start', 'greyy_attack_01_trail', 'greyy_attack_01_hit', 'silent_attack_01_trail', 'myrrh_attack_01_hit',
    'ifrit_attack_01_start', 'ifrit_skill_03_start', 'ifrit_skill_03_range', 'ifrit_skill_03_buff',
    'amgoat_skill_03_trail', 'amgoat_skill_03_hit', 'amgoat_skill_03_buff',
    'lazerd_attack_01_start', 'lazerd_attack_01_trail', 'lazerd_attack_01_hit', 'enemy_tidmag_attack_01_hit',
]
FX_SAMPLE_UNITS = ['char_498_inside', 'char_253_greyy', 'char_108_silent', 'char_134_ifrit', 'char_180_amgoat',
                   'enemy_1041_lazerd', 'enemy_1041_lazerd_2', 'enemy_1161_tidmag', 'enemy_1161_tidmag_2']
# one prefab per rare feature (DESIGN §33.13): mesh shape, ribbon / particle trails, rate over
# distance, orbital velocity, velocity alignment, horizontal billboard, custom-data shader, clips on GameObject.active /
# ParticleSystem / LineRenderer, LineRenderer, birth / death sub-emitters, prewarm
FX_COVERAGE_KEYS = [
    'swire2_skill_02_range', 'kroos2_attack_trail_01', 'bldsk_attack_01_start', 'vendla_attack_trail_01',
    'akkord_skill_02_buff_01', 'jesca2_skill_01_trail_01', 'chen2_skill_02_range_01', 'enemy_tgshd_attack_start_01',
    'crosly_attack_a_start', 'aphris_attack_01_line_01', 'enemy_jakill_reborn_03_start', 'irene_skill_03_range_02',
    'enemy_achunt_chain',
    # and one prefab per rarer behaviour class: SwitchableBackEffect, SwitchableRightEffect,
    # SwitchableEffectByFaceDirection, FollowTileHeight, FunnelHitEffect, TriggerAnimatorWhenFinish, OnFinishAnime,
    # PauseEffectIfDisappeared, FxUVRotation, FollowDirection, PauseEffectWithAnimation
    'chen2_skill_01_buff_02', 'indigo_skill_01_buff_02', 'angel2_attack_loop_start_01', 'sbell2_ground_01',
    'lumen_skill_02_hit', 'glady_skill_01_line', 'phatm2_skill_03_buff_02', 'etlchi_innate_hit_01', 'enemy_crstf_buff_01',
    'yu_skill1_attack_01', 'aglna2_skill_02_buff_weapon_02',
]
# Generic keys the client binds in code (no data file names them): what the remake shows for a hit by damage type, a
# death, a deploy, and the status loops keyed by the sim's status names (render/style.js STATUS_ICON)
FX_GENERIC = {
    'hit': {'phys': 'common_hit_01', 'arts': 'common_magic_hit_01', 'heal': 'common_heal_hit_01',
            'enemy': 'common_enemy_hit_01', 'fire': 'common_firemagic_hit_01', 'cut': 'common_cuting_hit_01',
            'ranger': 'common_ranger_hit_01'},
    'die': {'char': 'common_char_die_01', 'enemy': 'common_enemy_die_01'},
    'birth': {'char': 'common_char_birth_01'},
    'status': {'stun': 'buff_stun', 'freeze': 'buff_autochess_frozen', 'cold': 'buff_cold', 'sleep': 'buff_sleep',
               'burn': 'buff_burn', 'silence': 'buff_silence', 'slow': 'buff_slowdown', 'sluggish': 'buff_sluggish',
               'fear': 'common_buff_fear', 'levitate': 'common_levitate_01', 'bind': 'common_root_01',
               'groundbind': 'common_root_01', 'stealth': 'common_stealth', 'shield': 'common_shield_01',
               'weaken': 'buff_weak', 'fragile': 'buff_ fragile_01', 'artsFragile': 'buff_ fragile_01',
               'physFragile': 'buff_ fragile_01', 'elemFragile': 'buff_ fragile_01', 'defDown': 'buff_defdown',
               'resDown': 'buff_magic_resistance_down', 'aspdDown': 'buff_attack_speed_reduction_01',
               'disarm': 'common_disarm_01', 'invulnerable': 'common_invincible_01', 'poison': 'buff_poison'},
}
FX_GENERIC_BUNDLES = ('battle/prefabs/effects/buff.ab',)   # every prefab of these is a generic key too

FX_SAFE = re.compile(r'[^A-Za-z0-9_.\-]+')
WEBP_QUALITY = 90
WEBP_METHOD = 4        # libwebp effort: 6 is ~90x slower here for 4.5 % smaller files
HALF_MIN = 64          # textures smaller than this (either side) get no half-size copy

# ---- Unity enums (UnityEngine) used by the descriptors ----------------------------------------------------------------
BLEND = ['Zero', 'One', 'DstColor', 'SrcColor', 'OneMinusDstColor', 'SrcAlpha', 'OneMinusSrcColor', 'DstAlpha',
         'OneMinusDstAlpha', 'SrcAlphaSaturate', 'OneMinusSrcAlpha']
BLEND_OP = ['Add', 'Subtract', 'ReverseSubtract', 'Min', 'Max']
COMPARE = ['Disabled', 'Never', 'Less', 'Equal', 'LessEqual', 'Greater', 'NotEqual', 'GreaterEqual', 'Always']
CULL = ['Off', 'Front', 'Back']
SHAPE_TYPES = ['sphere', 'sphereShell', 'hemisphere', 'hemisphereShell', 'cone', 'box', 'mesh', 'coneShell', 'coneVolume',
               'coneVolumeShell', 'circle', 'circleEdge', 'singleSidedEdge', 'meshRenderer', 'skinnedMeshRenderer',
               'boxShell', 'boxEdge', 'donut', 'rectangle', 'sprite', 'spriteRenderer']
RENDER_MODES = ['billboard', 'stretch', 'horizontalBillboard', 'verticalBillboard', 'mesh', 'none']
RENDER_ALIGN = ['view', 'world', 'local', 'facing', 'velocity']
VERTEX_STREAMS = ['Position', 'Normal', 'Tangent', 'Color', 'UV', 'UV2', 'UV3', 'UV4', 'AnimBlend', 'AnimFrame', 'Center',
                  'VertexID', 'SizeX', 'SizeXY', 'SizeXYZ', 'Rotation', 'Rotation3D', 'RotationSpeed', 'RotationSpeed3D',
                  'Velocity', 'Speed', 'AgePercent', 'InvStartLifetime', 'StableRandomX', 'StableRandomXY',
                  'StableRandomXYZ', 'StableRandomXYZW', 'VaryingRandomX', 'VaryingRandomXY', 'VaryingRandomXYZ',
                  'VaryingRandomXYZW', 'Custom1X', 'Custom1XY', 'Custom1XYZ', 'Custom1XYZW', 'Custom2X', 'Custom2XY',
                  'Custom2XYZ', 'Custom2XYZW', 'NoiseSumX', 'NoiseSumXY', 'NoiseSumXYZ', 'NoiseImpulseX',
                  'NoiseImpulseXY', 'NoiseImpulseXYZ', 'MeshIndex', 'ParticleIndex', 'ColorPackedAsTwoFloats']
TEXTURE_FORMATS = {1: 'Alpha8', 3: 'RGB24', 4: 'RGBA32', 5: 'ARGB32', 7: 'RGB565', 10: 'DXT1', 12: 'DXT5', 13: 'RGBA4444',
                   25: 'BC7', 26: 'BC4', 27: 'BC5', 34: 'ETC_RGB4', 45: 'ETC2_RGB', 47: 'ETC2_RGBA8', 48: 'ASTC_4x4',
                   49: 'ASTC_5x5', 50: 'ASTC_6x6', 51: 'ASTC_8x8', 52: 'ASTC_10x10', 53: 'ASTC_12x12'}
CLASS_IDS = {1: 'GameObject', 4: 'Transform', 23: 'MeshRenderer', 33: 'MeshFilter', 95: 'Animator', 96: 'TrailRenderer',
             108: 'Light', 111: 'Animation', 114: 'MonoBehaviour', 120: 'LineRenderer', 137: 'SkinnedMeshRenderer',
             198: 'ParticleSystem', 199: 'ParticleSystemRenderer', 212: 'SpriteRenderer', 224: 'RectTransform'}
# Unity's built-in meshes (the player's "unity default resources", not in any bundle), by path id
BUILTIN_MESHES = {10202: 'Cube', 10206: 'Cylinder', 10207: 'Sphere', 10208: 'Capsule', 10209: 'Plane', 10210: 'Quad'}
TRANSFORM_PROPS = {1: ('localPosition', 'xyz'), 2: ('localRotation', 'xyzw'), 3: ('localScale', 'xyz'),
                   4: ('localEulerAnglesRaw', 'xyz')}
MATERIAL_COMPONENTS = {0: 'x', 1: 'y', 2: 'z', 3: 'w', 4: 'r', 5: 'g', 6: 'b', 7: 'a', 8: ''}
PS_MODULES = ('InitialModule', 'ShapeModule', 'EmissionModule', 'SizeModule', 'RotationModule', 'ColorModule', 'UVModule',
              'VelocityModule', 'InheritVelocityModule', 'LifetimeByEmitterSpeedModule', 'ForceModule',
              'ExternalForcesModule', 'ClampVelocityModule', 'NoiseModule', 'SizeBySpeedModule', 'RotationBySpeedModule',
              'ColorBySpeedModule', 'CollisionModule', 'TriggerModule', 'SubModule', 'LightsModule', 'TrailModule',
              'CustomDataModule')
PS_TOP = ('lengthInSec', 'simulationSpeed', 'stopAction', 'cullingMode', 'ringBufferMode', 'ringBufferLoopRange',
          'emitterVelocityMode', 'looping', 'prewarm', 'playOnAwake', 'useUnscaledTime', 'autoRandomSeed', 'startDelay',
          'moveWithTransform', 'moveWithCustomTransform', 'scalingMode', 'randomSeed')
RENDERER_COMMON = ('m_Enabled', 'm_SortingLayerID', 'm_SortingLayer', 'm_SortingOrder')
PSR_FIELDS = ('m_RenderMode', 'm_RenderAlignment', 'm_SortMode', 'm_SortingFudge', 'm_MinParticleSize', 'm_MaxParticleSize',
              'm_CameraVelocityScale', 'm_VelocityScale', 'm_LengthScale', 'm_NormalDirection', 'm_Pivot', 'm_Flip',
              'm_AllowRoll', 'm_FreeformStretching', 'm_RotateWithStretchDirection', 'm_UseCustomVertexStreams',
              'm_VertexStreams', 'm_MeshDistribution', 'm_Mesh', 'm_Mesh1', 'm_Mesh2', 'm_Mesh3', 'm_MeshWeighting',
              'm_MeshWeighting1', 'm_MeshWeighting2', 'm_MeshWeighting3', 'm_MaskInteraction')
TRAIL_FIELDS = ('m_Time', 'm_Parameters', 'm_MinVertexDistance', 'm_Autodestruct', 'm_Emitting')
LINE_FIELDS = ('m_Positions', 'm_Parameters', 'm_UseWorldSpace', 'm_Loop')
SKIN_FIELDS = ('m_Mesh', 'm_Bones', 'm_RootBone', 'm_Quality', 'm_UpdateWhenOffscreen', 'm_BlendShapeWeights')
SKIP_FIELDS = {'m_GameObject', 'm_Script', 'm_Name', 'm_Enabled'}
MOUNT_NAME = re.compile(r'(Point|Muzzle|Anchor|^Special)', re.I)


# ---- pure helpers (no UnityPy; test/local-extract-fx.test.js) ---------------------------------------------------------

def fx_file(key):
    """File stem of an effect key: the key when it is URL-safe, else its safe form + the key's CRC32 (keys hold spaces,
    `#`, `[`, `]`: 'buff_ fragile_01', 'x#1')."""
    s = FX_SAFE.sub('_', key).strip('._') or 'fx'
    return s if s == key else f'{s}-{zlib.crc32(key.encode("utf-8")) & 0xffffffff:08x}'


def f6(v):
    """JSON-safe number: 6 significant digits, -0 → 0; NaN / ±inf → None."""
    if isinstance(v, bool):
        return v
    if isinstance(v, int):
        return v
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if x != x or x in (math.inf, -math.inf):
        return None
    if abs(x) < 1e-12:
        return 0
    y = float(f'{x:.6g}')
    return int(y) if y.is_integer() and abs(y) < 1e15 else y


def enc_keys(curve):
    """AnimationCurve → [[time, value, inSlope, outSlope(, weightedMode, inWeight, outWeight)], …]; an infinite slope
    (Unity's stepped tangent) is null."""
    out = []
    for k in (curve or {}).get('m_Curve', []) or []:
        row = [f6(k.get('time', 0)), f6(k.get('value', 0)), f6(k.get('inSlope', 0)), f6(k.get('outSlope', 0))]
        wm = k.get('weightedMode', 0) or 0
        if wm:
            row += [wm, f6(k.get('inWeight', 1 / 3)), f6(k.get('outWeight', 1 / 3))]
        out.append(row)
    return out


def enc_mmc(c):
    """MinMaxCurve → number (Constant) | {min, max} (TwoConstants) | {scalar, curve} (Curve) |
    {scalar, minCurve, maxCurve} (TwoCurves)."""
    st = c.get('minMaxState', 0)
    s = f6(c.get('scalar', 0))
    if st == 0:
        return s
    if st == 3:
        return {'min': f6(c.get('minScalar', 0)), 'max': s}
    if st == 1:
        return {'scalar': s, 'curve': enc_keys(c.get('maxCurve'))}
    return {'scalar': s, 'minCurve': enc_keys(c.get('minCurve')), 'maxCurve': enc_keys(c.get('maxCurve'))}


def enc_color(c):
    return [f6(c.get('r', 0)), f6(c.get('g', 0)), f6(c.get('b', 0)), f6(c.get('a', 0))]


def enc_gradient(g):
    """Gradient → {mode: 'blend'|'fixed', color: [[t, r, g, b]…], alpha: [[t, a]…]} (t in 0…1)."""
    nc = g.get('m_NumColorKeys', 2)
    na = g.get('m_NumAlphaKeys', 2)
    col = [[f6(g.get(f'ctime{i}', 0) / 65535.0)] + enc_color(g.get(f'key{i}', {}))[:3] for i in range(nc)]
    alp = [[f6(g.get(f'atime{i}', 0) / 65535.0), f6(g.get(f'key{i}', {}).get('a', 1))] for i in range(na)]
    return {'mode': 'fixed' if g.get('m_Mode', 0) == 1 else 'blend', 'color': col, 'alpha': alp}


def enc_mmg(c):
    """MinMaxGradient → [r, g, b, a] (Color) | {min, max} (TwoColors) | {gradient} | {minGradient, maxGradient} |
    {random} (RandomColor: a random point of the gradient)."""
    st = c.get('minMaxState', 0)
    if st == 0:
        return enc_color(c.get('maxColor', {}))
    if st == 2:
        return {'min': enc_color(c.get('minColor', {})), 'max': enc_color(c.get('maxColor', {}))}
    if st == 1:
        return {'gradient': enc_gradient(c.get('maxGradient', {}))}
    if st == 3:
        return {'minGradient': enc_gradient(c.get('minGradient', {})), 'maxGradient': enc_gradient(c.get('maxGradient', {}))}
    return {'random': enc_gradient(c.get('maxGradient', {}))}


def is_pptr(v):
    return isinstance(v, dict) and set(v) == {'m_FileID', 'm_PathID'}


def is_mmc(v):
    return isinstance(v, dict) and 'minMaxState' in v and 'scalar' in v and 'maxCurve' in v


def is_mmg(v):
    return isinstance(v, dict) and 'minMaxState' in v and 'maxColor' in v


def is_gradient(v):
    return isinstance(v, dict) and 'key0' in v and 'ctime0' in v


def is_curve(v):
    return isinstance(v, dict) and 'm_Curve' in v


def is_vec(v):
    return isinstance(v, dict) and v and set(v) <= {'x', 'y', 'z', 'w'} and all(isinstance(x, (int, float)) for x in v.values())


def is_rgba(v):
    return isinstance(v, dict) and set(v) == {'r', 'g', 'b', 'a'}


def enc_value(v, pptr):
    """Encode a typetree value for a descriptor: MinMaxCurve / MinMaxGradient / Gradient / AnimationCurve / PPtr
    (through `pptr(dict)`) / vectors / colours / floats; everything else recursively."""
    if is_pptr(v):
        return pptr(v)
    if is_mmc(v):
        return enc_mmc(v)
    if is_mmg(v):
        return enc_mmg(v)
    if is_gradient(v):
        return enc_gradient(v)
    if is_curve(v):
        return enc_keys(v)
    if is_rgba(v):
        return enc_color(v)
    if is_vec(v):
        return [f6(v[k]) for k in 'xyzw' if k in v]
    if isinstance(v, dict):
        return {k: enc_value(x, pptr) for k, x in v.items() if k != 'serializedVersion'}
    if isinstance(v, (list, tuple)):
        return [enc_value(x, pptr) for x in v]
    if isinstance(v, float):
        return f6(v)
    return v


def enum_name(table, v):
    try:
        i = int(v)
    except (TypeError, ValueError):
        return None
    return table[i] if 0 <= i < len(table) else str(i)


def state_value(state, floats, defaults=None):
    """A shader render-state value ({val, name}): when the state names a property, the material's float, else the
    property's default in the shader (Unity uses it for a property the material does not store); else the value
    written in the shader."""
    name = (state or {}).get('name') or ''
    if name and name != '<noninit>':
        if name in floats:
            return floats[name]
        if defaults and name in defaults:
            return defaults[name]
    return (state or {}).get('val', 0)


def render_state(pass_state, floats, defaults=None):
    """Resolved render state of one shader pass for a material: blend factors (colour src, dst, alpha src, dst) and
    op, ZTest, ZWrite, cull, colour mask."""
    v = lambda st: state_value(st, floats, defaults)  # noqa: E731
    rt = pass_state.get('rtBlend0', {})
    return {
        'blend': [enum_name(BLEND, v(rt.get('srcBlend'))), enum_name(BLEND, v(rt.get('destBlend'))),
                  enum_name(BLEND, v(rt.get('srcBlendAlpha'))), enum_name(BLEND, v(rt.get('destBlendAlpha')))],
        'blendOp': enum_name(BLEND_OP, v(rt.get('blendOp'))),
        'zTest': enum_name(COMPARE, v(pass_state.get('zTest'))),
        'zWrite': bool(v(pass_state.get('zWrite'))),
        'cull': enum_name(CULL, v(pass_state.get('culling'))),
        'colorMask': int(v(rt.get('colMask')) or 0),
    }


def decode_streamed(words):
    """A streamed clip (uint32 words) → [(time, [(curve, a, b, c, d)…])…]. Frame 0 sits at -FLT_MAX (start values),
    the last one at +inf (empty)."""
    raw = struct.pack('<%dI' % len(words), *words)
    frames, off = [], 0
    while off + 8 <= len(raw):
        t, n = struct.unpack_from('<fI', raw, off)
        off += 8
        keys = []
        for _ in range(n):
            if off + 20 > len(raw):
                break
            keys.append(struct.unpack_from('<i4f', raw, off))
            off += 20
        frames.append((t, keys))
    return frames


def streamed_curves(frames):
    """Per curve index, Hermite keys [[t, v, in, out]…] from the streamed frames: v = d, out = c of the key's own
    segment p(Δ) = aΔ³ + bΔ² + cΔ + d; in = the previous segment's slope at its end (3aΔ² + 2bΔ + c), null when that
    segment is stepped (a = b = c = 0 and the value jumps)."""
    seq = {}
    for t, keys in frames:
        if not (abs(t) < 1e30):
            continue
        for idx, a, b, c, d in keys:
            seq.setdefault(idx, []).append((t, a, b, c, d))
    out = {}
    for idx, ks in seq.items():
        rows = []
        for i, (t, a, b, c, d) in enumerate(ks):
            if i == 0:
                ins = c
            else:
                t0, a0, b0, c0, d0 = ks[i - 1]
                dt = t - t0
                if a0 == 0 and b0 == 0 and c0 == 0 and abs(d - d0) > 1e-9:
                    ins = None
                else:
                    ins = 3 * a0 * dt * dt + 2 * b0 * dt + c0
            stepped_out = (a == 0 and b == 0 and c == 0 and i + 1 < len(ks) and abs(ks[i + 1][4] - d) > 1e-9)
            rows.append([f6(t), f6(d), None if ins is None else f6(ins), None if stepped_out else f6(c)])
        out[idx] = rows
    return out


def dense_curves(dense, offset):
    """A dense clip (frame-major samples) → per curve index (offset + i), linear keys."""
    n, count = dense.get('m_FrameCount', 0), dense.get('m_CurveCount', 0)
    samples, rate, begin = dense.get('m_SampleArray', []) or [], dense.get('m_SampleRate', 30) or 30, dense.get('m_BeginTime', 0)
    out = {}
    if not count or not n:
        return out
    dt = 1.0 / rate
    for c in range(count):
        vals = [samples[f * count + c] for f in range(n) if f * count + c < len(samples)]
        rows = []
        for f, v in enumerate(vals):
            ins = (v - vals[f - 1]) / dt if f > 0 else 0.0
            outs = (vals[f + 1] - v) / dt if f + 1 < len(vals) else 0.0
            rows.append([f6(begin + f * dt), f6(v), f6(ins), f6(outs)])
        out[offset + c] = rows
    return out


def binding_dims(b):
    """How many curves one generic binding drives: a Transform position / scale / euler 3, a rotation 4, else 1."""
    if b.get('typeID') == 4 and b.get('attribute') in TRANSFORM_PROPS:
        return len(TRANSFORM_PROPS[b['attribute']][1])
    return 1


def material_attribute(attr):
    """(property-name CRC32 & 0x0FFFFFFF, component) of a material-property binding attribute (customType 22): the
    top four bits are the component — 0–3 a vector's x y z w, 4–7 a colour's r g b a, 8 a float."""
    return attr & 0x0FFFFFFF, MATERIAL_COMPONENTS.get(attr >> 28, str(attr >> 28))


def typetree_paths(tree, prefix='', depth=0, out=None):
    """Every dotted field path of a typetree (lists are not entered) — the candidates of a generic binding."""
    out = set() if out is None else out
    if depth > 6 or not isinstance(tree, dict):
        return out
    for k, v in tree.items():
        p = f'{prefix}.{k}' if prefix else k
        out.add(p)
        if isinstance(v, dict):
            typetree_paths(v, p, depth + 1, out)
    return out


def trs_matrix(pos, rot, scale):
    """3×4 matrix [R·S | t] of a Unity local transform (rot = quaternion x y z w)."""
    x, y, z, w = rot
    r = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
         [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
         [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    return [[r[i][0] * scale[0], r[i][1] * scale[1], r[i][2] * scale[2], pos[i]] for i in range(3)]


def mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) + (a[i][3] if j == 3 else 0) for j in range(4)] for i in range(3)]


def mat_point(m):
    return [f6(m[0][3]), f6(m[1][3]), f6(m[2][3])]


def est_live(ps):
    """Rough peak count of live particles of one encoded ParticleSystem (descriptor stats only)."""
    def top(v):
        if isinstance(v, (int, float)):
            return abs(v)
        if isinstance(v, dict):
            if 'max' in v:
                return max(abs(v.get('min') or 0), abs(v.get('max') or 0))
            keys = (v.get('curve') or []) + (v.get('maxCurve') or []) + (v.get('minCurve') or [])
            return abs(v.get('scalar') or 0) * max([abs(k[1] or 0) for k in keys] or [0])
        return 0
    im = ps.get('InitialModule', {})
    life, dur = top(im.get('startLifetime', 0)), ps.get('lengthInSec') or 1
    em = ps.get('EmissionModule')
    rate = top(em.get('rateOverTime', 0)) if em else 0
    bursts = sum(top(b.get('countCurve', 0)) * max(1, b.get('cycleCount', 1) or 1) for b in (em or {}).get('m_Bursts', []))
    span = life if ps.get('looping') else min(life, dur)
    n = rate * span + (bursts * min(1.0, life / max(dur, 1e-3)) if ps.get('looping') else bursts)
    return min(im.get('maxNumParticles', 1000) or 1000, n)


# ---- UnityPy side ---------------------------------------------------------------------------------------------------

def scan_cabs(ab_root, dirs=CAB_DIRS, files=CAB_FILES):
    """CAB name (lower case) → absolute path of every bundle under `dirs` / `files`, from the UnityFS headers only."""
    import lz4.block
    from aklz4 import decompress_lz4ak
    out = {}
    paths = []
    for d in dirs:
        base = Path(ab_root) / d
        if base.is_dir():
            paths += [p for p in base.rglob('*') if p.is_file() and p.suffix in ('.ab', '.bin')]
    paths += [Path(ab_root) / f for f in files if (Path(ab_root) / f).is_file()]
    for p in paths:
        try:
            for name in bundle_nodes(p, lz4.block, decompress_lz4ak):
                out.setdefault(name.lower(), str(p))
        except Exception:  # not a UnityFS file / unknown compression: skipped
            continue
    return out


def bundle_nodes(path, lz4block, lz4ak):
    """Node names (CAB-…) of a UnityFS bundle from its header and block info."""
    def cstr(f):
        b = bytearray()
        while True:
            c = f.read(1)
            if not c or c == b'\0':
                return b.decode('utf-8', 'replace')
            b += c
    with open(path, 'rb') as f:
        if cstr(f) != 'UnityFS':
            return []
        ver = struct.unpack('>I', f.read(4))[0]
        cstr(f)
        cstr(f)
        size, csz, usz, flags = struct.unpack('>qIII', f.read(20))
        if ver >= 7:
            f.seek((f.tell() + 15) // 16 * 16)
        if flags & 0x80:
            f.seek((size or os.path.getsize(path)) - csz)
        data = f.read(csz)
    comp = flags & 0x3F
    raw = data if comp == 0 else lz4block.decompress(data, usz) if comp in (2, 3) else lz4ak(data, usz) if comp == 4 else None
    if raw is None:
        return []
    off = 16
    nb = struct.unpack_from('>i', raw, off)[0]
    off += 4 + nb * 10
    nn = struct.unpack_from('>i', raw, off)[0]
    off += 4
    names = []
    for _ in range(nn):
        off += 20
        e = raw.index(b'\0', off)
        names.append(raw[off:e].decode())
        off = e + 1
    return names


class AssetEnv:
    """A UnityPy environment that loads the CABs a PPtr names on demand (scan_cabs), resolves PPtrs across files and
    caches typetrees / script class names."""

    def __init__(self, ab_root, cabs):
        import aklz4  # noqa: F401  (registers the LZ4AK decoder)
        import UnityPy
        self.ab_root = Path(ab_root)
        self.env = UnityPy.Environment()
        self.cabs = cabs
        self.loaded = {}
        self.sf = {}
        self._tt = {}
        self._script = {}

    def load(self, path):
        """Load a bundle (once); returns its serialized files."""
        path = str(path)
        if path in self.loaded:
            return self.loaded[path]
        before = set(self.sf)
        self.env.load_file(path)
        self._index()
        self.loaded[path] = [self.sf[k] for k in self.sf if k not in before]
        return self.loaded[path]

    def load_rel(self, rel):
        return self.load(self.ab_root / rel)

    def _index(self):
        def walk(f):
            for name, sub in getattr(f, 'files', {}).items():
                if hasattr(sub, 'objects') and hasattr(sub, 'externals'):
                    self.sf.setdefault(name.lower(), sub)
                else:
                    walk(sub)
        for f in list(self.env.files.values()):
            walk(f)

    def sfile(self, cab):
        cab = cab.lower()
        if cab not in self.sf and cab in self.cabs:
            try:
                self.load(self.cabs[cab])
            except Exception:
                pass
        return self.sf.get(cab)

    def resolve(self, sfile, pptr):
        """(file, object) of a typetree PPtr seen in `sfile`; ('builtin', path id) for Unity's default resources;
        (None, None) when null or unresolvable."""
        if not isinstance(pptr, dict):
            return None, None
        fid, pid = pptr.get('m_FileID', 0), pptr.get('m_PathID', 0)
        if not pid:
            return None, None
        if fid == 0:
            tgt = sfile
        else:
            try:
                ext = sfile.externals[fid - 1].path
            except (IndexError, AttributeError):
                return None, None
            name = ext.replace('\\', '/').split('/')[-1]
            if 'unity default resources' in ext.lower() or 'unity_builtin' in ext.lower():
                return 'builtin', pid
            tgt = self.sfile(name)
            if tgt is None:
                return None, None
        o = tgt.objects.get(pid)
        return (tgt, o) if o is not None else (None, None)

    def tt(self, o):
        k = (id(o.assets_file), o.path_id)
        if k not in self._tt:
            self._tt[k] = o.read_typetree()
        return self._tt[k]

    def script(self, o):
        """(namespace, class) of a MonoBehaviour."""
        k = (id(o.assets_file), o.path_id)
        if k not in self._script:
            try:
                d = self.tt(o)
                f, ms = self.resolve(o.assets_file, d.get('m_Script'))
                st = self.tt(ms) if ms is not None and f != 'builtin' else {}
                self._script[k] = (st.get('m_Namespace', ''), st.get('m_ClassName', '?'))
            except Exception:
                self._script[k] = ('', '?')
        return self._script[k]

    def prefabs(self, rel, full=False):
        """prefab name (or full container path with `full`) → GameObject reader, for the containers of bundle `rel`
        only (loading it when needed)."""
        out = {}
        for sf in self.load_rel(rel):
            cont = getattr(sf, 'container', None) or {}
            for path, obj in cont.items():
                if not path.endswith('.prefab'):
                    continue
                try:
                    o = obj.deref() if hasattr(obj, 'deref') else obj
                except Exception:
                    continue
                out.setdefault(path if full else path.split('/')[-1][:-len('.prefab')], o)
        return out


def go_children(env, go):
    """Child GameObjects of a GameObject (through its Transform)."""
    d = env.tt(go)
    for c in d.get('m_Component', []):
        f, o = env.resolve(go.assets_file, c.get('component'))
        if o is None or f == 'builtin' or o.type.name not in ('Transform', 'RectTransform'):
            continue
        kids = []
        for ch in env.tt(o).get('m_Children', []):
            tf, to = env.resolve(o.assets_file, ch)
            if to is None or tf == 'builtin':
                continue
            gf, g = env.resolve(to.assets_file, env.tt(to).get('m_GameObject'))
            if g is not None and gf != 'builtin':
                kids.append(g)
        return kids
    return []


def go_transform(env, go):
    d = env.tt(go)
    for c in d.get('m_Component', []):
        f, o = env.resolve(go.assets_file, c.get('component'))
        if o is not None and f != 'builtin' and o.type.name in ('Transform', 'RectTransform'):
            t = env.tt(o)
            p, q, s = t['m_LocalPosition'], t['m_LocalRotation'], t['m_LocalScale']
            return [p['x'], p['y'], p['z']], [q['x'], q['y'], q['z'], q['w']], [s['x'], s['y'], s['z']]
    return [0, 0, 0], [0, 0, 0, 1], [1, 1, 1]


def all_strings(v, out, quoted=re.compile(r'"([^"\\]{2,160})"')):
    """Every string of a typetree, and every quoted token inside long / serialized (Odin JSON) strings."""
    if isinstance(v, dict):
        for x in v.values():
            all_strings(x, out)
    elif isinstance(v, (list, tuple)):
        for x in v:
            all_strings(x, out)
    elif isinstance(v, str) and v:
        if len(v) < 200 and '"' not in v:
            out.add(v)
        else:
            out.update(quoted.findall(v))
    return out


# ---- the effect descriptor ------------------------------------------------------------------------------------------

EFFECT_KEYS = frozenset()   # every effect prefab key of the client (set in each worker: the behaviours' references)


def _init_worker(keys):
    global EFFECT_KEYS
    EFFECT_KEYS = frozenset(keys)


def string_values(v, out):
    """Every string inside an encoded value."""
    if isinstance(v, str):
        out.add(v)
    elif isinstance(v, dict):
        for x in v.values():
            string_values(x, out)
    elif isinstance(v, list):
        for x in v:
            string_values(x, out)
    return out


class Exporter:
    """Writes the descriptors, textures and meshes of the effect prefabs of one AssetEnv into <out>/fx."""

    def __init__(self, env, out_root, log=print):
        self.env = env
        self.out = Path(out_root) / FX_SUB
        self.log = log
        self.textures = {}      # key → meta
        self.meshes = {}        # key → meta
        self._tex_keys = {}     # (file id, path id) → key
        self._mesh_keys = {}
        self._shader = {}

    # -- textures / meshes --------------------------------------------------------------------------------------------
    def texture(self, f, o):
        k = (id(f), o.path_id)
        if k in self._tex_keys:
            return self._tex_keys[k]
        key = None
        try:
            key = self._export_texture(o)
        except Exception as e:
            self.log(f'  warn texture #{o.path_id}: {e}')
        self._tex_keys[k] = key
        return key

    def _export_texture(self, o):
        from PIL import Image
        t = o.read()
        d = self.env.tt(o)
        img = t.image
        if img is None:
            return None
        h = hashlib.sha1(f'{img.mode}:{img.size}'.encode())
        h.update(img.tobytes())                               # the pixels: identical copies in other bundles share a key
        key = f'{FX_SAFE.sub("_", t.m_Name or "tex").strip("._") or "tex"}-{h.hexdigest()[:8]}'
        if key in self.textures:
            return key
        has_alpha = 'A' in img.getbands() and img.getchannel('A').getextrema()[0] < 255
        img = img.convert('RGBA') if has_alpha else img.convert('RGB')
        tex_dir = self.out / 'tex'
        full = tex_dir / f'{key}.webp'
        half = tex_dir / 'half' / f'{key}.webp'
        meta = {'name': t.m_Name, 'w': t.m_Width, 'h': t.m_Height, 'format': TEXTURE_FORMATS.get(d.get('m_TextureFormat'), str(d.get('m_TextureFormat'))),
                'mips': d.get('m_MipCount', 1), 'srgb': d.get('m_ColorSpace', 1) == 1, 'alpha': has_alpha,
                'file': f'tex/{key}.webp', 'half': None}
        ts = d.get('m_TextureSettings', {})
        meta.update({'wrapU': ['repeat', 'clamp', 'mirror', 'mirrorOnce'][min(3, ts.get('m_WrapU', 0))],
                     'wrapV': ['repeat', 'clamp', 'mirror', 'mirrorOnce'][min(3, ts.get('m_WrapV', 0))],
                     'filter': ['point', 'bilinear', 'trilinear'][min(2, ts.get('m_FilterMode', 1))], 'aniso': ts.get('m_Aniso', 0)})
        save_webp(img, full)
        if t.m_Width >= HALF_MIN and t.m_Height >= HALF_MIN:
            size = (max(1, t.m_Width // 2), max(1, t.m_Height // 2))
            small = img.convert('RGBa').resize(size, Image.LANCZOS).convert('RGBA') if has_alpha else img.resize(size, Image.LANCZOS)
            save_webp(small, half)
            meta['half'] = f'tex/half/{key}.webp'
        self.textures[key] = meta
        return key

    def mesh(self, f, o):
        if f == 'builtin':
            return f'builtin:{BUILTIN_MESHES.get(o, o)}'
        k = (id(f), o.path_id)
        if k in self._mesh_keys:
            return self._mesh_keys[k]
        key = None
        try:
            key = self._export_mesh(o)
        except Exception as e:
            self.log(f'  warn mesh #{o.path_id}: {e}')
        self._mesh_keys[k] = key
        return key

    def _export_mesh(self, o):
        from UnityPy.helpers.MeshHelper import MeshHandler
        m = o.read()
        h = MeshHandler(m)
        h.process()
        flat = lambda rows, n: [f6(x) for r in (rows or []) for x in list(r)[:n]]  # noqa: E731
        doc = {'format': 'fx-mesh', 'version': FORMAT_VERSION, 'name': m.m_Name, 'vertexCount': h.m_VertexCount,
               'positions': flat(h.m_Vertices, 3)}
        if h.m_Normals:
            doc['normals'] = flat(h.m_Normals, 3)
        if h.m_UV0:
            doc['uv0'] = flat(h.m_UV0, 2)
        if h.m_UV1:
            doc['uv1'] = flat(h.m_UV1, 2)
        if h.m_Colors:
            doc['colors'] = flat(h.m_Colors, 4)
        doc['submeshes'] = [[i for tri in sub for i in tri] for sub in h.get_triangles()]
        if h.m_BoneWeights:
            doc['boneWeights'] = flat(h.m_BoneWeights, 4)
            doc['boneIndices'] = [int(x) for r in (h.m_BoneIndices or []) for x in list(r)[:4]]
            doc['bindPoses'] = [[f6(bp.get(f'e{r}{c}', 0)) for r in range(4) for c in range(4)] for bp in (self.env.tt(o).get('m_BindPose') or [])]
        body = json.dumps(doc, separators=(',', ':'))
        key = f'{FX_SAFE.sub("_", m.m_Name or "mesh").strip("._") or "mesh"}-{hashlib.sha1(body.encode()).hexdigest()[:8]}'
        if key not in self.meshes:
            path = self.out / 'mesh' / f'{key}.json'
            write_atomic(path, body.encode('utf-8'))
            self.meshes[key] = {'name': m.m_Name, 'verts': h.m_VertexCount, 'file': f'mesh/{key}.json'}
        return key

    # -- shaders / materials ------------------------------------------------------------------------------------------
    def shader_info(self, f, o):
        """Name, declared properties (type, default), first-subshader pass states and queue tag of a shader."""
        k = (id(f), o.path_id)
        if k not in self._shader:
            info = {'name': None, 'props': None, 'passes': [], 'queue': None}
            try:
                d = self.env.tt(o)
                pf = d.get('m_ParsedForm', {})
                info['name'] = pf.get('m_Name')
                info['props'] = {p.get('m_Name'): {'type': p.get('m_Type'), 'default': [p.get(f'm_DefValue[{i}]', 0) for i in range(4)],
                                                   'texture': (p.get('m_DefTexture') or {}).get('m_DefaultName')}
                                 for p in pf.get('m_PropInfo', {}).get('m_Props', [])}
                subs = pf.get('m_SubShaders', [])
                if subs:
                    info['passes'] = [p.get('m_State', {}) for p in subs[0].get('m_Passes', [])]
                    tags = dict(subs[0].get('m_Tags', {}).get('tags', []))
                    info['queue'] = tags.get('QUEUE') or tags.get('Queue')
            except Exception as e:
                self.log(f'  warn shader #{o.path_id}: {e}')
            self._shader[k] = info
        return self._shader[k]

    def material(self, f, o):
        """A material entry: shader name, resolved pass states, queue, keywords and the shader's declared properties —
        the material's values, the shader defaults for those it does not store (`defaults` lists their names)."""
        d = self.env.tt(o)
        sp = d.get('m_SavedProperties', {})
        floats = {k: v for k, v in sp.get('m_Floats', [])}
        ints = {k: v for k, v in sp.get('m_Ints', [])} if sp.get('m_Ints') else {}
        floats.update({k: v for k, v in ints.items() if k not in floats})
        cols = {k: c for k, c in sp.get('m_Colors', [])}
        sf, so = self.env.resolve(o.assets_file, d.get('m_Shader'))
        sh = self.shader_info(sf, so) if so is not None and sf != 'builtin' else {'name': None, 'props': None, 'passes': [], 'queue': None}
        props = sh['props']
        defaults = {n: p['default'][0] for n, p in (props or {}).items() if p['type'] in (2, 3, 5)}
        out_f, out_c, tex, filled = {}, {}, {}, []
        texenv = {k: te for k, te in sp.get('m_TexEnvs', [])}
        names = list(props) if props is not None else list(floats) + list(cols) + list(texenv)
        for name in names:
            ptype = props[name]['type'] if props is not None else (2 if name in floats else 0 if name in cols else 4)
            if ptype in (2, 3, 5):
                if name in floats:
                    out_f[name] = f6(floats[name])
                elif props is not None:
                    out_f[name] = f6(props[name]['default'][0])
                    filled.append(name)
            elif ptype in (0, 1):
                if name in cols:
                    out_c[name] = enc_color(cols[name])
                elif props is not None:
                    out_c[name] = [f6(x) for x in props[name]['default']]
                    filled.append(name)
            elif ptype == 4:
                te = texenv.get(name)
                if te is None:
                    tex[name] = {'tex': None, 'default': props[name]['texture'] if props is not None else None, 'st': [1, 1, 0, 0]}
                    filled.append(name)
                    continue
                tf, to = self.env.resolve(o.assets_file, te.get('m_Texture'))
                key = None
                if tf == 'builtin':
                    key = f'builtin:{to}'
                elif to is not None and to.type.name == 'Texture2D':
                    key = self.texture(tf, to)
                s, off = te.get('m_Scale', {}), te.get('m_Offset', {})
                tex[name] = {'tex': key, 'st': [f6(s.get('x', 1)), f6(s.get('y', 1)), f6(off.get('x', 0)), f6(off.get('y', 0))]}
                if key is None:
                    tex[name]['default'] = props[name]['texture'] if props is not None else None
        kw = d.get('m_ValidKeywords') or d.get('m_ShaderKeywords') or []
        if isinstance(kw, str):
            kw = kw.split()
        queue = d.get('m_CustomRenderQueue', -1)
        m = {
            'name': d.get('m_Name'), 'shader': sh['name'],
            'passes': [render_state(p, floats, defaults) for p in sh['passes']],
            'queue': queue if queue is not None and queue >= 0 else sh['queue'],
            'keywords': sorted(kw), 'floats': out_f, 'colors': out_c, 'textures': tex,
        }
        if filled:
            m['defaults'] = sorted(filled)
        return m

    # -- one prefab ---------------------------------------------------------------------------------------------------
    def prefab(self, key, root, bundle):
        """Write prefabs/<file>.json for the GameObject tree under `root`; returns the index entry."""
        env = self.env
        nodes, ids, comps = [], {}, {}
        order = [(root, None)]
        while order:                                          # depth first, children in Transform order
            go, parent = order.pop(0)
            nid = len(nodes)
            ids[(id(go.assets_file), go.path_id)] = nid
            gd = env.tt(go)
            nodes.append({'id': nid, 'name': gd.get('m_Name', ''), 'parent': parent, 'children': [],
                          'active': bool(gd.get('m_IsActive', 1)), '_go': go})
            if parent is not None:
                nodes[parent]['children'].append(nid)
            order[0:0] = [(k, nid) for k in go_children(env, go)]
            for c in gd.get('m_Component', []):
                cf, co = env.resolve(go.assets_file, c.get('component'))
                if co is not None and cf != 'builtin':
                    comps[(id(co.assets_file), co.path_id)] = (nid, co.type.name, co)
        ctx = PrefabCtx(self, nodes, ids, comps)
        stats = {'nodes': len(nodes), 'particleSystems': 0, 'liveParticles': 0, 'duration': 0.0, 'looping': False}
        for n in nodes:
            ctx.node(n, n.pop('_go'), stats)
        ctx.finish()
        stats['liveParticles'] = round(stats['liveParticles'])
        stats['duration'] = None if stats['looping'] else f6(stats['duration'])
        refs = set()
        for n in nodes:
            for b in n.get('behaviours', []):
                refs |= {x.lower() for x in string_values(b['fields'], set()) if x.lower() in EFFECT_KEYS and x.lower() != key}
        doc = {'format': 'fx-prefab', 'version': FORMAT_VERSION, 'key': key, 'bundle': bundle, 'root': 0,
               'nodes': nodes, 'materials': ctx.materials, 'clips': ctx.clips, 'textures': sorted(ctx.tex_used),
               'meshes': sorted(ctx.mesh_used), 'refs': sorted(refs), 'stats': stats}
        body = json.dumps(doc, ensure_ascii=False, separators=(',', ':'))
        write_atomic(self.out / 'prefabs' / f'{fx_file(key)}.json', body.encode('utf-8'))
        return {'file': f'prefabs/{fx_file(key)}.json', 'bundle': bundle, 'bytes': len(body),
                'textures': sorted(ctx.tex_used), 'meshes': sorted(ctx.mesh_used), 'refs': sorted(refs), **stats}


class PrefabCtx:
    """Per-prefab state: node / component ids, the material and clip tables, PPtr encoding."""

    def __init__(self, ex, nodes, ids, comps):
        self.ex, self.env, self.nodes, self.ids, self.comps = ex, ex.env, nodes, ids, comps
        self.materials, self._mat = [], {}
        self.clips, self._clip, self._pending = [], {}, []
        self.tex_used, self.mesh_used = set(), set()
        self._names = {}

    def pptr(self, sfile):
        """PPtr encoder for typetrees read from `sfile`: a node of this prefab ({node[, component]}), a material /
        mesh / texture / clip of the descriptor, a built-in asset, else {asset, name}; null when null or unresolvable."""
        def enc(p):
            f, o = self.env.resolve(sfile, p)
            if o is None:
                return None
            if f == 'builtin':
                return {'builtin': BUILTIN_MESHES.get(o, o)}
            k = (id(o.assets_file), o.path_id)
            t = o.type.name
            if t == 'GameObject' and k in self.ids:
                return {'node': self.ids[k]}
            if k in self.comps:
                nid, ct, _ = self.comps[k]
                return {'node': nid, 'component': ct}
            if t == 'Material':
                return {'material': self.material(f, o)}
            if t == 'Mesh':
                return {'mesh': self.mesh(f, o)}
            if t == 'Texture2D':
                key = self.ex.texture(f, o)
                if key:
                    self.tex_used.add(key)
                return {'texture': key}
            if t == 'AnimationClip':
                return {'clip': self.clip(f, o, None)}
            if t in ('MonoScript', 'Shader'):
                return None
            try:
                name = self.env.tt(o).get('m_Name')
            except Exception:
                name = None
            return {'asset': t, 'name': name}
        return enc

    def material(self, f, o):
        k = (id(o.assets_file), o.path_id)
        if k not in self._mat:
            m = self.ex.material(f, o)
            for t in m['textures'].values():
                if t['tex'] and not t['tex'].startswith('builtin:'):
                    self.tex_used.add(t['tex'])
            self._mat[k] = len(self.materials)
            self.materials.append(m)
        return self._mat[k]

    def mesh(self, f, o):
        key = self.ex.mesh(f, o)
        if key and not key.startswith('builtin:'):
            self.mesh_used.add(key)
        return key

    def materials_of(self, sfile, d):
        out = []
        for m in d.get('m_Materials', []):
            f, o = self.env.resolve(sfile, m)
            out.append(self.material(f, o) if o is not None and f != 'builtin' else None)
        return out

    def node(self, n, go, stats):
        env = self.env
        gd = env.tt(go)
        for c in gd.get('m_Component', []):
            f, o = env.resolve(go.assets_file, c.get('component'))
            if o is None or f == 'builtin':
                continue
            t = o.type.name
            try:
                d = env.tt(o)
            except Exception:
                n.setdefault('ignored', []).append(t)
                continue
            pp = self.pptr(o.assets_file)
            enc = lambda v: enc_value(v, pp)  # noqa: E731
            if t in ('Transform', 'RectTransform'):
                p, q, s = d['m_LocalPosition'], d['m_LocalRotation'], d['m_LocalScale']
                n['pos'] = [f6(p['x']), f6(p['y']), f6(p['z'])]
                n['rot'] = [f6(q['x']), f6(q['y']), f6(q['z']), f6(q['w'])]
                n['scale'] = [f6(s['x']), f6(s['y']), f6(s['z'])]
            elif t == 'ParticleSystem':
                ps = {k: enc(d[k]) for k in PS_TOP if k in d}
                for m in PS_MODULES:
                    md = d.get(m)
                    if isinstance(md, dict) and (md.get('enabled') or m == 'InitialModule'):
                        ps[m] = enc({k: v for k, v in md.items() if k != 'enabled'})
                if 'ShapeModule' in ps:
                    ps['ShapeModule']['typeName'] = enum_name(SHAPE_TYPES, ps['ShapeModule'].get('type'))
                n['particleSystem'] = ps
                stats['particleSystems'] += 1
                if n['active']:
                    stats['liveParticles'] += est_live(ps)
                if ps.get('looping'):
                    stats['looping'] = True
                im = ps.get('InitialModule', {})
                life = im.get('startLifetime', 0)
                life = life if isinstance(life, (int, float)) else (life.get('max') if isinstance(life, dict) and 'max' in life
                                                                    else abs((life or {}).get('scalar') or 1))
                delay = ps.get('startDelay', 0)
                delay = delay if isinstance(delay, (int, float)) else ((delay or {}).get('max') or 0)
                stats['duration'] = max(stats['duration'], (delay or 0) + (ps.get('lengthInSec') or 0) + (life or 0))
            elif t == 'ParticleSystemRenderer':
                r = {k: enc(d[k]) for k in RENDERER_COMMON + PSR_FIELDS if k in d}
                r['renderMode'] = enum_name(RENDER_MODES, d.get('m_RenderMode'))
                r['renderAlignment'] = enum_name(RENDER_ALIGN, d.get('m_RenderAlignment'))
                r['vertexStreams'] = [enum_name(VERTEX_STREAMS, v) for v in d.get('m_VertexStreams', [])]
                r['materials'] = self.materials_of(o.assets_file, d)
                n['particleSystemRenderer'] = r
            elif t in ('MeshRenderer', 'TrailRenderer', 'LineRenderer', 'SkinnedMeshRenderer', 'SpriteRenderer'):
                fields = {'TrailRenderer': TRAIL_FIELDS, 'LineRenderer': LINE_FIELDS, 'SkinnedMeshRenderer': SKIN_FIELDS}.get(t, ())
                r = {k: enc(d[k]) for k in RENDERER_COMMON + fields if k in d}
                r['materials'] = self.materials_of(o.assets_file, d)
                n[t[0].lower() + t[1:]] = r
            elif t == 'MeshFilter':
                mf, mo = env.resolve(o.assets_file, d.get('m_Mesh'))
                n['meshFilter'] = self.mesh(mf, mo) if mo is not None else None
            elif t == 'Animator':
                cf, co = env.resolve(o.assets_file, d.get('m_Controller'))
                clips, cname = [], None
                if co is not None and cf != 'builtin':
                    cd = env.tt(co)
                    cname = cd.get('m_Name')
                    for cp in cd.get('m_AnimationClips', []):
                        kf, ko = env.resolve(co.assets_file, cp)
                        if ko is not None and kf != 'builtin':
                            clips.append(self.clip(kf, ko, n['id']))
                n['animator'] = {'controller': cname, 'clips': clips, 'default': clips[0] if clips else None,
                                 'enabled': bool(d.get('m_Enabled', 1)), 'cullingMode': d.get('m_CullingMode'),
                                 'updateMode': d.get('m_UpdateMode')}
            elif t == 'Animation':
                clips = []
                for cp in d.get('m_Animations', []):
                    kf, ko = env.resolve(o.assets_file, cp)
                    if ko is not None and kf != 'builtin':
                        clips.append(self.clip(kf, ko, n['id']))
                df, do = env.resolve(o.assets_file, d.get('m_Animation'))
                default = self.clip(df, do, n['id']) if do is not None and df != 'builtin' else (clips[0] if clips else None)
                n['animation'] = {'clips': clips, 'default': default, 'playAutomatically': bool(d.get('m_PlayAutomatically', 1)),
                                  'wrapMode': d.get('m_WrapMode', 0), 'enabled': bool(d.get('m_Enabled', 1))}
            elif t == 'MonoBehaviour':
                ns, cls = env.script(o)
                fields = {k: enc(v) for k, v in d.items() if k not in SKIP_FIELDS}
                n.setdefault('behaviours', []).append({'class': cls, 'namespace': ns, 'enabled': bool(d.get('m_Enabled', 1)),
                                                       'fields': fields})
            elif t == 'GameObject':
                continue
            else:
                n.setdefault('ignored', []).append(t)

    # -- clips --------------------------------------------------------------------------------------------------------
    def clip(self, f, o, owner):
        """Index of the clip in this descriptor (decoded in finish(), once every node and material is known); its
        curve paths resolve against node `owner`, the GameObject of the Animator / Animation that plays it."""
        k = (id(o.assets_file), o.path_id, owner)
        if k not in self._clip:
            self._clip[k] = len(self.clips)
            self.clips.append(None)
            self._pending.append((self._clip[k], o, owner))
        return self._clip[k]

    def finish(self):
        for i, o, owner in self._pending:
            try:
                self.clips[i] = self.decode_clip(o, owner)
            except Exception as e:
                self.ex.log(f'  warn clip #{o.path_id}: {e!r}')
                self.clips[i] = {'name': None, 'error': str(e)[:200], 'curves': []}
        self._pending = []

    def _paths(self, owner):
        """Relative path (from node `owner`) → node id, for every node under it ('' = the owner itself)."""
        out = {}
        if owner is None:
            return out
        def walk(nid, path):
            out[path] = nid
            for ch in self.nodes[nid]['children']:
                walk(ch, f'{path}/{self.nodes[ch]["name"]}' if path else self.nodes[ch]['name'])
        walk(owner, '')
        return out

    def _component(self, nid, type_name):
        for n, t, o in self.comps.values():
            if n == nid and t == type_name:
                return o
        return None

    def _generic_names(self, nid, type_id):
        """(CRC32 → dotted field path, CRC32 & 0x0FFFFFFF → path) of the component a generic binding targets."""
        t = CLASS_IDS.get(type_id)
        o = self._component(nid, t) if nid is not None and t else None
        if o is None:
            return {}, {}
        k = (nid, t)
        if k not in self._names:
            paths = typetree_paths(self.env.tt(o))
            exact = {zlib.crc32(p.encode()): p for p in paths}
            self._names[k] = (exact, {c & 0x0FFFFFFF: p for c, p in exact.items()})
        return self._names[k]

    def _material_names(self, nid):
        """CRC32 & 0x0FFFFFFF → property name, for the materials of the renderers on node `nid` (plus common ones)."""
        names = {'_TintColor', '_MainColor', '_Color', '_MainTex_ST', '_Amount', '_DissolveTex_ST', '_DisturTex_ST',
                 '_DisturbTex_ST', '_Opacity', '_BorderWidth', '_IntensityU', '_IntensityV', '_Amount_01', '_Amount_02'}
        node = self.nodes[nid] if nid is not None else {}
        for key in ('meshRenderer', 'particleSystemRenderer', 'trailRenderer', 'lineRenderer', 'skinnedMeshRenderer'):
            for mi in (node.get(key) or {}).get('materials', []) or []:
                if mi is not None:
                    m = self.materials[mi]
                    names.update(m['floats'])
                    names.update(m['colors'])
                    names.update(f'{t}_ST' for t in m['textures'])
        return {zlib.crc32(n.encode()) & 0x0FFFFFFF: n for n in names}

    def decode_clip(self, o, owner):
        d = self.env.tt(o)
        paths = self._paths(owner)
        by_hash = {zlib.crc32(p.encode()): (p, n) for p, n in paths.items()}
        clip = {'name': d.get('m_Name'), 'legacy': bool(d.get('m_Legacy')), 'sampleRate': f6(d.get('m_SampleRate', 30)),
                'wrapMode': d.get('m_WrapMode', 0),
                'events': [{'time': f6(e.get('time')), 'function': e.get('functionName'), 'data': e.get('data'),
                            'float': f6(e.get('floatParameter')), 'int': e.get('intParameter')} for e in d.get('m_Events', [])],
                'curves': []}
        if d.get('m_Legacy'):
            self._legacy_curves(d, paths, clip)
            ends = [c['keys'][-1][0] for c in clip['curves'] if c['keys']] or [0]
            clip['length'] = f6(max(ends))
            clip['start'] = 0
            clip['loop'] = d.get('m_WrapMode', 0) == 2
            return clip
        mc = d.get('m_MuscleClip', {})
        clip['length'] = f6(mc.get('m_StopTime', 0) - mc.get('m_StartTime', 0))
        clip['start'] = f6(mc.get('m_StartTime', 0))
        clip['loop'] = bool(mc.get('m_LoopTime'))
        data = mc.get('m_Clip', {}).get('data', {})
        streamed = data.get('m_StreamedClip', {})
        dense = data.get('m_DenseClip', {})
        const = data.get('m_ConstantClip', {}).get('data', []) or []
        n_s = streamed.get('curveCount', 0)
        n_d = dense.get('m_CurveCount', 0)
        curves = streamed_curves(decode_streamed(streamed.get('data', []) or []))
        curves.update(dense_curves(dense, n_s))
        for i, v in enumerate(const):
            curves[n_s + n_d + i] = [[clip['start'], f6(v), 0, 0]]
        idx = 0
        for b in d.get('m_ClipBindingConstant', {}).get('genericBindings', []):
            dims = binding_dims(b)
            path, nid = by_hash.get(b.get('path'), (None, None))
            base = {'node': nid, 'path': path, 'type': CLASS_IDS.get(b.get('typeID'), str(b.get('typeID')))}
            if path is None:
                base['pathHash'] = b.get('path')
            if b.get('typeID') == 4 and b.get('attribute') in TRANSFORM_PROPS:
                prop, comps = TRANSFORM_PROPS[b['attribute']]
                for j, comp in enumerate(comps):
                    clip['curves'].append({**base, 'property': f'{prop}.{comp}', 'keys': curves.get(idx + j, [])})
            else:
                attr = b.get('attribute', 0)
                if b.get('typeID') == 1:
                    prop = 'm_IsActive' if attr == zlib.crc32(b'm_IsActive') else f'crc:{attr}'
                elif b.get('customType') == 22:
                    h, comp = material_attribute(attr)
                    name = self._material_names(nid).get(h)
                    prop = f'material.{name or f"crc:{h}"}' + (f'.{comp}' if comp else '')
                else:
                    exact, masked = self._generic_names(nid, b.get('typeID'))
                    prop = exact.get(attr) or masked.get(attr & 0x0FFFFFFF) or f'crc:{attr}'
                cur = {**base, 'property': prop, 'keys': curves.get(idx, [])}
                if b.get('customType'):
                    cur['customType'] = b.get('customType')
                if b.get('isPPtrCurve'):
                    cur['pptr'] = True
                clip['curves'].append(cur)
            idx += dims
        return clip

    def _legacy_curves(self, d, paths, clip):
        def vec_curves(key, prop, comps):
            for c in d.get(key, []) or []:
                path = c.get('path', '')
                for comp in comps:
                    rows = []
                    for kf in c.get('curve', {}).get('m_Curve', []):
                        val, ins, outs = kf.get('value', {}), kf.get('inSlope', {}), kf.get('outSlope', {})
                        rows.append([f6(kf.get('time', 0)), f6(val.get(comp, 0)), f6(ins.get(comp, 0)), f6(outs.get(comp, 0))])
                    clip['curves'].append({'node': paths.get(path), 'path': path, 'type': 'Transform',
                                           'property': f'{prop}.{comp}', 'keys': rows})
        vec_curves('m_PositionCurves', 'localPosition', 'xyz')
        vec_curves('m_RotationCurves', 'localRotation', 'xyzw')
        vec_curves('m_EulerCurves', 'localEulerAnglesRaw', 'xyz')
        vec_curves('m_ScaleCurves', 'localScale', 'xyz')
        for c in d.get('m_FloatCurves', []) or []:
            path = c.get('path', '')
            clip['curves'].append({'node': paths.get(path), 'path': path,
                                   'type': CLASS_IDS.get(c.get('classID'), str(c.get('classID'))),
                                   'property': c.get('attribute'), 'keys': enc_keys(c.get('curve'))})


def save_webp(img, path):
    import io
    buf = io.BytesIO()
    img.save(buf, 'WEBP', quality=WEBP_QUALITY, method=WEBP_METHOD)
    write_atomic(path, buf.getvalue())


def write_atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f'.{path.name}.{os.getpid()}.tmp')
    tmp.write_bytes(data)
    os.replace(tmp, path)


# ---- container indexes ----------------------------------------------------------------------------------------------

def _containers(args):
    """(rel, size, mtime, [prefab names]) of one bundle (pool worker)."""
    ab_root, rel = args
    import aklz4  # noqa: F401
    import UnityPy
    p = Path(ab_root) / rel
    st = p.stat()
    try:
        env = UnityPy.load(str(p))
        names = sorted({k.split('/')[-1][:-len('.prefab')] for k in env.container.keys() if k.endswith('.prefab')})
    except Exception:
        names = []
    return rel, st.st_size, int(st.st_mtime), names


def container_index(ab_root, globs, cache_file, jobs, log):
    """prefab name → bundle rel path over every bundle matching `globs` (cached per bundle by size + mtime)."""
    try:
        cache = json.loads(Path(cache_file).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        cache = {}
    rels = sorted({p.relative_to(ab_root).as_posix() for g in globs for p in Path(ab_root).glob(g) if p.is_file()})
    todo = []
    for rel in rels:
        st = (Path(ab_root) / rel).stat()
        c = cache.get(rel)
        if not c or c.get('size') != st.st_size or c.get('mtime') != int(st.st_mtime):
            todo.append((str(ab_root), rel))
    if todo:
        t0 = time.time()
        if jobs > 1 and len(todo) > 4:
            with ProcessPoolExecutor(max_workers=jobs) as pool:
                results = list(pool.map(_containers, todo, chunksize=4))
        else:
            results = [_containers(a) for a in todo]
        for rel, size, mtime, names in results:
            cache[rel] = {'size': size, 'mtime': mtime, 'prefabs': names}
        log(f'  container index: {len(todo)} bundles read in {time.time() - t0:.1f}s')
        Path(cache_file).parent.mkdir(parents=True, exist_ok=True)
        Path(cache_file).write_text(json.dumps({r: cache[r] for r in rels if r in cache}), encoding='utf-8')
    out = {}
    for rel in rels:
        for n in cache.get(rel, {}).get('prefabs', []):
            out.setdefault(n, rel)
    return out


# ---- units: operators, enemies, tokens (index.json) -------------------------------------------------------------------

def emitter_lists(fields):
    """The effect lists of an UberEffectEmitter, keyed cast / hit / attach / inputTarget / castTarget; each entry keeps
    its fields without the leading underscore and the non-empty `effects`."""
    out = {}
    for src, dst in (('_castEffects', 'cast'), ('_hitEffects', 'hit'), ('_attachEffects', 'attach'),
                     ('_inputTargetEffects', 'inputTarget'), ('_castTargetEffects', 'castTarget')):
        rows = []
        for e in fields.get(src, []) or []:
            if not isinstance(e, dict):
                continue
            row = {k.lstrip('_'): v for k, v in e.items()}
            row['effects'] = [x for x in row.get('effects', []) if x]
            if row['effects']:
                rows.append(row)
        if rows:
            out[dst] = rows
    return out


def parse_unit(env, rel, name, kind):
    """Attack modes, start / dead effects, the Graphic transform and every string of a unit prefab (charpack / enemy /
    token); None when the bundle has no prefab `name`."""
    root = env.prefabs(rel).get(name)
    if root is None:
        return None
    unit = {'kind': kind, 'prefab': rel, 'rootClass': None, 'modes': [], 'startEffect': None, 'deadEffect': None, 'graphic': None}
    strings, mbs = set(), []
    stack = [(root, '')]
    while stack:
        go, path = stack.pop()
        gd = env.tt(go)
        if gd.get('m_Name') == 'Graphic' and unit['graphic'] is None:
            p, q, s = go_transform(env, go)
            unit['graphic'] = {'path': path + 'Graphic', 'pos': [f6(x) for x in p], 'rot': [f6(x) for x in q], 'scale': [f6(x) for x in s]}
        for c in gd.get('m_Component', []):
            f, o = env.resolve(go.assets_file, c.get('component'))
            if o is None or f == 'builtin' or o.type.name != 'MonoBehaviour':
                continue
            try:
                d = env.tt(o)
            except Exception:
                continue
            mbs.append((o, d, go))
            all_strings({k: v for k, v in d.items() if k != 'm_Name'}, strings)
        for k in go_children(env, go):
            stack.append((k, '' if go is root else f'{path}{gd.get("m_Name")}/'))
    head = next(((o, d) for o, d, go in mbs if go is root and '_modes' in d), None)
    if head:
        ho, hd = head
        unit['rootClass'] = env.script(ho)[1]
        unit['startEffect'] = hd.get('_startEffect') or None
        unit['deadEffect'] = hd.get('_deadEffect') or None
        for mp in hd.get('_modes', []):
            f, mo = env.resolve(ho.assets_file, mp)
            if mo is None or f == 'builtin':
                continue
            md = env.tt(mo)
            mgo = env.resolve(mo.assets_file, md.get('m_GameObject'))[1]
            mode = {'name': env.tt(mgo).get('m_Name') if mgo is not None else None,
                    'overrideStartEffect': md.get('_overrideStartEffect') or None,
                    'overrideDeadEffect': md.get('_overrideDeadEffect') or None, 'attack': None}
            af, ao = env.resolve(mo.assets_file, md.get('_attack'))
            if ao is not None and af != 'builtin':
                ad = env.tt(ao)
                attack = {'class': env.script(ao)[1]}
                for k in ('_animKey', '_attackType', '_damageType', '_projectileKey', '_extraProjectileKeys', '_projectileDestination'):
                    if k in ad:
                        attack[k.lstrip('_')] = ad[k]
                ago = env.resolve(ao.assets_file, ad.get('m_GameObject'))[1]
                if ago is not None:
                    for o, d, go in mbs:
                        if go.path_id == ago.path_id and go.assets_file is ago.assets_file and env.script(o)[1] == 'UberEffectEmitter':
                            attack.update(emitter_lists(d))
                mode['attack'] = attack
            unit['modes'].append(mode)
    unit['_strings'] = strings
    return unit


def skin_points(env, rel, prefab, graphic, container=None):
    """Mount points under a skin root (an operator's chararts defaultskin, placed under the charpack's Graphic) or
    under a unit prefab (an enemy / token: its own Graphic subtree): name → {facing ('front' | 'back' | 'all'):
    {pos (unit-root frame, Unity units and axes), bone (BoneFollower bone or null), path}}."""
    prefabs = env.prefabs(rel, full=container is not None)
    root = None
    if container is not None:
        root = next((o for p, o in prefabs.items() if p.endswith(container)), None)
    else:
        root = prefabs.get(prefab)
    if root is None:
        return None
    base = trs_matrix(graphic['pos'], graphic['rot'], graphic['scale']) if graphic else trs_matrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1])
    points = {}

    def walk(go, m, facing, path):
        gd = env.tt(go)
        name = gd.get('m_Name', '')
        m2 = mat_mul(m, trs_matrix(*go_transform(env, go)))
        f2 = 'front' if name == 'Front' else 'back' if name == 'Back' else facing
        bone = None
        for c in gd.get('m_Component', []):
            cf, co = env.resolve(go.assets_file, c.get('component'))
            if co is not None and cf != 'builtin' and co.type.name == 'MonoBehaviour' and env.script(co)[1] == 'BoneFollower':
                bone = env.tt(co).get('boneName') or None
        if go is not root and MOUNT_NAME.search(name):
            points.setdefault(name, {})[f2 or 'all'] = {'pos': mat_point(m2), 'bone': bone, 'path': path + name}
        for k in go_children(env, go):
            walk(k, m2, f2, '' if go is root else f'{path}{name}/')
    walk(root, base, None, '')
    return points


def crawl_units(ab_root, cabs, unit_ids, gd, eff, enemy_idx, token_idx, log):
    """index.json's units / projectiles / skills / skins for `unit_ids`, and every effect key they reference."""
    units, projectiles, skills, skins, referenced = {}, {}, {}, {}, set()
    shared = AssetEnv(ab_root, cabs)                           # [uc]projectiles.ab and [uc]skills.ab, loaded once
    proj_roots = shared.prefabs(PROJECTILES)
    skill_roots = shared.prefabs(SKILLS)
    # effect / projectile / skill keys are case-insensitive: the client's references mix cases ('…_buff_02_B'), the
    # bundles' containers (and so the files, the manifest and this index) use the lower-case names
    effect_refs = lambda strings: sorted({x.lower() for x in strings if x.lower() in eff})  # noqa: E731
    ek = lambda x: x.lower() if isinstance(x, str) and x.lower() in eff else x  # noqa: E731
    pk = lambda x: x.lower() if isinstance(x, str) and x.lower() in proj_roots else None  # noqa: E731
    lists = (('_effectsWhenStart', 'onStart'), ('_effectsWhenReached', 'onReached'), ('_effectsWhenHit', 'onHit'),
             ('_effectsWhenStop', 'onStop'), ('_effectsToTargetWhenStart', 'toTargetOnStart'),
             ('_effectsToTileWhenStart', 'toTileOnStart'), ('_effectOnTrigger', 'onTrigger'), ('_effectsWhenSelect', 'onSelect'))

    def projectile(key, depth=0):
        key = pk(key)
        if key is None or key in projectiles or depth > 3:
            return
        entry = {'main': None, 'lifeTime': None, 'movement': None, 'behaviours': []}
        projectiles[key] = entry
        strings, stack = set(), [proj_roots[key]]
        while stack:
            go = stack.pop()
            gdd = shared.tt(go)
            for c in gdd.get('m_Component', []):
                f, o = shared.resolve(go.assets_file, c.get('component'))
                if o is None or f == 'builtin' or o.type.name != 'MonoBehaviour':
                    continue
                d = shared.tt(o)
                cls = shared.script(o)[1]
                fields = {k: enc_value(v, lambda p: None) for k, v in d.items() if k not in SKIP_FIELDS and not is_pptr(v)}
                entry['behaviours'].append({'class': cls, 'node': gdd.get('m_Name'), 'fields': fields})
                all_strings({k: v for k, v in d.items() if k != 'm_Name'}, strings)
                if '_mainEffect' in d:
                    entry['main'] = ek(d.get('_mainEffect')) or entry['main']
                    entry['lifeTime'] = f6(d.get('_lifeTime'))
                if cls.endswith('Movement') and entry['movement'] is None:
                    entry['movement'] = {'class': cls, **{k.lstrip('_'): v for k, v in fields.items()}}
                for src, dst in lists:
                    vals = [ek(x) for x in (d.get(src) or []) if isinstance(x, str) and x]
                    if vals:
                        entry.setdefault(dst, []).extend(vals)
            stack.extend(go_children(shared, go))
        entry['effects'] = effect_refs(strings)
        entry['projectiles'] = sorted({pk(x) for x in strings if pk(x) and pk(x) != key})
        for p in entry['projectiles']:
            projectile(p, depth + 1)

    def skill(sid):
        if sid in skills or sid not in skill_roots:
            return
        strings, stack = set(), [skill_roots[sid]]
        while stack:
            go = stack.pop()
            for c in shared.tt(go).get('m_Component', []):
                f, o = shared.resolve(go.assets_file, c.get('component'))
                if o is not None and f != 'builtin' and o.type.name == 'MonoBehaviour':
                    all_strings({k: v for k, v in shared.tt(o).items() if k != 'm_Name'}, strings)
            stack.extend(go_children(shared, go))
        projs = sorted({pk(x) for x in strings if pk(x)})
        for p in projs:
            projectile(p)
        skills[sid] = {'effects': effect_refs(strings), 'projectiles': projs}

    for uid in unit_ids:
        env = AssetEnv(ab_root, cabs)                          # one environment per unit: chararts are large
        try:
            if uid.startswith('char_'):
                rel = f'charpack/{uid}.ab'
                u = parse_unit(env, rel, uid, 'char') if (Path(ab_root) / rel).exists() else None
            elif uid.startswith('enemy_'):
                rel = enemy_idx.get(uid)
                u = parse_unit(env, rel, uid, 'enemy') if rel else None
            else:
                rel = token_idx.get(uid)
                u = parse_unit(env, rel, uid, 'token') if rel else None
            if u is None:
                log(f'  skip (no prefab) {uid}')
                continue
            strings = u.pop('_strings')
            for x in ('startEffect', 'deadEffect'):
                u[x] = ek(u[x]) if u[x] else None
            for m in u['modes']:
                for x in ('overrideStartEffect', 'overrideDeadEffect'):
                    m[x] = ek(m[x]) if m[x] else None
                a = m.get('attack') or {}
                if a.get('projectileKey'):
                    a['projectileKey'] = pk(a['projectileKey']) or a['projectileKey']
                for lst in ('cast', 'hit', 'attach', 'inputTarget', 'castTarget'):
                    for e in a.get(lst, []):
                        e['effects'] = [ek(x) for x in e['effects']]
            for x in sorted(strings):
                if pk(x):
                    projectile(x)
            code = uid.split('_', 2)[2] if uid.startswith('char_') else None
            sids = set(gd['skills'].get(uid, []))
            if code:
                sids |= {k for k in skill_roots if k.startswith(f'skchr_{code}_')}
            for sid in sorted(sids):
                skill(sid)
            u['skills'] = {sid: skills[sid] for sid in sorted(sids) if sid in skills}
            u['projectiles'] = sorted({pk(x) for x in strings if pk(x) in projectiles})
            refs = set(effect_refs(strings))
            for p in u['projectiles']:
                refs.update(projectiles[p]['effects'])
            for s in u['skills'].values():
                refs.update(s['effects'])
                for p in s['projectiles']:
                    refs.update(projectiles.get(p, {}).get('effects', []))
            u['refs'] = sorted(refs)
            referenced |= refs
            if uid.startswith('char_'):
                arts = f'chararts/{uid}.ab'
                pts = skin_points(env, arts, 'defaultskin', u.get('graphic'), container=f'/{uid}/defaultskin.prefab') \
                    if (Path(ab_root) / arts).exists() else None
                src = f'{arts} defaultskin'
            else:
                pts, src = skin_points(env, rel, uid, None), f'{rel} {uid}'
            if pts:
                skins[uid] = {'source': src, 'graphic': u.get('graphic'), 'points': pts}
                u['skin'] = uid
            units[uid] = u
        except Exception as e:
            log(f'  FAIL unit {uid}: {e!r}')
    for p in projectiles.values():
        referenced.update(p['effects'])
    return units, projectiles, skills, skins, referenced


# ---- the run ----------------------------------------------------------------------------------------------------------

def _export_worker(args, keys_all=None):
    """Export the prefabs `keys` of bundle `rel` (pool worker, or in-process with `keys_all`, every effect key):
    (entries, textures meta, meshes meta, log lines)."""
    if keys_all is not None:
        _init_worker(keys_all)
    ab_root, out_root, cabs, rel, keys = args
    lines = []
    env = AssetEnv(ab_root, cabs)
    ex = Exporter(env, out_root, lines.append)
    entries = {}
    try:
        roots = env.prefabs(rel)
        for k in keys:
            root = roots.get(k)
            if root is None:
                lines.append(f'  skip (not in {rel}) {k}')
                continue
            try:
                entries[k] = ex.prefab(k, root, rel)
            except Exception as e:
                lines.append(f'  FAIL {k}: {e!r}')
    except Exception as e:
        lines.append(f'  FAIL load {rel}: {e!r}')
    return entries, ex.textures, ex.meshes, lines


def game_data(root):
    """Operator ids (chess.json + backups.json units), the chess skill prefab ids per operator, enemy keys, token ids."""
    data = Path(root) / 'data'
    def load(n):
        try:
            return json.loads((data / n).read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return {}
    chess, backups, enemies, tokens = load('chess.json'), load('backups.json'), load('enemies.json'), load('tokens.json')
    chars, skills = [], {}
    for v in chess.values():
        cid = v.get('charId')
        if not cid:
            continue
        if cid not in chars:
            chars.append(cid)
        for s in [v.get('skill')] + list(v.get('skills') or []):
            if isinstance(s, dict) and (s.get('prefabId') or s.get('skillId')):
                skills.setdefault(cid, set()).add(s.get('prefabId') or s.get('skillId'))
    for cid in (backups.get('units') or {}):
        if cid not in chars:
            chars.append(cid)
    toks = sorted(set(tokens) | set(backups.get('tokens') or {}))
    return {'chars': chars, 'skills': {k: sorted(v) for k, v in skills.items()}, 'enemies': sorted(enemies), 'tokens': toks}


def client_version(ab_root):
    try:
        return json.loads((Path(ab_root) / 'hot_update_list.json').read_text(encoding='utf-8')).get('versionId')
    except (OSError, ValueError):
        return None


def export_fx(ab_root, out_root, manifest, log, selection='sample', keys=None, jobs=None, root=None):
    """The fx run (extract.py --only fx): fills the manifest groups fx, fx/prefabs, fx/tex and fx/mesh; returns the
    number of files written."""
    t_start = time.time()
    ab_root = Path(ab_root)
    root = Path(root) if root else Path(__file__).resolve().parents[2]
    jobs = max(1, jobs or min(8, os.cpu_count() or 2))
    out = Path(out_root) / FX_SUB
    out.mkdir(parents=True, exist_ok=True)
    timings = {}

    t0 = time.time()
    cabs = scan_cabs(ab_root)
    eff = container_index(ab_root, EFFECT_GLOBS, root / '.cache/fx/effects.json', jobs, log)
    timings['index'] = time.time() - t0
    log(f'fx: {len(eff)} effect prefabs in the client ({client_version(ab_root)}), {len(cabs)} bundle CABs scanned')

    t0 = time.time()
    gd = game_data(root)
    if keys:
        unit_ids = []
    elif selection == 'sample':
        unit_ids = list(FX_SAMPLE_UNITS)
    else:
        unit_ids = gd['chars'] + gd['enemies'] + gd['tokens']
    enemy_idx = container_index(ab_root, (ENEMY_GLOB,), root / '.cache/fx/enemies.json', jobs, log) \
        if any(u.startswith('enemy_') for u in unit_ids) else {}
    token_idx = container_index(ab_root, (TOKEN_GLOB,), root / '.cache/fx/tokens.json', jobs, log) \
        if any(not u.startswith(('char_', 'enemy_')) for u in unit_ids) else {}
    units, projectiles, skills, skins, referenced = crawl_units(ab_root, cabs, unit_ids, gd, eff, enemy_idx, token_idx, log)
    timings['units'] = time.time() - t0

    generic = {v for group in FX_GENERIC.values() for v in group.values()}
    generic |= {k for k, rel in eff.items() if rel in FX_GENERIC_BUNDLES}
    if keys:
        wanted = set(keys)
    elif selection == 'sample':
        wanted = set(FX_SAMPLE_KEYS) | set(FX_COVERAGE_KEYS) | referenced | generic
    else:
        wanted = referenced | generic
    missing = sorted(k for k in wanted if k not in eff)
    for k in missing:
        log(f'  skip (no such effect prefab in this client) {k}')
    wanted -= set(missing)

    # -- descriptors, textures, meshes; then the keys the exported behaviours name (variants by facing, chained
    #    effects), until nothing new is named
    t0 = time.time()
    entries, textures, meshes, done = {}, {}, {}, set()
    todo, rounds = set(wanted), 0
    with ProcessPoolExecutor(max_workers=jobs, initializer=_init_worker, initargs=(tuple(eff),)) as pool:
        while todo and rounds < 6:
            rounds += 1
            by_bundle = {}
            for k in sorted(todo):
                by_bundle.setdefault(eff[k], []).append(k)
            log(f'fx: pass {rounds}: exporting {len(todo)} prefabs from {len(by_bundle)} bundles ({jobs} processes)')
            work = [(str(ab_root), str(out_root), cabs, rel, ks) for rel, ks in sorted(by_bundle.items(), key=lambda kv: -len(kv[1]))]
            results = list(pool.map(_export_worker, work)) if jobs > 1 and len(work) > 1 else [_export_worker(w, tuple(eff)) for w in work]
            done |= todo
            for e, tx, me, lines in results:
                entries.update(e)
                textures.update(tx)
                meshes.update(me)
                for line in lines:
                    log(line)
            named = {r for e in entries.values() for r in e.get('refs', [])}
            todo = {k for k in named if k in eff and k not in done}
    timings['prefabs'] = time.time() - t0

    index = {
        'format': 'fx-index', 'version': FORMAT_VERSION, 'set': 'keys' if keys else selection,
        'source': {'root': ab_root.name, 'client': client_version(ab_root)},
        'units': units, 'projectiles': projectiles, 'skills': skills, 'skins': skins,
        'generic': {**FX_GENERIC, 'keys': sorted(k for k in generic if k in entries)},
        'prefabs': {k: {f: v[f] for f in ('file', 'bundle', 'nodes', 'particleSystems', 'liveParticles', 'duration', 'looping', 'refs')}
                    for k, v in sorted(entries.items())},
    }
    write_atomic(out / 'index.json', json.dumps(index, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    write_atomic(out / 'textures.json', json.dumps({'format': 'fx-textures', 'version': FORMAT_VERSION,
                                                   'textures': dict(sorted(textures.items()))}, separators=(',', ':')).encode('utf-8'))
    url = lambda rel: f'/assets/local/{FX_SUB}/{rel}'  # noqa: E731
    manifest['fx'] = {'index': {'path': url('index.json'), 'kind': 'FxIndex', 'version': FORMAT_VERSION, 'set': index['set'],
                                'prefabs': len(entries)},
                      'textures': {'path': url('textures.json'), 'kind': 'FxTextures', 'count': len(textures)}}
    manifest['fx/prefabs'] = {k: {'path': url(v['file']), 'kind': 'FxPrefab'} for k, v in sorted(entries.items())}
    manifest['fx/tex'] = {k: {'path': url(v['file']), 'w': v['w'], 'h': v['h'], 'kind': 'Texture2D',
                              **({'half': url(v['half'])} if v.get('half') else {})} for k, v in sorted(textures.items())}
    manifest['fx/mesh'] = {k: {'path': url(v['file']), 'kind': 'FxMesh', 'verts': v['verts']} for k, v in sorted(meshes.items())}
    total = 2 + len(entries) + len(meshes) + sum(1 + (1 if v.get('half') else 0) for v in textures.values())
    if not keys:                                              # a full set: drop files an earlier run left behind
        keep = {out / 'index.json', out / 'textures.json'} | {out / v['file'] for v in entries.values()}
        keep |= {out / v['file'] for v in meshes.values()} | {out / v['file'] for v in textures.values()}
        keep |= {out / v['half'] for v in textures.values() if v.get('half')}
        stale = [q for d in ('prefabs', 'tex', 'mesh') for q in (out / d).rglob('*') if q.is_file() and q not in keep]
        for q in stale:
            q.unlink()
        if stale:
            log(f'  removed {len(stale)} files of an earlier run')
    timings['total'] = time.time() - t_start
    size = sum(p.stat().st_size for p in out.rglob('*') if p.is_file() and not p.name.startswith('.'))
    log(f'fx: {len(entries)} prefabs, {len(textures)} textures, {len(meshes)} meshes, {len(units)} units, '
        f'{len(projectiles)} projectiles, {len(skills)} skills → {out} ({size / 1e6:.1f} MB); '
        + ', '.join(f'{k} {v:.1f}s' for k, v in timings.items()))
    return total


if __name__ == '__main__':
    print('run through tools/local-extract/extract.py --only fx (see the module docstring)', file=sys.stderr)
    sys.exit(2)
