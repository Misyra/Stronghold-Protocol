// i18n-ignore-file: private chat-log housekeeping, no player-visible content.
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, lstat, link, unlink, open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const DAY_MS = 86400000;
const DAILY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/;
const TEMP_FILE = /^\.chat-archive-[a-f0-9-]{36}\.tmp$/;

export function logDays(value, name, fallback) {
  const days = value == null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(days) || days < 0 || days > 36500) throw new RangeError(`${name} must be an integer from 0 to 36500`);
  return days;
}

async function entries(dir) {
  let names;
  try { names = await readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of names) {
    if (!entry.isFile()) continue; // no directories or symbolic links
    const match = DAILY_FILE.exec(entry.name);
    const day = match && Date.parse(match[1] + 'T00:00:00Z');
    if ((!match || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== match[1]) && !TEMP_FILE.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    try {
      const stat = await lstat(file);
      if (stat.isFile()) files.push({ name: entry.name, file, day: match ? day : null, archived: !!match?.[2], size: stat.size, mtimeMs: stat.mtimeMs });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function fingerprint(stream) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of stream) { hash.update(chunk); bytes += chunk.length; }
  return `${bytes}:${hash.digest('hex')}`;
}

async function sameArchive(source, archive) {
  const input = createReadStream(archive), gunzip = createGunzip();
  // pipeline owns source errors as well, so a disappearing archive cannot leave gunzip waiting forever.
  const transfer = pipeline(input, gunzip);
  try {
    const compressed = await fingerprint(gunzip);
    await transfer;
    return compressed === await fingerprint(createReadStream(source));
  } finally { await transfer.catch(() => {}); }
}

async function compress(file) {
  const archive = file + '.gz';
  try {
    const stat = await lstat(archive);
    if (!stat.isFile() || !(await sameArchive(file, archive))) throw Object.assign(new Error('archive conflict'), { code: 'ARCHIVE_CONFLICT' });
    // Recover a crash after publishing the archive but before removing its unchanged source.
    await unlink(file); return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(path.dirname(file), `.chat-archive-${randomUUID()}.tmp`);
  try {
    await pipeline(createReadStream(file), createGzip({ level: 1 }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    const handle = await open(temporary, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    // Exclusive publication: never overwrite a pre-existing archive. The original survives every earlier failure.
    await link(temporary, archive);
    await unlink(file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Caller serializes this with appends. Only recognized regular files directly inside the private directory change. */
export async function maintainChatLogs({ dir, now, compressAfterDays, retentionDays, onError }) {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const keepFrom = retentionDays ? today - (retentionDays - 1) * DAY_MS : -Infinity;
  const compressBefore = compressAfterDays ? today - (compressAfterDays - 1) * DAY_MS : -Infinity;
  for (const entry of await entries(dir)) {
    try {
      if (entry.day == null) {
        if (entry.mtimeMs < now - DAY_MS) await unlink(entry.file);
      } else if (entry.day < keepFrom) await unlink(entry.file);
      else if (!entry.archived && entry.day < compressBefore) await compress(entry.file);
    } catch (error) { onError(error); }
  }
  const disk = { files: 0, totalBytes: 0, plainFiles: 0, plainBytes: 0, archiveFiles: 0, archiveBytes: 0, temporaryFiles: 0, temporaryBytes: 0 };
  const plainNames = new Set();
  for (const entry of await entries(dir)) {
    disk.files++; disk.totalBytes += entry.size;
    if (entry.day == null) { disk.temporaryFiles++; disk.temporaryBytes += entry.size; }
    else if (entry.archived) { disk.archiveFiles++; disk.archiveBytes += entry.size; }
    else { disk.plainFiles++; disk.plainBytes += entry.size; plainNames.add(entry.name); }
  }
  return { disk, plainNames };
}
