import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announcementSnapshot, startAnnouncementPolling } from '../../public/js/ui/announcementClient.js';
import { createAnnouncementDisplay } from '../../public/js/ui/announcementDisplay.js';

test('once survives reload, visit closes for this page only, edits show again, unavailable storage works', () => {
  const values = new Map();
  const storage = { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) };
  const once = { id: 'legacy' }, visit = { id: 'repeated', displayMode: 'visit' };
  const first = createAnnouncementDisplay({ storage });
  first.dismiss(once); first.dismiss(visit);
  assert.equal(first.isDismissed(once), true);
  assert.equal(first.isDismissed({ ...visit }), true, 'polling the same revision does not reopen it');
  const reload = createAnnouncementDisplay({ storage });
  assert.equal(reload.isDismissed(once), true);
  assert.equal(reload.isDismissed(visit), false);
  assert.equal(reload.isDismissed({ id: 'edited' }), false);
  const blocked = createAnnouncementDisplay({ storage: { getItem() { throw Error(); }, setItem() { throw Error(); } } });
  assert.equal(blocked.isDismissed(once), false);
  blocked.dismiss(once);
  assert.equal(blocked.isDismissed(once), true);
});

const body = { serverTime: 1000, announcement: { id: 'revision', title: '维护公告', text: '<script>plain text</script>', expiresAt: 2000 } };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function documentStub() {
  const handlers = new Set();
  return { hidden: false, handlers, addEventListener: (_, fn) => handlers.add(fn),
    removeEventListener: (_, fn) => handlers.delete(fn), fire: () => { for (const fn of handlers) fn(); } };
}

test('notice deadline follows server time and a monotonic clock, independent of the player wall clock', () => {
  assert.equal(announcementSnapshot(body, 50).deadline, 1050);
  assert.equal(announcementSnapshot({ ...body, serverTime: 2000 }, 50), null);
  assert.equal(announcementSnapshot({ announcement: null }, 50), null);
  assert.equal(announcementSnapshot({ ...body, serverTime: NaN }, 50), null);
  assert.equal(announcementSnapshot({ ...body, announcement: { text: 'invalid' } }, 50), null);
});

test('polling updates and withdrawal do not require reloading, failures retain state, hidden tabs pause', async () => {
  const doc = documentStub();
  const received = [];
  let response = body;
  let fail = false;
  let calls = 0;
  const stop = startAnnouncementPolling({ doc, now: () => 50, intervalMs: 60_000, onChange: (a) => received.push(a),
    fetchFn: async (url, init) => {
      calls++;
      assert.equal(url, '/api/announcement');
      assert.equal(init.cache, 'no-store');
      if (fail) throw new Error('offline');
      return { ok: true, json: async () => response };
    } });
  try {
    await settle();
    assert.equal(received.length, 1);
    fail = true;
    doc.fire();
    await settle();
    assert.equal(received.length, 1);
    doc.hidden = true;
    doc.fire();
    assert.equal(calls, 2);
    doc.hidden = false;
    fail = false;
    response = { announcement: null };
    doc.fire();
    await settle();
    assert.equal(received.at(-1), null);
  } finally { stop(); }
  assert.equal(doc.handlers.size, 0);
  doc.fire();
  assert.equal(calls, 3);
});

test('hung fetches time out, do not overlap, and cannot publish after stop', async () => {
  const doc = documentStub();
  const received = [];
  const signals = [];
  let release;
  const stop = startAnnouncementPolling({ doc, intervalMs: 60_000, timeoutMs: 20, onChange: (a) => received.push(a),
    fetchFn: async (_, { signal }) => {
      signals.push(signal);
      return new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => body }); });
    } });
  try {
    doc.fire();
    assert.equal(signals.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(signals[0].aborted, true);
    release();
    await settle();
    assert.equal(received.length, 0, 'late response after timeout is ignored');
    doc.fire();
    assert.equal(signals.length, 2, 'a timeout does not permanently block later checks');
  } finally { stop(); }
  assert.equal(signals[1].aborted, true);
  release();
  await settle();
  assert.equal(received.length, 0);
});
