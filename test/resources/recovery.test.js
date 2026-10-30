import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceRecovery } from '../../public/js/resources/recovery.js';

function fixture() {
  const window = new EventTarget(), document = new EventTarget(), navigator = { onLine: true };
  document.visibilityState = 'visible';
  let now = 0, timer;
  const recovery = new ResourceRecovery({ window, document, navigator, now: () => now,
    setTimer: (fn) => { timer = fn; return 1; }, clearTimer: () => { timer = null; } });
  return { window, document, navigator, recovery, tick: (ms) => { now += ms; timer?.(); } };
}

test('retry deadlines survive visibility/online events and hidden tabs wait until visible', () => {
  const f = fixture();
  let runs = 0;
  f.recovery.wait(() => runs++, { delay: 5000 });
  f.window.dispatchEvent(new Event('online'));
  f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(runs, 0, 'events must respect Retry-After/backoff');
  f.document.visibilityState = 'hidden';
  f.tick(5000);
  assert.equal(runs, 0);
  f.document.visibilityState = 'visible';
  f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(runs, 1);
  f.window.dispatchEvent(new Event('online'));
  assert.equal(runs, 1, 'recovery is one-shot');
});

test('offline recovery has no poll timer; cancellation and replacement remove every listener', () => {
  const f = fixture();
  let runs = 0;
  f.navigator.onLine = false;
  f.recovery.wait(() => runs++);
  f.tick(60000);
  assert.equal(runs, 0);
  f.recovery.cancel();
  f.navigator.onLine = true;
  f.window.dispatchEvent(new Event('online'));
  assert.equal(runs, 0, 'pause prevents a later reconnect from restarting');
  f.recovery.wait(() => runs += 100, { delay: 100 });
  f.recovery.wait(() => runs++);
  f.window.dispatchEvent(new Event('online'));
  f.tick(100);
  assert.equal(runs, 1, 'only the newest subscription resumes');
});
