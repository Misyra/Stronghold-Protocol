// Hot-loaded, read-only maintenance notice. The local configuration is never served directly.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
 * Cache file reads across players, coalesce concurrent reads, and check expiration on every request.
 * 返回的读函数带一个 `delivery()`：这份进程**实际读到**的那个版本（§6.3 的第三层），供 /api/announcement
 * 投影给本机 Agent。它只前进不回退，读失败也保留上一次的值 —— 「读不到文件了」不代表「没读到过那一版」。
 */
export function createAnnouncementReader({ filePath, announcementUrl, pollMs = POLL_MS, log, now = Date.now, cacheMs = CACHE_MS }) {
  if (announcementUrl != null && announcementUrl !== '') return createRemoteReader({ announcementUrl, pollMs, log, now });
  let notice = null;
  let delivery = { revision: null, observedAt: null };
  let nextRead = -Infinity;
  let pending = null;
  let lastError = null;
  async function load() {
    let file;
    try {
      file = await fs.open(filePath, 'r');
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > MAX_FILE_BYTES) throw new Error('configuration exceeds 16 KiB');
      const parsed = JSON.parse(buffer.subarray(0, total).toString('utf8').replace(/^\uFEFF/, ''));
      notice = parseAnnouncement(parsed);
      delivery = { revision: deliveryRevision(parsed), observedAt: now() };
      lastError = null;
    } catch (error) {
      notice = null;
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
    return notice && now() < notice.expiresAt ? notice : null;
  };
  read.delivery = () => ({ ...delivery });
  return read;
}

// Central-source mode (the ops panel is the editing surface): poll the announcement URL and keep the
// last good value while the source is unreachable, so a management-plane outage cannot blank a
// maintenance notice players still need to see. An explicit `enabled: false` clears it immediately.
function createRemoteReader({ announcementUrl, pollMs, log, now }) {
  const interval = Math.max(3000, Math.min(600000, Number(pollMs) === pollMs ? pollMs : POLL_MS));
  let notice = null;
  let delivery = { revision: null, observedAt: null };
  let disabled = false;
  let nextPoll = -Infinity;
  let pending = null;
  let lastError = null;
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
      notice = parseAnnouncement(parsed);
      delivery = { revision: deliveryRevision(parsed), observedAt: now() };
      disabled = notice === null;
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
    return disabled || !notice || now() >= notice.expiresAt ? null : notice;
  };
  read.delivery = () => ({ ...delivery });
  return read;
}
