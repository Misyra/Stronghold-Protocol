// test/render/vfx-pivot.test.js — a ParticleSystemRenderer's m_Pivot moves the drawn quad by +pivot·size along its axes
// (feedback #29, 2026-10-17: 野鬃's S2 thrust, pivot.x 1, was drawn behind her; every pivoted renderer was mirrored)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileEffect, Effect } from '../../public/js/render/vfx/effect.js';
import { FrameData, cameraBasis } from '../../public/js/render/vfx/geom.js';

const MAT = {
  name: 'm', shader: 'Torappu/Particles/Additive', passes: [{ blend: ['SrcAlpha', 'One', 'Zero', 'OneMinusSrcAlpha'], blendOp: 'Add', zTest: 'Disabled', zWrite: false, cull: 'Off', colorMask: 15 }],
  queue: 'Transparent', keywords: [], floats: {}, colors: { _TintColor: [1, 1, 1, 1] }, textures: { _MainTex: { tex: 't', st: [1, 1, 0, 0] } },
};

function quadOf(pivot, align) {
  const nodes = [
    { id: 0, name: 'root', parent: null, children: [1], active: true, pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1],
      behaviours: [{ class: 'ParticleEffect', enabled: true, fields: { _delayToPlay: 0, _delayToFinish: 0, _maxLifetime: -1, _isLoop: 0, _rotateType: 0, _spawnLocation: 2, _inactiveOnFinish: [] } }] },
    { id: 1, name: 'ps1', parent: 0, children: [], active: true, pos: [0, 0, 0], rot: [0, 0, 0, 1], scale: [1, 1, 1], behaviours: [],
      particleSystem: { lengthInSec: 0.5, looping: false, prewarm: false, startDelay: 0, playOnAwake: true, simulationSpeed: 1, moveWithTransform: 0, scalingMode: 1,
        InitialModule: { startLifetime: 1, startSpeed: 0, startSize: 2, startColor: [1, 1, 1, 1], maxNumParticles: 10 },
        EmissionModule: { rateOverTime: 0, m_Bursts: [{ time: 0, countCurve: 1, cycleCount: 1, repeatInterval: 0.01, probability: 1 }] } },
      particleSystemRenderer: { m_Enabled: true, renderMode: 'billboard', renderAlignment: align, materials: [0], m_SortingOrder: 0, m_MaxParticleSize: 0, ...(pivot ? { m_Pivot: pivot } : {}) } },
  ];
  const fx = new Effect(compileEffect({ format: 'fx-prefab', version: 1, key: 'test', nodes, materials: [MAT], clips: [], textures: ['t'], meshes: [], refs: [], stats: {} }), { seed: 1 });
  fx.update(1 / 30);
  const fd = new FrameData();
  fx.collect(cameraBasis(30, [0, -5, -8], 720, 0.7), fd, () => {}, 1);
  assert.equal(fd.nq, 1);
  const b = fd.quad;
  return { c: [b[0], b[1], b[2]], ax: [b[3], b[4], b[5]], ay: [b[6], b[7], b[8]] };
}

for (const align of ['world', 'view']) {
  test(`${align} billboard: the centre moves by +pivot.x·ax + pivot.y·ay`, () => {
    const base = quadOf(null, align), q = quadOf([1, 0.5, 0], align);
    for (let k = 0; k < 3; k++) {
      const want = base.c[k] + q.ax[k] * 1 + q.ay[k] * 0.5;
      assert.ok(Math.abs(q.c[k] - want) < 1e-5, `axis ${k}: ${q.c[k]} vs ${want}`);
    }
    // ahead along x, not behind (the old sign)
    const d = q.c.map((v, k) => v - base.c[k]);
    assert.ok(d[0] * q.ax[0] + d[1] * q.ax[1] + d[2] * q.ax[2] > 0);
  });
}

test('a zero pivot draws the quad on the particle', () => {
  const base = quadOf(null, 'world'), q = quadOf([0, 0, 0], 'world');
  assert.deepEqual(q.c, base.c);
});
