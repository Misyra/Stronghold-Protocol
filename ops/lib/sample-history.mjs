import fs from 'node:fs';
import path from 'node:path';
import { readLogBatch } from './collector-utils.mjs';
import { sanitizeMetrics } from './metrics.mjs';
import { integer } from './http.mjs';

const filename = /^samples-\d{4}-\d\d-\d\d\.jsonl$/;
const invalid = () => Object.assign(new Error('Invalid sample cursor'), { code: 'INVALID_CURSOR' });
export function decodeSampleCursor(value) {
  if (value == null || value === '') return null;
  try {
    if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!filename.test(cursor.file) || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 ||
      !((typeof cursor.ino === 'string' && /^[0-9]{1,30}$/.test(cursor.ino)) || (Number.isInteger(cursor.ino) && cursor.ino >= 0))) throw invalid();
    return cursor;
  } catch { throw invalid(); }
}
export function sampleHistory(dir, { cursor: encoded, limit = 200 } = {}) {
  limit = integer(limit, 200, 1, 200);
  const cursor = decodeSampleCursor(encoded);
  const files = fs.readdirSync(dir).filter(f => filename.test(f)).sort();
  const records = []; let next = cursor, scanned = 0, gap = false, hasMore = false;
  if (cursor && files.length && (!files.includes(cursor.file) || fs.statSync(path.join(dir, cursor.file)).size < cursor.offset)) gap = true;
  for (const file of files) {
    if (cursor && file < cursor.file) continue;
    if (records.length >= limit || scanned >= 1024 * 1024) { hasMore = true; break; }
    const stat = fs.statSync(path.join(dir, file));
    const checkpoint = cursor?.file === file ? { offset: cursor.offset, ino: Number(cursor.ino), inoKey: String(cursor.ino) } : { offset: 0, ino: stat.ino };
    if (cursor?.file === file && String(cursor.ino) !== String(fs.statSync(path.join(dir, file), { bigint: true }).ino)) gap = true;
    const batch = readLogBatch(path.join(dir, file), checkpoint, { maxLines: limit - records.length, maxBytes: 1024 * 1024 - scanned });
    scanned += batch.offset - ((checkpoint.inoKey ? batch.inoKey === checkpoint.inoKey : batch.ino === checkpoint.ino) && checkpoint.offset <= stat.size ? checkpoint.offset : 0);
    for (const line of batch.lines) {
      let row;
      try { row = JSON.parse(line); } catch { throw Object.assign(new Error('Corrupt sample log'), { code: 'INVALID_RESPONSE' }); }
      const metadata = row.monitor || {};
      records.push(sanitizeMetrics({ ...metadata, current: row, today: metadata.today || {}, history: [], series: [] }));
    }
    next = { file, offset: batch.offset, ino: batch.inoKey };
    if (batch.offset < stat.size) { hasMore = true; break; }
  }
  return { schemaVersion: 1, records, nextCursor: next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null,
    hasMore, gap, oldestDate: files[0]?.slice(8, 18) || null };
}

// Retry transient disk failures. Repair an interrupted final line before appending, and
// rollback a partial write to its previous length so replay cursors always see complete JSON.
export class SampleWriter {
  constructor(dir, maxPending = 18000) { this.dir = dir; this.maxPending = maxPending; this.pending = []; this.dropped = 0; }
  enqueue(file, row) {
    if (!filename.test(file)) throw new Error('Invalid sample filename');
    if (this.pending.length >= this.maxPending) { this.pending.shift(); this.dropped++; console.error('[monitor] sample retry buffer full; oldest sample lost'); }
    this.pending.push({ file, line: JSON.stringify(row) + '\n' });
  }
  flush() {
    while (this.pending.length) {
      const file = this.pending[0].file; let count = 0, bytes = 0;
      while (count < this.pending.length && this.pending[count].file === file && bytes < 4 * 1024 * 1024) {
        bytes += Buffer.byteLength(this.pending[count].line); count++;
      }
      let fd;
      try { fd = fs.openSync(path.join(this.dir, file), 'r+'); } catch (error) {
        if (error.code !== 'ENOENT') throw error; fd = fs.openSync(path.join(this.dir, file), 'wx+');
      }
      try {
        let size = fs.fstatSync(fd).size;
        if (size) {
          const last = Buffer.alloc(1); fs.readSync(fd, last, 0, 1, size - 1);
          if (last[0] !== 10) {
            const len = Math.min(size, 4 * 1024 * 1024), tail = Buffer.alloc(len);
            fs.readSync(fd, tail, 0, len, size - len);
            const end = tail.lastIndexOf(10);
            if (end < 0 && len < size) throw new Error('Sample tail exceeds recovery budget');
            size = end < 0 ? 0 : size - len + end + 1; fs.ftruncateSync(fd, size);
          }
        }
        try {
          const data = Buffer.from(this.pending.slice(0, count).map(item => item.line).join(''));
          let written = 0;
          while (written < data.length) { const n = fs.writeSync(fd, data, written, data.length - written, size + written); if (!n) throw new Error('Incomplete sample write'); written += n; }
          fs.fsyncSync(fd);
        }
        catch (error) { try { fs.ftruncateSync(fd, size); } catch {} throw error; }
      } finally { fs.closeSync(fd); }
      this.pending.splice(0, count);
    }
  }
}
