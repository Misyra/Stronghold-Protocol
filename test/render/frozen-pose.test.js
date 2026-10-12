import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePixi } from './fakepixi.js';

let fake, SpineActor;
before(async () => {
  fake = installFakePixi();
  ({ SpineActor } = await import('../../public/js/render/spine.js'));
});
after(() => fake.restore());

const ENTRY = { anims: { idle: 'Idle' }, animations: { Idle: 1, Other: 1 } };
const DATA = { animations: [{ name: 'Idle' }, { name: 'Other' }] };

function frozenActor() {
  const actor = new SpineActor(DATA, ENTRY);
  const steps = [];
  actor.spine.update = (dt) => {
    steps.push(dt);
    actor.spine.state.tracks[0].trackTime += dt;
  };
  actor.setBase('stun');
  assert.equal(actor.frozen, true, 'no stun animation: hold the current pose');
  return { actor, steps };
}

test('initially stunned models apply their first pose without advancing animation time', () => {
  const { actor, steps } = frozenActor();
  try {
    assert.equal(actor.poseHeld(), false);
    actor.update(0.25);
    assert.deepEqual(steps, [0], 'pose the loaded skeleton before caching its image');
    assert.equal(actor.spine.state.tracks[0].trackTime, 0);
    assert.equal(actor.poseHeld(), true);
    actor.update(0.25);
    assert.deepEqual(steps, [0], 'an unchanged frozen pose needs no further Spine updates');
    assert.equal(actor.clock, 0.5, 'actor deadlines still advance');
    actor.setBase('idle');
    actor.update(0.25);
    assert.deepEqual(steps, [0, 0.25], 'thawing resumes animation');
  } finally { actor.destroy(); }
});

test('frozen tint and clip changes are applied once at zero time', () => {
  const { actor, steps } = frozenActor();
  try {
    actor.update(0.1);
    actor.spine.tint = 0xb4b4b4;
    assert.equal(actor.poseHeld(), false);
    actor.update(0.1);
    assert.equal(actor.poseHeld(), true);
    actor.update(0.1);
    assert.deepEqual(steps, [0, 0]);
    actor._play('Other', true);
    assert.equal(actor.poseHeld(), false);
    actor.update(0.1);
    actor.update(0.1);
    assert.deepEqual(steps, [0, 0, 0]);
    assert.equal(actor.spine.state.tracks[0].trackTime, 0);
  } finally { actor.destroy(); }
});

test('a failed first pose is not marked as applied and can retry', () => {
  const { actor, steps } = frozenActor();
  try {
    const update = actor.spine.update;
    actor.spine.update = () => { throw new Error('pose failed'); };
    assert.doesNotThrow(() => actor.update(0.1));
    assert.equal(actor.poseHeld(), false);
    assert.equal(actor._applied, false);
    actor.spine.update = update;
    actor.update(0.1);
    assert.deepEqual(steps, [0]);
    assert.equal(actor.poseHeld(), true);
  } finally { actor.destroy(); }
});
