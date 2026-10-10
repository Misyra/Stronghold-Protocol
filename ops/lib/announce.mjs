// Game-announcement store for the panel: the panel is the editing surface and source of truth, and
// managed probes receive pushes; other game servers can still poll the public feed. Validation mirrors the game's own
// parseAnnouncement rules exactly, so anything accepted here is accepted by every game.
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const MAX_FILE_BYTES = 64 * 1024;

export function parseGameAnnouncement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
  if (value.enabled === false) return { enabled: false };
  if (value.enabled !== true) throw new Error('enabled must be true or false');
  const title = value.title == null ? '维护公告' : value.title;
  if (typeof title !== 'string' || !title.trim() || title.length > 80) throw new Error('标题需要 1–80 个字符');
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 2000) throw new Error('正文需要 1–2000 个字符');
  if (typeof value.expiresAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value.expiresAt) ||
    !Number.isFinite(Date.parse(value.expiresAt))) throw new Error('expiresAt 必须是带时区的 ISO 时间');
  const [year, month, day, hour, minute, second] = value.expiresAt.slice(0, 19).split(/[-T:]/).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) throw new Error('expiresAt 日期无效');
  return { enabled: true, title: title.trim(), text: value.text.trim(), expiresAt: value.expiresAt };
}

// A corrupt or partly invalid file degrades to the entries that still parse, never to a crash.
export async function loadAnnounceStore(file) {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const rawSites = raw && typeof raw === 'object' && raw.sites && typeof raw.sites === 'object' ? raw.sites : {};
    const sites = {};
    for (const [id, value] of Object.entries(rawSites)) {
      try { sites[id] = parseGameAnnouncement(value); } catch { /* drop the unusable entry, keep the rest */ }
    }
    const revisions = {};
    for (const [id, revision] of Object.entries(raw?.revisions || {})) if (/^[a-z0-9-]{1,40}$/.test(id) && Number.isSafeInteger(revision) && revision > 0) revisions[id] = revision;
    return { sites, revisions };
  } catch (error) {
    if (error?.code === 'ENOENT') return { sites: {}, revisions: {} };
    throw error;
  }
}

export async function saveAnnounceStore(file, store) {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const text = `${JSON.stringify(store, null, 2)}\n`;
  try {
    await writeFile(tmp, text);
    await rename(tmp, file);
  } catch (error) { await rm(tmp, { force: true }); throw error; }
}
