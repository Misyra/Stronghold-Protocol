// i18n-ignore-file: private server-side chat audit log; never sent to players.
import { appendFile, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logDays, maintainChatLogs } from './chatLogArchive.js';

export const DEFAULT_CHAT_LOG_DIR = fileURLToPath(new URL('../.state/chat-logs/', import.meta.url));
const MAX_PENDING = 10000;
const BATCH_SIZE = 100;

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Resolve existing parent links even when the final log directory has not been created yet. */
function realLocation(location) {
  const suffix = [];
  let current = location;
  while (true) {
    try { return path.join(realpathSync(current), ...suffix); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current)); current = parent;
    }
  }
}

/** Serialized, bounded asynchronous appends; daily files use UTC, like the recorded timestamps. */
export class ChatLog {
  /** @param {{ dir?: string, publicDirs?: string[], log?: { error: Function }, compressAfterDays?: number|string,
   * retentionDays?: number|string, now?: () => number }} [options] */
  constructor({ dir = DEFAULT_CHAT_LOG_DIR, publicDirs = [], log = console, compressAfterDays, retentionDays, now = Date.now } = {}) {
    this.dir = path.resolve(dir || DEFAULT_CHAT_LOG_DIR);
    this.publicDirs = publicDirs.map(root => path.resolve(root));
    this.checkPrivate();
    this.log = log;
    this.compressAfterDays = logDays(compressAfterDays, 'SP_CHAT_LOG_COMPRESS_AFTER_DAYS', 1);
    this.retentionDays = logDays(retentionDays, 'SP_CHAT_LOG_RETENTION_DAYS', 0);
    this.now = now;
    this.maintenance = null;
    this.timer = null;
    this.disk = null;
    this.plainNames = new Set();
    this.maintenanceFailures = 0;
    this.lastMaintenanceAt = null;
    this.lastMaintenanceErrorAt = -Infinity;
    /** @type {{ day: string, line: string }[]} */
    this.queue = [];
    /** @type {Promise<void> | null} */
    this.pending = null;
    this.ready = false;
    this.closed = false;
    this.failed = 0;
    this.writing = 0;
    this.lastErrorAt = -Infinity;
  }

  checkPrivate() {
    const realDir = realLocation(this.dir);
    for (const root of this.publicDirs) {
      if (within(root, this.dir) || within(realLocation(root), realDir)) {
        throw new Error('SP_CHAT_LOG_DIR must be outside public static and content-pack directories');
      }
    }
  }

  /** The caller supplies server-confirmed identity and the original accepted text, before masking or trimming.
   * @param {{ at: number, ip: string, playerId: string, name: string, roomCode: string, text: string }} record
   */
  record(record) {
    if (this.closed || this.queue.length >= MAX_PENDING) {
      this.reportFailure(1, 'log is closed or the pending queue is full');
      return false;
    }
    const at = new Date(record.at).toISOString();
    this.queue.push({ day: at.slice(0, 10), line: JSON.stringify({ at, ip: record.ip, playerId: record.playerId,
      name: record.name, roomCode: record.roomCode, text: record.text }) + '\n' });
    if (!this.pending && !this.maintenance) this.pending = this.drain();
    return true;
  }

  async drain() {
    try {
      while (this.queue.length) {
        const day = this.queue[0].day;
        let count = 1;
        while (count < BATCH_SIZE && count < this.queue.length && this.queue[count].day === day) count++;
        const batch = this.queue.splice(0, count);
        this.writing = batch.length;
        try {
          if (!this.ready) {
            await mkdir(this.dir, { recursive: true, mode: 0o700 });
            this.checkPrivate();
            this.ready = true;
          }
          const name = `${day}.jsonl`, body = batch.map(item => item.line).join('');
          await appendFile(path.join(this.dir, name), body, { encoding: 'utf8', mode: 0o600 });
          if (this.disk) {
            if (!this.plainNames.has(name)) { this.plainNames.add(name); this.disk.files++; this.disk.plainFiles++; }
            const bytes = Buffer.byteLength(body); this.disk.totalBytes += bytes; this.disk.plainBytes += bytes;
          }
        } catch (error) {
          this.ready = false;
          this.reportFailure(batch.length, error.code || error.message);
        } finally { this.writing = 0; }
      }
    } finally { this.pending = null; }
  }

  reportFailure(count, reason) {
    this.failed += count;
    const now = Date.now();
    if (now - this.lastErrorAt >= 10000) {
      this.lastErrorAt = now;
      // Never include the message, IP, nickname or reconnect token in console diagnostics.
      this.log.error(`[chat-log] ${this.failed} records could not be written (${reason})`);
    }
  }

  /** Background scans never run in the request path or concurrently with a log append. */
  start() {
    if (this.closed || this.timer) return;
    void this.maintain();
    this.timer = setInterval(() => { void this.maintain(); }, 3600000);
    this.timer.unref();
  }

  maintain() {
    if (this.maintenance) return this.maintenance.then(() => this.stats());
    if (this.closed) return Promise.resolve(this.stats());
    const appends = this.pending;
    this.maintenance = (async () => {
      await appends;
      try {
        this.checkPrivate();
        const { disk, plainNames } = await maintainChatLogs({ dir: this.dir, now: this.now(),
          compressAfterDays: this.compressAfterDays, retentionDays: this.retentionDays, onError: error => this.reportMaintenanceFailure(error) });
        this.disk = disk; this.plainNames = plainNames;
        this.lastMaintenanceAt = new Date(this.now()).toISOString();
      } catch (error) { this.reportMaintenanceFailure(error); }
    })().finally(() => {
      this.maintenance = null;
      if (this.queue.length && !this.pending) this.pending = this.drain();
    });
    return this.maintenance.then(() => this.stats());
  }

  reportMaintenanceFailure(error) {
    this.maintenanceFailures++;
    if (this.now() - this.lastMaintenanceErrorAt >= 10000) {
      this.lastMaintenanceErrorAt = this.now();
      this.log.error(`[chat-log] archive maintenance failed (${error.code || 'IO_ERROR'}); log files retained`);
    }
  }

  stats() {
    return { ...(this.disk || { files: null, totalBytes: null, plainFiles: null, plainBytes: null,
      archiveFiles: null, archiveBytes: null, temporaryFiles: null, temporaryBytes: null }),
    pendingRecords: this.queue.length + this.writing, droppedRecords: this.failed, maintenanceFailures: this.maintenanceFailures,
    compressAfterDays: this.compressAfterDays, retentionDays: this.retentionDays, lastMaintenanceAt: this.lastMaintenanceAt };
  }

  async flush() {
    while (this.pending || this.maintenance) await Promise.all([this.pending, this.maintenance]);
  }
  async close() { clearInterval(this.timer); this.closed = true; await this.flush(); }
}
