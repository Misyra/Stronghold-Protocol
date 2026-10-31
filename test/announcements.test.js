// The multi-notice schedule model (shared/announcements.js, adapted from xinhai-ai/Stronghold-Protocol). Pure validation
// and selection: the transport (server/announcement.js: panel file / central URL, delivery revision) stays this fork's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnnouncements, activeAnnouncement, announcementLive, announcementFromMessage } from '../shared/announcements.js';

const BASE = Date.parse('2026-10-05T12:00:00+08:00');
const row = (overrides = {}) => ({ id: 'maintenance', text: '维护通知', startAt: new Date(BASE).toISOString(), durationSeconds: 60, level: 'info', enabled: true, ...overrides });
const doc = (...rows) => ({ announcements: rows });

test('config validation: timezone, plain text, limits, unique ids and explicit booleans', () => {
  assert.deepEqual(parseAnnouncements(doc()), []);
  const [n] = parseAnnouncements(doc(row({ text: '  临时通知\n请留意  ' })));
  assert.equal(n.text, '临时通知 请留意');
  assert.equal(n.startAt, BASE);
  assert.equal(n.endAt, BASE + 60000);
  assert.equal(parseAnnouncements(doc(row({ title: '  计划维护  ' })))[0].title, '计划维护');
  for (const title of ['', '   ', 42, 'x'.repeat(81)]) assert.throws(() => parseAnnouncements(doc(row({ title }))));
  assert.equal(parseAnnouncements(doc(row({ startAt: '2026-10-05T12:00:00.1234567+08:00' })))[0].startAt, BASE + 123);
  assert.throws(() => parseAnnouncements(doc(row({ startAt: '2026-10-05T12:00:00' }))), 'no timezone is a reject');
  assert.throws(() => parseAnnouncements(doc(row({ startAt: '2026-02-30T12:00:00+08:00' }))), 'calendar day');
  assert.throws(() => parseAnnouncements(doc(row({ level: ['info'] }))));
  for (const changes of [{ text: '' }, { text: 'x'.repeat(501) }, { durationSeconds: 0 }, { durationSeconds: 86401 },
    { durationSeconds: 1.5 }, { level: 'constructor' }, { enabled: 'false' }, { id: 'bad id' }]) {
    assert.throws(() => parseAnnouncements(doc(row(changes))));
  }
  assert.throws(() => parseAnnouncements(doc(row(), row())), 'ids must be unique');
  assert.throws(() => parseAnnouncements(doc(...Array.from({ length: 101 }, (_, i) => row({ id: `n-${i}` })))));
  assert.equal(parseAnnouncements(doc(row({ text: '<script>alert(1)</script>' })))[0].text, '<script>alert(1)</script>');
});

test('absolute start/expiry, severity and same-level ordering never extend a hidden notice', () => {
  const rows = parseAnnouncements(doc(row(), row({ id: 'urgent', level: 'urgent', durationSeconds: 10 }),
    row({ id: 'disabled', level: 'urgent', enabled: false })));
  assert.equal(activeAnnouncement(rows, BASE - 1), null);
  assert.equal(activeAnnouncement(rows, BASE).id, 'urgent', 'severity wins');
  assert.equal(activeAnnouncement(rows, BASE + 10000).id, 'maintenance', 'the urgent one expired');
  assert.equal(activeAnnouncement(rows, BASE + 60000), null);
  const same = parseAnnouncements(doc(row({ id: 'later', startAt: new Date(BASE + 1000).toISOString() }), row({ id: 'earlier' })));
  assert.equal(activeAnnouncement(same, BASE + 1001).id, 'earlier', 'earliest start first among equals');
  assert.equal(announcementLive(rows[0], BASE + 60000), false);
});

test('title, link and popup options round trip; a scroll notice refuses popup-only fields', () => {
  const options = { type: 'popup', title: '  更新公告  ', url: 'https://example.com/notice?a=1&b=2', autoPopup: true };
  const notice = activeAnnouncement(parseAnnouncements(doc(row(options))), BASE, 'popup');
  assert.deepEqual(announcementFromMessage({ popupAnnouncement: notice }, 'popup'), notice);
  assert.equal(notice.title, '更新公告');
  assert.equal(notice.url, options.url);
  assert.equal(notice.autoPopup, true);
  const manual = activeAnnouncement(parseAnnouncements(doc(row({ type: 'popup', autoPopup: false }))), BASE, 'popup');
  assert.equal(announcementFromMessage({ popupAnnouncement: manual }, 'popup').autoPopup, false);
  const scroll = activeAnnouncement(parseAnnouncements(doc(row())), BASE);
  assert.deepEqual(announcementFromMessage({ announcement: scroll }), scroll);
  assert.equal(scroll.autoPopup, undefined);
  assert.equal(parseAnnouncements(doc(row({ type: 'popup', url: 'http://localhost:3000/notice' })))[0].url, 'http://localhost:3000/notice');
  for (const changes of [{ type: 'both' }, { autoPopup: true }, { url: 'https://example.com' }]) {
    assert.throws(() => parseAnnouncements(doc(row(changes))), 'scroll notices carry no popup fields');
  }
  for (const changes of [{ title: 'bad\nheader' }, { autoPopup: 'false' }, { autoPopup: 1 },
    ...['javascript:alert(1)', 'data:text/html,hello', '//example.com', '/notice', 'https://user:secret@example.com/',
      'https://example.com/\nnotice', 'https://example.com/a b', '', 42, 'https://example.com/' + 'a'.repeat(2048)].map((url) => ({ url }))]) {
    assert.throws(() => parseAnnouncements(doc(row({ type: 'popup', ...changes }))));
    assert.equal(announcementFromMessage({ popupAnnouncement: { ...notice, ...changes } }, 'popup'), null);
  }
});
