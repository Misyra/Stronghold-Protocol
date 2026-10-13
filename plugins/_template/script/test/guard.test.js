import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, checkInvariants } from '../../../test/helpers/battleHarness.js';

test('training guard has its deployment talent and duration skill', () => {
  // tools/plugin.mjs test installs this plugin's content and SDK registrations before this module.
  const h = makeBattle({units:[{chessId:'chess_x_script_demo_guard_a',row:10,col:5}]});
  h.step();
  const u = h.allies()[0];
  assert.equal(u.kit.generic, undefined);
  assert.equal(u.skill.kind, 'duration');
  assert.ok(u.s.atk >= u.base.atk + 25);
  checkInvariants(h.b);
});
