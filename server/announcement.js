// Hot-loaded, read-only maintenance notice. The local configuration is never served directly.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseAnnouncements, activeAnnouncement } from '../shared/announcements.js';
import { N_ } from '../shared/i18n.js';

const MAX_FILE_BYTES = 16 * 1024;
const MAX_REMOTE_BYTES = 64 * 1024;
const CACHE_MS = 1000;
const POLL_MS = 10000;

/**
 * 这份文档自述的交付版本（Agent 写入公告文件时留下的 `_delivery.revision`）。它**不进**公开投影：玩家看到的
 * 只有公告本身，而「游戏读到了哪一版」是三层状态里的第三层（写入 / 读到 / 收敛），只有探针与中央需要。
 * 没有这个字段（旧部署、手工写的文件）时给 null —— 不猜 0：说「读到了第 0 版」比说「不知道」更容易把人
 * 引到错误的方向。
 */
function deliveryRevision(value) {
  const revision = value && typeof value === 'object' ? value._delivery?.revision : null;
  return Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
}

/** Validate configuration and derive a revision so edits reappear after a player dismissed an older notice. */
export function parseAnnouncement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
  if (value.enabled === false) return null;
  if (value.enabled !== true) throw new Error('enabled must be true or false');
  const title = value.title == null ? N_('维护公告') : value.title;
  if (typeof title !== 'string' || !title.trim() || title.length > 80) throw new Error('title must contain 1–80 characters');
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 2000) throw new Error('text must contain 1–2000 characters');
  // Require an explicit timezone; a server's local timezone must not silently move a maintenance deadline.
  if (typeof value.expiresAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value.expiresAt)) {
    throw new Error('expiresAt must be an ISO timestamp with a timezone');
  }
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiresAt)) throw new Error('invalid expiresAt');
  const [year, month, day, hour, minute, second] = value.expiresAt.slice(0, 19).split(/[-T:]/).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) {
    throw new Error('invalid calendar date in expiresAt');
  }
  if (value.displayMode != null && !['once', 'visit'].includes(value.displayMode)) throw new Error('displayMode must be once or visit');
  // Omit the legacy default from the hash so already-dismissed notices keep their identity.
  const notice = { title: title.trim(), text: value.text.trim(), expiresAt,
    ...(value.displayMode === 'visit' ? { displayMode: 'visit' } : {}) };
  const id = createHash('sha256').update(JSON.stringify(notice)).digest('hex').slice(0, 24);
  return { id, ...notice };
}

/**
 * One configuration document has two accepted shapes:
 *  - the schedule (`{ announcements: [...] }`, shared/announcements.js): any number of scroll and popup notices, each
 *    with an absolute start and an end, a severity level and — for popups — markdown, a link and auto-open;
 *  - the legacy single notice (`{ enabled, title, text, expiresAt, displayMode }`) this fork shipped first.
 * Both are validated atomically: a half-written edit never replaces the last good schedule.
 * @returns {{ rows: object[], legacy: object|null }}
 */
export function parseConfiguration(value) {
  if (value && typeof value === 'object' && Array.isArray(value.announcements)) {
    return { rows: parseAnnouncements(value), legacy: null };
  }
  const legacy = parseAnnouncement(value);
  return { rows: [], legacy };
}

/** The scroll notice in the shape the client has always read (the schedule row carries no displayMode). */
function scrollNotice(row) {
  return { id: row.id, title: row.title || N_('维护公告'), text: row.text, expiresAt: row.endAt };
}

/**
 * Cache file reads across players, coalesce concurrent reads, and check expiration on every request.
 * 返回的读函数带一个 `delivery()`：这份进程**实际读到**的那个版本（docs/design/portal-agent-wss.md §42.2 的第三层），供 /api/announcement
 * 投影给本机 Agent。它只前进不回退，读失败也保留上一次的值 —— 「读不到文件了」不代表「没读到过那一版」。
 */
export function createAnnouncementReader({ filePath, fallbackFilePath, announcementUrl, pollMs = POLL_MS, log, now = Date.now, cacheMs = CACHE_MS }) {
  if (announcementUrl != null && announcementUrl !== '') return createRemoteReader({ announcementUrl, pollMs, log, now });
  let rows = [];
  let legacy = null;
  let delivery = { revision: null, observedAt: null };
  let nextRead = -Infinity;
  let pending = null;
  let lastError = null;
  /** The scroll notice due right now, from whichever shape the document used. */
  const currentScroll = () => {
    if (legacy) return now() < legacy.expiresAt ? legacy : null;
    const row = activeAnnouncement(rows, now(), 'scroll');
    return row ? scrollNotice(row) : null;
  };
  const currentPopup = () => (legacy ? null : activeAnnouncement(rows, now(), 'popup'));
  async function load() {
    let file;
    let target = filePath;
    try {
      // The managed file wins; the repo's default schedule answers only when nothing was written there yet.
      file = await fs.open(target, 'r').catch(async (error) => {
        if (error.code !== 'ENOENT' || !fallbackFilePath) throw error;
        target = fallbackFilePath;
        return fs.open(target, 'r').catch((again) => { if (again.code === 'ENOENT') throw error; throw again; });
      });
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > MAX_FILE_BYTES) throw new Error('configuration exceeds 16 KiB');
      const parsed = JSON.parse(buffer.subarray(0, total).toString('utf8').replace(/^\uFEFF/, ''));
      const doc = parseConfiguration(parsed);
      rows = doc.rows; legacy = doc.legacy;
      delivery = { revision: deliveryRevision(parsed), observedAt: now() };
      lastError = null;
    } catch (error) {
      // This fork's rule (custom_docs/operations/ANNOUNCEMENTS.md): an unreadable or invalid configuration clears the
      // notice instead of leaving a stale deadline on screen. A schedule is never published *partially* either way.
      rows = []; legacy = null;
      const reason = error.code === 'ENOENT' ? null : error.message;
      if (reason && reason !== lastError) log?.warn?.('[announcement] invalid configuration:', reason);
      lastError = reason;
    } finally {
      await file?.close();
    }
  }
  const read = async () => {
    if (pending) await pending;
    else if (now() >= nextRead) {
      nextRead = now() + cacheMs;
      pending = load().finally(() => { pending = null; });
      await pending;
    }
    return currentScroll();
  };
  read.delivery = () => ({ ...delivery });
  /** The popup due right now (schedule documents only), or null. */
  read.popup = () => currentPopup();
  return read;
}

// Central-source mode (the ops panel is the editing surface): poll the announcement URL and keep the
// last good value while the source is unreachable, so a management-plane outage cannot blank a
// maintenance notice players still need to see. An explicit `enabled: false` clears it immediately.
function createRemoteReader({ announcementUrl, pollMs, log, now }) {
  const interval = Math.max(3000, Math.min(600000, Number(pollMs) === pollMs ? pollMs : POLL_MS));
  let rows = [];
  let legacy = null;
  let delivery = { revision: null, observedAt: null };
  let disabled = false;
  let nextPoll = -Infinity;
  let pending = null;
  let lastError = null;
  const currentScroll = () => {
    if (disabled) return null;
    if (legacy) return now() < legacy.expiresAt ? legacy : null;
    const row = activeAnnouncement(rows, now(), 'scroll');
    return row ? scrollNotice(row) : null;
  };
  const currentPopup = () => (disabled || legacy ? null : activeAnnouncement(rows, now(), 'popup'));
  async function poll() {
    try {
      const response = await fetch(announcementUrl, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      const length = Number(response.headers.get('content-length'));
      if (response.ok && Number.isFinite(length) && length > MAX_REMOTE_BYTES) throw new Error('response exceeds 64 KiB');
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { expected: true });
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_REMOTE_BYTES) { await reader.cancel(); throw new Error('response exceeds 64 KiB'); }
        chunks.push(value);
      }
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const doc = parseConfiguration(parsed);
      rows = doc.rows; legacy = doc.legacy;
      delivery = { revision: deliveryRevision(parsed), observedAt: now() };
      // A schedule document is never "disabled" as a whole: an empty list simply has nothing due.
      disabled = doc.legacy === null && doc.rows.length === 0;
      lastError = null;
    } catch (error) {
      const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'source timed out' :
        error.message;
      if (reason !== lastError) log?.warn?.('[announcement] central source unavailable:', reason);
      lastError = reason;
    }
  }
  const read = async () => {
    if (pending) await pending;
    else if (now() >= nextPoll) {
      nextPoll = now() + interval;
      pending = poll().finally(() => { pending = null; });
      await pending;
    }
    return currentScroll();
  };
  read.delivery = () => ({ ...delivery });
  read.popup = () => currentPopup();
  return read;
}
