import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceTasks } from '../../public/js/resources/tasks.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('a reserved download is shared, including before its work starts', async () => {
  const tasks = new ResourceTasks(), gate = deferred();
  let runs = 0;
  const first = tasks.run('download', async () => { runs++; await gate.promise; });
  assert.equal(tasks.run('download', () => assert.fail('duplicate')), first);
  assert.equal(tasks.busy, true);
  gate.resolve();
  await first;
  assert.equal(runs, 1);
  assert.equal(tasks.busy, false);
  assert.equal(tasks.download.controller, null);
});

test('archive cancels and drains download; clear cancels and drains archive before touching caches', async () => {
  const tasks = new ResourceTasks(), downloadGate = deferred(), archiveGate = deferred();
  const events = [], writes = [];
  const download = tasks.run('download', async (task) => {
    events.push('download');
    await downloadGate.promise;
    task.publish((v) => writes.push(v))('stale download');
    events.push('download drained');
  });
  await new Promise(setImmediate);
  const archive = tasks.run('archive', async (task) => {
    events.push('archive');
    await archiveGate.promise;
    task.publish((v) => writes.push(v))('stale archive');
    events.push('archive drained');
    throw new Error('cancelled');
  });
  const archiveResult = assert.rejects(archive, /cancelled/);
  assert.equal(tasks.download.controller.signal.aborted, true);
  await assert.rejects(tasks.run('archive', () => {}), /正在处理/);
  downloadGate.resolve();
  await download;
  await new Promise(setImmediate);
  const clear = tasks.run('clearing', () => { events.push('clear'); });
  assert.equal(tasks.archive.controller.signal.aborted, true);
  assert.equal(tasks.run('clearing', () => assert.fail('duplicate clear')), clear);
  assert.equal(tasks.run('download', () => assert.fail('download during clear')), clear);
  archiveGate.resolve();
  await Promise.all([clear, archiveResult]);
  assert.deepEqual(events, ['download', 'download drained', 'archive', 'archive drained', 'clear']);
  assert.deepEqual(writes, []);
  assert.equal(tasks.busy, false);
});

test('old inspections remain invalid after a task completes or the user changes intent', async () => {
  const tasks = new ResourceTasks();
  const before = tasks.inspection();
  await tasks.run('clearing', () => {});
  assert.equal(before(), false);
  const later = tasks.inspection();
  assert.equal(later(), true);
  tasks.invalidate();
  assert.equal(later(), false);
});

test('visibility retry listeners are replaced and removed on pause and task start', async () => {
  const tasks = new ResourceTasks(), target = new EventTarget();
  let calls = 0;
  tasks.watch(target, () => { calls += 100; });
  tasks.watch(target, () => { calls++; });
  target.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 1);
  tasks.invalidate();
  target.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 1);
  tasks.watch(target, () => { calls++; });
  await tasks.run('download', () => {});
  target.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls, 1);
});

test('slot cleanup precedes a requested restart, and rejected work remains retryable', async () => {
  const tasks = new ResourceTasks();
  let runs = 0;
  await tasks.run('download', () => { runs++; }, () => tasks.run('download', () => { runs++; }));
  assert.equal(runs, 2);
  await assert.rejects(tasks.run('archive', () => { throw new Error('bad zip'); }), /bad zip/);
  assert.equal(tasks.archive.controller, null);
  assert.equal(await tasks.run('archive', () => 'retry'), 'retry');
});
