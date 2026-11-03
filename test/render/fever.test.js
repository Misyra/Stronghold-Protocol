// test/render/fever.test.js — 丰川祥子's Fever gauge, client side: render/interp.js carries b.snap `fever` [[id, fill, on]]
// (server/sim/snapshot.js feverView ← kits/ops/op-oblvns.js unit.feverView) and render/units.js draws it as a thin bar
// under her HP bar — rose while it fills, a brighter pulsing pink while Fever runs (headless fake PIXI, test/render/fakepixi.js).
// Run: node --test test/render/fever.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';
import { SnapshotBuffer, normalizeSnapshot } from '../../public/js/render/interp.js';
import { COLORS } from '../../public/js/render/style.js';

let fake, UnitView;
before(async () => {
  fake = installFakePixi();
  ({ UnitView } = await import('../../public/js/render/units.js'));
});
after(() => fake.restore());

const cam = () => presetCamera('normal', { width: 1280, height: 720 });
const tuple = (id) => [id, 5, 10, 1000, 1000, 0, 0, 0, 0];
const sample = (o = {}) => ({ x: 5, y: 10, hp: 1000, maxHp: 1000, sp: 0, spMax: 0, flags: 0, anim: 0, vx: 0, vy: 0, el: null, elFill: 0, elUntil: 0, elDur: 0, ...o });
const view = (info = {}) => new UnitView(fakeViewCtx(fake.P, { cam }), { id: 1, side: 'ally', kind: 'op', defId: 'chess_char_5_diy1_a', tier: 5, x: 5, y: 10, maxHp: 1000, dir: 'RIGHT', ...info });
const frames = (v, n, dt = 1 / 60) => { for (let i = 0; i < n; i++) v.update(dt, cam(), i * dt); };
const share = (r) => (r.fill.visible ? r.fill.width / (r.bg.width - 2) : 0);

describe('interp: b.snap `fever`', () => {
  test('parsed per listed unit, clamped, `on` normalised; malformed or unlisted entries dropped; no list clears it', () => {
    const s = normalizeSnapshot({ t: 0, units: [tuple(1), tuple(2)], fever: [[1, 0.4, 0], [2, 1.5, 7], [3, 0.5, 0], [1, 'x', 0], 'bad'] });
    assert.deepEqual([...s.fever], [[1, [0.4, 0]], [2, [1, 1]]]);
    assert.equal(normalizeSnapshot({ t: 0, units: [tuple(1)] }).fever, null);
    const b = new SnapshotBuffer({ delay: 0 });
    b.push({ t: 0, units: [tuple(1)], fever: [[1, 0.25, 0]] }, 0);
    b.push({ t: 1, units: [tuple(1)] }, 0.5);
    assert.deepEqual(b.sample(0).get(1).fever, [0.25, 0]);
    assert.equal(b.sample(1).get(1).fever, null, 'cleared once the list is gone');
  });
});

describe('the Fever bar under her HP bar', () => {
  test('rose while it fills; nothing built without a gauge; hidden once it is gone; no per-frame allocation', () => {
    const v = view();
    try {
      v.sync(sample(), 1);
      frames(v, 2);
      assert.equal(v._feverBar, null, 'nothing built without a gauge');
      v.sync(sample({ fever: [0, 0] }), 1);
      frames(v, 1);
      const r = v._feverBar;
      assert.ok(r.root.visible, 'an empty gauge shows its track');
      assert.equal(r.fill.visible, false);
      v.sync(sample({ fever: [0.6, 0] }), 2);
      frames(v, 1);
      assert.ok(Math.abs(share(r) - 0.6) < 1e-9, `share ${share(r)}`);
      assert.equal(r.fill.tint, COLORS.fever);
      assert.equal(r.fill.alpha, 1, 'steady while it fills');
      const kids = r.root.children.length;
      frames(v, 30);
      assert.equal(r.root.children.length, kids);
      v.sync(sample(), 3);
      frames(v, 1);
      assert.equal(r.root.visible, false);
    } finally { v.destroy(); }
  });

  test('a full gauge pulses; during Fever the pale bar drains and pulses; enemies never show one', () => {
    const v = view();
    try {
      v.sync(sample({ fever: [1, 0] }), 1);
      const alphas = new Set();
      for (let i = 0; i < 40; i++) { v.update(1 / 60, cam(), i / 60); alphas.add(Math.round(v._feverBar.fill.alpha * 100)); }
      assert.ok(alphas.size > 3, 'a full gauge pulses (the next skill starts Fever)');
      v.sync(sample({ fever: [0.3, 1] }), 2);
      frames(v, 1);
      const r = v._feverBar;
      assert.equal(r.fill.tint, COLORS.feverOn);
      assert.ok(Math.abs(share(r) - 0.3) < 1e-9);
    } finally { v.destroy(); }
    const e = view({ id: 2, side: 'enemy', kind: 'enemy', defId: 'enemy_x', dir: undefined });
    try {
      e.sync(sample({ fever: [0.5, 0] }), 1);
      frames(e, 1);
      assert.ok(!e._feverBar || !e._feverBar.root.visible);
    } finally { e.destroy(); }
  });
});
