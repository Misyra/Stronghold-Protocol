// server/announcement.js — hot-loaded, read-only maintenance notice (合并自用户分支; 单源精简版: one JSON
// schedule file, hot-reloaded — the probe-managed agent file, the central feed reader and the delivery-revision
// bookkeeping of the fork's ops pipeline stay with that deployment and are not ported).
// The local configuration is never served directly: only the public projection leaves the process.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseAnnouncements, activeAnnouncement } from '../shared/announcements.js';
import { N_ } from '../shared/i18n.js';

const MAX_FILE_BYTES = 16 * 1024;
const POLL_MS = 10000;

/** One nonblocking, shared refresh for all WS heartbeats. The revision is the SHA-256 of the public active
 *  notice(s) only — no private metadata ever reaches it. */
export function createAnnouncementSignal(read, { now = Date.now, intervalMs = 1000 } = {}) {
  let revision = null, nextRead = -Infinity, pending = null;
  return () => {
    if (!pending && now() >= nextRead) {
      nextRead = now() + intervalMs;
      pending = Promise.resolve().then(read).then((announcement) => {
        revision = createHash('sha256').update(JSON.stringify({ announcement, popup: read.popup?.() ?? null }))
          .digest('hex').slice(0, 24);
      }).catch(() => {}).finally(() => { pending = null; });
    }
    return revision;
  };
}

/** The scroll notice in the shape the client has always read (the schedule row carries no displayMode). */
function scrollNotice(row) {
  return { id: row.id, title: row.title || N_('维护公告'), text: row.text, expiresAt: row.endAt };
}

/**
 * Cache file reads across players, coalesce concurrent reads, and check expiration on every request. The file is
 * re-read at most every `pollMs` (the server-wide edit latency); an unreadable or invalid configuration clears the
 * notice instead of leaving a stale deadline on screen, and a schedule is never published partially.
 */
export function createAnnouncementReader({ filePath, pollMs = POLL_MS, log, now = Date.now }) {
  let rows = [];
  let nextRead = -Infinity;
  let pending = null;
  let lastError = null;
  /** The scroll notice due right now. */
  const currentScroll = () => {
    const row = activeAnnouncement(rows, now(), 'scroll');
    return row ? scrollNotice(row) : null;
  };
  /** The popup due right now (schedule documents only), or null. */
  const currentPopup = () => activeAnnouncement(rows, now(), 'popup');
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
      rows = parseAnnouncements(JSON.parse(buffer.subarray(0, total).toString('utf8').replace(/^\uFEFF/, '')));
      lastError = null;
    } catch (error) {
      rows = [];
      const reason = error?.code === 'ENOENT' ? null : error.message;
      if (reason && reason !== lastError) log?.warn?.('[announcement] invalid configuration:', reason);
      lastError = reason;
    } finally {
      await file?.close();
    }
  }
  const read = async () => {
    if (pending) await pending;
    else if (now() >= nextRead) {
      nextRead = now() + pollMs;
      pending = load().finally(() => { pending = null; });
      await pending;
    }
    return currentScroll();
  };
  read.popup = () => currentPopup();
  return read;
}
