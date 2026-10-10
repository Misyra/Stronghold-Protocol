import { readFile } from 'node:fs/promises';
import { atomicWriteFile } from './http.mjs';
import { parseGameAnnouncement } from './announce.mjs';

export const DEFAULT_AGENT_ANNOUNCEMENT_FILE = '/var/lib/stronghold-announcement/announcement.json';
const fail = (code, status) => Object.assign(new Error(code), { code, status });

// A single configured destination; callers cannot choose a file or write arbitrary JSON.
// Revision and public announcement are committed together, surviving Agent restarts.
export function announcementWriter(file) {
  let pending = Promise.resolve();
  async function read() {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      if (!Number.isSafeInteger(raw._delivery?.revision) || raw._delivery.revision < 1) throw fail('ANNOUNCEMENT_STATE_INVALID', 409);
      return { revision: raw._delivery.revision, announcement: parseGameAnnouncement(raw) };
    } catch (error) { if (error.code === 'ENOENT') return { revision: 0, announcement: null }; throw error; }
  }
  return {
    read,
    write(value) {
      const operation = pending.then(async () => {
        if (!Number.isSafeInteger(value?.revision) || value.revision < 1) throw fail('INVALID_REVISION', 400);
        let announcement;
        try { announcement = parseGameAnnouncement(value.announcement); } catch { throw fail('INVALID_ANNOUNCEMENT', 400); }
        const previous = await read();
        if (value.revision < previous.revision) throw fail('STALE_REVISION', 409);
        if (value.revision === previous.revision) {
          if (JSON.stringify(announcement) !== JSON.stringify(previous.announcement)) throw fail('REVISION_CONFLICT', 409);
          return { revision: value.revision, unchanged: true };
        }
        await atomicWriteFile(file, JSON.stringify({ ...announcement, _delivery: { revision: value.revision } }) + '\n', { mode: 0o644 });
        return { revision: value.revision, unchanged: false };
      });
      pending = operation.catch(() => {});
      return operation;
    },
    close: () => pending,
  };
}

export async function readAnnouncementPush(req) {
  if (req.headers.origin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'none')) throw fail('BROWSER_WRITE_FORBIDDEN', 403);
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fail('JSON_REQUIRED', 415);
  let size = 0, chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 16 * 1024) throw fail('PAYLOAD_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('INVALID_JSON', 400); }
}
