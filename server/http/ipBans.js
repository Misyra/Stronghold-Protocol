// Persistent permanent/expiring network bans. This file belongs outside every served directory.
import fs from 'node:fs';
import path from 'node:path';
import { clientAddress, limitKeyOf, normalizeIp } from '../net.js';

const MAX_BANS = 100000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;

function validKey(key) {
  if (typeof key !== 'string') return false;
  const ip = normalizeIp(key.endsWith('/64') ? key.slice(0, -3) : key);
  return ip !== null && limitKeyOf(ip) === key;
}

/** Legacy entries without expiresAt remain permanent; timed bans expire across process restarts. */
export function createIpBanStore({ file = null, log = console, now = Date.now } = {}) {
  const bans = new Map();
  let fileBytes = 0;
  const sweep = () => {
    const at = now();
    for (const [key, expiresAt] of bans) if (expiresAt !== null && expiresAt <= at) bans.delete(key);
  };
  const has = (key) => {
    if (!bans.has(key)) return false;
    const expiresAt = bans.get(key);
    if (expiresAt !== null && expiresAt <= now()) { bans.delete(key); return false; }
    return true;
  };
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      fileBytes = fs.statSync(file).size;
      if (fileBytes > MAX_FILE_BYTES) throw new Error('HTTP ban file is too large');
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        if (!validKey(entry.key)) throw new Error('Invalid network key in HTTP ban file');
        const expiresAt = entry.expiresAt ?? null;
        if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= 0)) throw new Error('Invalid expiry in HTTP ban file');
        if (expiresAt !== null && expiresAt <= now()) continue;
        // A later temporary ban can never weaken an existing permanent ban.
        const previous = bans.get(entry.key);
        bans.set(entry.key, previous === null || expiresAt === null ? null : Math.max(previous || 0, expiresAt));
        if (bans.size > MAX_BANS) throw new Error('HTTP ban file has too many entries');
      }
    }
    // Refuse startup on unwritable storage, before game resources are allocated.
    fs.closeSync(fs.openSync(file, 'a', 0o600));
  }
  return {
    has,
    isBanned(req, trustProxy = 'auto') {
      const { key } = clientAddress(req, trustProxy);
      return key !== null && has(key);
    },
    /** @returns {boolean} false when the list is full — the caller keeps its own refusal instead of throwing. */
    ban(key, { durationMs = null, reason = 'PUBLIC_API_FLOOD' } = {}) {
      if (!validKey(key)) throw new Error('Invalid HTTP ban key');
      if (durationMs !== null && (!Number.isSafeInteger(durationMs) || durationMs <= 0 || !Number.isSafeInteger(now() + durationMs)))
        throw new Error('Invalid IP ban duration');
      if (has(key) && (bans.get(key) === null || durationMs !== null)) return true;
      // A full list is a capacity limit, not a programming error: report it so the rate limiter can keep refusing
      // the network (publicApiLimit's overThreshold) instead of turning the request into a 500 and losing the count.
      if (bans.size >= MAX_BANS) sweep();
      if (!bans.has(key) && bans.size >= MAX_BANS) { log.warn?.(`[http] ban list is full (${MAX_BANS}): not adding ${key}`); return false; }
      const bannedAt = now();
      const expiresAt = durationMs === null ? null : bannedAt + durationMs;
      bans.set(key, expiresAt);
      if (file) {
        let fd;
        try {
          const record = JSON.stringify({ key, bannedAt, reason, ...(expiresAt === null ? {} : { expiresAt }) }) + '\n';
          if (fileBytes + Buffer.byteLength(record) > MAX_FILE_BYTES) {
            sweep();
            // Compact before reaching the load limit; expired historical bans must not poison the next restart.
            const snapshot = [...bans].map(([key, until]) => JSON.stringify({ key, bannedAt,
              reason: 'COMPACTED', ...(until === null ? {} : { expiresAt: until }) }) + '\n').join('');
            const temp = `${file}.${process.pid}.tmp`;
            fd = fs.openSync(temp, 'w', 0o600);
            fs.writeFileSync(fd, snapshot); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
            fs.renameSync(temp, file);
            fileBytes = Buffer.byteLength(snapshot);
          } else {
            fd = fs.openSync(file, 'a', 0o600);
            fs.writeFileSync(fd, record);
            fileBytes += Buffer.byteLength(record);
          }
          if (fd !== undefined) fs.fsyncSync(fd);
        } catch (error) {
          // Keep the in-memory ban even when the disk fails; never silently claim persistence.
          log.error('[http] IP ban could not be persisted', error);
        } finally { if (fd !== undefined) fs.closeSync(fd); }
      }
      log.warn?.(`[http] banned ${key}: ${reason}; ${expiresAt === null ? 'permanent' : `until ${new Date(expiresAt).toISOString()}`}`);
      return true;
    },
    get size() { sweep(); return bans.size; },
  };
}
