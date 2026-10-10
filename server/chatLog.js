// i18n-ignore-file: private server-side chat audit log; never sent to players.
import { appendFile, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  /** @param {{ dir?: string, publicDirs?: string[], log?: { error: Function } }} [options] */
  constructor({ dir = DEFAULT_CHAT_LOG_DIR, publicDirs = [], log = console } = {}) {
    this.dir = path.resolve(dir || DEFAULT_CHAT_LOG_DIR);
    this.publicDirs = publicDirs.map(root => path.resolve(root));
    this.checkPrivate();
    this.log = log;
    /** @type {{ day: string, line: string }[]} */
    this.queue = [];
    /** @type {Promise<void> | null} */
    this.pending = null;
    this.ready = false;
    this.closed = false;
    this.failed = 0;
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
    if (!this.pending) this.pending = this.drain();
    return true;
  }

  async drain() {
    try {
      while (this.queue.length) {
        const day = this.queue[0].day;
        let count = 1;
        while (count < BATCH_SIZE && count < this.queue.length && this.queue[count].day === day) count++;
        const batch = this.queue.splice(0, count);
        try {
          if (!this.ready) {
            await mkdir(this.dir, { recursive: true, mode: 0o700 });
            this.checkPrivate();
            this.ready = true;
          }
          await appendFile(path.join(this.dir, `${day}.jsonl`), batch.map(item => item.line).join(''), { encoding: 'utf8', mode: 0o600 });
        } catch (error) {
          this.ready = false;
          this.reportFailure(batch.length, error.code || error.message);
        }
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

  async flush() { await this.pending; }
  async close() { this.closed = true; await this.flush(); }
}
