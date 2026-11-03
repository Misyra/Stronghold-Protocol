// The room screen's search progress (public/js/screens/room.js matchmakingProgress, main.js queue.state): a ticket's
// waitingCount is the pool's raw entry total, so a 3-party beside a 2-party once read 5/4 in a 4-seat room. The screen
// clamps it to the target, falls back to the occupied seats without a queue frame, and the queue state handler says
// something when a ticket expires or becomes unavailable instead of dropping it silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAIN = readFileSync(path.join(ROOT, 'public/js/main.js'), 'utf8');
const { matchmakingProgress } = await import('../../public/js/screens/room.js');

const searching = (players, target, joinedAt = 0) => ({ status: 'searching', players, target, joinedAt });

test('an over-full pool is clamped to the target (never 5/4 or 6/4)', () => {
  assert.deepEqual(matchmakingProgress(searching(5, 4)), { matched: 4, target: 4, elapsed: 0 });
  assert.deepEqual(matchmakingProgress(searching(6, 4)), { matched: 4, target: 4, elapsed: 0 });
});

test('a normal pool keeps its waiting count', () => {
  assert.deepEqual(matchmakingProgress(searching(2, 4)), { matched: 2, target: 4, elapsed: 0 });
  assert.deepEqual(matchmakingProgress(searching(3, 4)), { matched: 3, target: 4, elapsed: 0 });
});

test('without a queue frame the room\'s occupied seats stand in, clamped too', () => {
  assert.deepEqual(matchmakingProgress(null, 3), { matched: 3, target: 4, elapsed: 0 });
  assert.deepEqual(matchmakingProgress(null, 9), { matched: 4, target: 4, elapsed: 0 });
  assert.deepEqual(matchmakingProgress(null, 0), { matched: 0, target: 4, elapsed: 0 });
  assert.deepEqual(matchmakingProgress({ status: 'idle' }, 2), { matched: 2, target: 4, elapsed: 0 });
});

test('queue.state toasts a ticket that expired or became unavailable', () => {
  for (const reason of ['expired', 'unavailable']) assert.match(MAIN, new RegExp(`msg\\.reason === '${reason}'`));
  for (const key of ['排队等待超时，已继续搜寻', '排队等待超时，已退出搜寻，请重新发起匹配',
    '有队友状态变化，已继续搜寻', '匹配状态已失效，请重新发起匹配']) {
    assert.ok(MAIN.includes(key), `main.js is missing ${key}`);
  }
});
