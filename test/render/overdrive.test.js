// test/render/overdrive.test.js — the two-segment skill bar of 过载, client side: render/interp.js carries b.snap `overdrive`
// [[id, on]] (server/sim/snapshot.js overdriveView) and render/units.js runs the SP bar down twice — the first half of the
// skill full → empty in the active colour, the second half again in red (COLORS.spOverdrive; PRTS 塔露拉 S3 "技能持续条变为
// 红色"; the owner's word of 2026-11-05). Headless fake PIXI (test/render/fakepixi.js).
// Run: node --test test/render/overdrive.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';
import { SnapshotBuffer, normalizeSnapshot } from '../../public/js/render/interp.js';
import { COLORS } from '../../public/js/render/style.js';
import { UF } from '../../shared/constants.js';

let fake, UnitView;
before(async () => {
  fake = installFakePixi();
  ({ UnitView } = await import('../../public/js/render/units.js'));
});
after(() => fake.restore());

const cam = () => presetCamera('normal', { width: 1280, height: 720 });
const tuple = (id, sp = 0, spMax = 0, flags = 0) => [id, 5, 10, 1000, 1000, sp, spMax, flags, 0];
const sample = (o = {}) => ({ x: 5, y: 10, hp: 1000, maxHp: 1000, sp: 0, spMax: 45, flags: 0, anim: 0, vx: 0, vy: 0, el: null, elFill: 0, elUntil: 0, elDur: 0, ...o });
const view = () => new UnitView(fakeViewCtx(fake.P, { cam }), { id: 1, side: 'ally', kind: 'op', defId: 'chess_char_5_diy1_a', tier: 5, x: 5, y: 10, maxHp: 1000, dir: 'RIGHT' });
const frames = (v, n, dt = 1 / 60) => { for (let i = 0; i < n; i++) v.update(dt, cam(), i * dt); };
const share = (v) => v.spFill.width / (v.spBg.width - 2);

describe('interp: b.snap `overdrive`', () => {
  test('parsed per listed unit (0 / 1 only); malformed or unlisted entries dropped; no list clears it', () => {
    const s = normalizeSnapshot({ t: 0, units: [tuple(1), tuple(2)], overdrive: [[1, 0], [2, 1], [3, 1], [1, 2], [2, 'x'], 'bad'] });
    assert.deepEqual([...s.overdrive], [[1, 0], [2, 1]]);
    assert.equal(normalizeSnapshot({ t: 0, units: [tuple(1)] }).overdrive, null);
    const b = new SnapshotBuffer({ delay: 0 });
    b.push({ t: 0, units: [tuple(1, 30, 45, UF.SKILL)], overdrive: [[1, 0]] }, 0);
    b.push({ t: 1, units: [tuple(1, 20, 45, UF.SKILL)] }, 0.5);
    assert.equal(b.sample(0).get(1).od, 0);
    assert.equal(b.sample(1).get(1).od, null, 'cleared once the list is gone');
  });
});

describe('the SP bar of a 过载 skill', () => {
  test('first gauge: the first half runs it full → empty in the active colour; second gauge: again, red', () => {
    const v = view();
    try {
      // 3/4 of the skill left (the tuple's whole fraction) = half of the first gauge
      v.sync(sample({ sp: 45 * 0.75, flags: UF.SKILL, od: 0 }), 1);
      frames(v, 1);
      assert.ok(Math.abs(share(v) - 0.5) < 1e-6, `first gauge half: ${share(v)}`);
      assert.equal(v.spFill.tint, COLORS.spActive);
      v.sync(sample({ sp: 45 * 0.5001, flags: UF.SKILL, od: 0 }), 2);
      frames(v, 1);
      assert.ok(share(v) < 0.01, 'the first gauge runs out at half time');
      // the second gauge: half the skill left = a full red bar, a quarter = half of it
      v.sync(sample({ sp: 45 * 0.5, flags: UF.SKILL, od: 1 }), 3);
      frames(v, 1);
      assert.ok(Math.abs(share(v) - 1) < 1e-6, `second gauge full: ${share(v)}`);
      assert.equal(v.spFill.tint, COLORS.spOverdrive);
      v.sync(sample({ sp: 45 * 0.25, flags: UF.SKILL, od: 1 }), 4);
      frames(v, 1);
      assert.ok(Math.abs(share(v) - 0.5) < 1e-6);
      assert.notEqual(COLORS.spOverdrive, COLORS.spActive);
    } finally { v.destroy(); }
  });

  test('without the list (an old server, or any other skill) the bar is the plain whole fraction', () => {
    const v = view();
    try {
      v.sync(sample({ sp: 45 * 0.75, flags: UF.SKILL }), 1);
      frames(v, 1);
      assert.ok(Math.abs(share(v) - 0.75) < 1e-6);
      assert.equal(v.spFill.tint, COLORS.spActive);
      // a stale `od` on a unit whose skill is off draws the plain SP bar
      v.sync(sample({ sp: 45 * 0.4, flags: 0, od: 1 }), 2);
      frames(v, 1);
      assert.ok(Math.abs(share(v) - 0.4) < 1e-6);
      assert.equal(v.spFill.tint, COLORS.sp);
    } finally { v.destroy(); }
  });
});
