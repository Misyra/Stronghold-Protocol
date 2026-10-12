import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';
import { createAssets } from '../../public/js/assets.js';
import { SpineActor } from '../../public/js/render/spine.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const entry = (id) => ({ skel: `/assets/${id}.skel`, atlas: `/assets/${id}.atlas`, textures: [`/assets/${id}.png`],
  anims: { idle: 'Idle', move: 'Move' }, animations: { Idle: 1, Move: 1 } });
const front = entry('front'), back = entry('back');
const manifest = { chars: { char_002_amiya: { spine: { front, back } } }, ui: {} };
const data = { animations: [{ name: 'Idle' }, { name: 'Move' }] };
let fake, UnitView;
before(async () => { fake = installFakePixi(); ({ UnitView } = await import('../../public/js/render/units.js')); });
after(() => fake.restore());
const cam = () => presetCamera('prep', { width: 1280, height: 720 });
const assets = () => createAssets({ manifest, loadImage: async () => null, loadSpine: async () => data, unloadSpine: () => {} });
const unit = (a) => new UnitView(fakeViewCtx(fake.P, { assets: a, cam }), {
  id: 1, side: 'ally', kind: 'chess', defId: 'char_002_amiya', spine: 'char_002_amiya',
  tier: 3, x: 5, y: 12, maxHp: 1000,
}, { prep: true });

test('a downloaded model that fails to construct retries and balances every reference', async () => {
  const Original = fake.P.spine.Spine;
  let attempts = 0;
  fake.P.spine.Spine = class extends Original {
    constructor(d) { if (++attempts === 1) throw new Error('transient model creation failure'); super(d); }
  };
  const a = assets(), v = unit(a);
  try {
    await tick();
    assert.equal(v.actor, null);
    assert.ok(v._retryAt > 0, 'build failures use the same bounded retry path as download failures');
    assert.equal(a.spine.stats().refs, 0);
    v._retryAt = 1;
    v.update(1 / 60, cam(), 0);
    await tick();
    assert.ok(v.actor && v.spineReady);
    assert.equal(attempts, 2);
    assert.equal(a.spine.stats().refs, 1);
  } finally { v.destroy(); a.spine.clear(); fake.P.spine.Spine = Original; }
  assert.equal(a.spine.stats().refs, 0);
});

test('permanent build failures stop retrying instead of starting a request every frame', async () => {
  const Original = fake.P.spine.Spine;
  let attempts = 0;
  fake.P.spine.Spine = class { constructor() { attempts++; throw new Error('bad skeleton'); } };
  const a = assets(), v = unit(a);
  try {
    await tick();
    for (let i = 0; i < 10; i++) {
      if (v._retryAt) v._retryAt = 1;
      v.update(1 / 60, cam(), 0);
      await tick();
    }
    assert.ok(attempts > 1 && attempts <= 5, `bounded attempts: ${attempts}`);
    assert.equal(v._retryAt, 0);
    assert.equal(a.spine.stats().refs, 0);
    assert.equal(v.fallback.visible, true);
  } finally { v.destroy(); a.spine.clear(); fake.P.spine.Spine = Original; }
});

test('a failed pose replay preserves the previous model and disposes the unfinished replacement', async () => {
  const a = assets(), v = unit(a);
  const Original = fake.P.spine.Spine;
  const setBase = SpineActor.prototype.setBase;
  let unfinished;
  try {
    await tick();
    const shown = v.actor;
    assert.ok(shown);
    // Pose replay happens after construction and before the new actor may replace the old one.
    fake.P.spine.Spine = class extends Original {
      constructor(d) { super(d); unfinished = this; }
    };
    SpineActor.prototype.setBase = function (...args) {
      if (this.spine === unfinished) throw new Error('pose failed');
      return setBase.apply(this, args);
    };
    v._pendingDeployElapsed = 0.5;
    shown.deployElapsed = () => 0.5;
    v._acquireSpine(back, 'char_002_amiya');
    await tick();
    assert.equal(v.actor, shown, 'the working actor remains installed');
    assert.equal(shown.spine.destroyed, false);
    assert.equal(unfinished.destroyed, true);
    assert.equal(a.spine.stats().refs, 1);
    assert.ok(v._retryAt > 0, 'the failed orientation swap can retry while the old model stays visible');
    SpineActor.prototype.setBase = setBase;
    fake.P.spine.Spine = Original;
    v._retryAt = 1;
    v._loadSpine = () => v._acquireSpine(back, 'char_002_amiya', true);
    v.update(1 / 60, cam(), 0);
    await tick();
    assert.notEqual(v.actor, shown);
    assert.equal(v._actorEntry, back);
    assert.equal(a.spine.stats().refs, 1);
  } finally { SpineActor.prototype.setBase = setBase; fake.P.spine.Spine = Original; v.destroy(); a.spine.clear(); }
});

test('a constructor failure while starting Idle disposes its partially built Spine object', async () => {
  const Original = fake.P.spine.Spine;
  let unfinished;
  fake.P.spine.Spine = class extends Original {
    constructor(d) { super(d); unfinished = this; this.state.setAnimation = () => { throw new Error('invalid Idle'); }; }
  };
  const a = assets(), v = unit(a);
  try {
    await tick();
    assert.equal(v.actor, null);
    assert.equal(unfinished.destroyed, true);
    assert.ok(v._retryAt > 0);
    assert.equal(a.spine.stats().refs, 0);
  } finally { v.destroy(); a.spine.clear(); fake.P.spine.Spine = Original; }
});

test('a local model build failure tries its web fallback without leaking the failed entry', async () => {
  const Original = fake.P.spine.Spine;
  const local = { ...entry('local'), fallback: front };
  fake.P.spine.Spine = class extends Original {
    constructor(d) { if (d.local) throw new Error('bad local model'); super(d); }
  };
  const a = createAssets({ loadImage: async () => null, loadSpine: async (e) => ({ ...data, local: e === local }), unloadSpine: () => {} });
  const v = unit(a);
  try {
    v._acquireSpine(local, 'char_002_amiya');
    await tick();
    assert.ok(v.actor && v.spineReady);
    assert.equal(v._actorEntry, front);
    assert.equal(a.spine.stats().refs, 1);
    assert.equal(v._retryAt, 0);
  } finally { v.destroy(); a.spine.clear(); fake.P.spine.Spine = Original; }
});
