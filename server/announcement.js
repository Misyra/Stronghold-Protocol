// Hot-loaded, read-only maintenance notice. The local configuration is never served directly.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const MAX_FILE_BYTES = 16 * 1024;
const CACHE_MS = 1000;

/** Validate configuration and derive a revision so edits reappear after a player dismissed an older notice. */
export function parseAnnouncement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
  if (value.enabled === false) return null;
  if (value.enabled !== true) throw new Error('enabled must be true or false');
  const title = value.title == null ? '维护公告' : value.title;
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
  const notice = { title: title.trim(), text: value.text.trim(), expiresAt };
  const id = createHash('sha256').update(JSON.stringify(notice)).digest('hex').slice(0, 24);
  return { id, ...notice };
}

/** Cache file reads across players, coalesce concurrent reads, and check expiration on every request. */
export function createAnnouncementReader({ filePath, log, now = Date.now, cacheMs = CACHE_MS }) {
  let notice = null;
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
      notice = parseAnnouncement(JSON.parse(buffer.subarray(0, total).toString('utf8').replace(/^\uFEFF/, '')));
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
  return async () => {
    if (pending) await pending;
    else if (now() >= nextRead) {
      nextRead = now() + cacheMs;
      pending = load().finally(() => { pending = null; });
      await pending;
    }
    return notice && now() < notice.expiresAt ? notice : null;
  };
}
