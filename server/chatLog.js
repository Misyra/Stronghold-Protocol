// i18n-ignore-file: private server-side chat audit log; never sent to players.
import { within } from './pathSafety.js';
import { appendFile, mkdir, readdir } from 'node:fs/promises';
import { createReadStream, realpathSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logDays, maintainChatLogs } from './chatLogArchive.js';

export const DEFAULT_CHAT_LOG_DIR = fileURLToPath(new URL('../.state/chat-logs/', import.meta.url));
const MAX_PENDING = 10000;
const BATCH_SIZE = 100;
const MAX_WRITE_ATTEMPTS = 3;
const DAY_MS = 86400000;
// 单次回看最多跨多少天。房间不可能比保留窗更老（更早的日志早被 chatLogArchive 删掉了），所以超过这一段的只读
// 最近的这几天，并把 partial 立起来：让面板知道「更早的那部分读不到」，比让它以为这就是全部便宜得多。
const MAX_HISTORY_DAYS = 31;

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

/**
 * 逐行读一个审计文件（明文或 .gz），不整份读进内存 —— 一天的文件可能是几 MB，而调用方只要最近的那几条。
 * 按块解码而不是 `chunk.toString()`：一个中文字被切在两个块之间就会变成两个替换符，而房名、昵称、消息正文
 * 恰恰全是中文。末尾没有换行的那一行照样交出去（进程崩在写一半的现场，解析失败由调用方一笔勾掉）。
 */
async function eachLine(file, onLine) {
  const source = createReadStream(file);
  const gz = file.endsWith('.gz');
  const stream = gz ? source.pipe(createGunzip()) : source;
  // pipe 不负责把源头的错误送到下游：不转这一次，读一个没权限的文件会安静地等到天荒地老。
  if (gz) source.once('error', (error) => stream.destroy(error));
  try {
    const decoder = new StringDecoder('utf8');
    let buffered = '';
    for await (const chunk of stream) {
      buffered += decoder.write(chunk);
      let index;
      while ((index = buffered.indexOf('\n')) !== -1) {
        onLine(buffered.slice(0, index));
        buffered = buffered.slice(index + 1);
      }
    }
    buffered += decoder.end();
    if (buffered) onLine(buffered);
  } finally {
    stream.destroy();
    source.destroy();
  }
}

/** Serialized, bounded asynchronous appends; daily files use UTC, like the recorded timestamps. */
export class ChatLog {
  /** @param {{ dir?: string, publicDirs?: string[], log?: { error: Function, warn?: Function }, compressAfterDays?: number|string,
   * retentionDays?: number|string, now?: () => number }} [options] */
  constructor({ dir = DEFAULT_CHAT_LOG_DIR, publicDirs = [], log = console, compressAfterDays, retentionDays, now = Date.now } = {}) {
    this.dir = path.resolve(dir || DEFAULT_CHAT_LOG_DIR);
    this.publicDirs = publicDirs.map(root => path.resolve(root));
    this.checkPrivate();
    this.log = log;
    this.compressAfterDays = logDays(compressAfterDays, 'SP_CHAT_LOG_COMPRESS_AFTER_DAYS', 1);
    this.retentionDays = logDays(retentionDays, 'SP_CHAT_LOG_RETENTION_DAYS', 30);
    if (this.retentionDays === 0) this.log.warn?.('[chat-log] permanent retention explicitly enabled');
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
    this.retries = 0;
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
    if (this.closed || this.queue.length + this.writing >= MAX_PENDING) {
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
          this.retries = 0;
          if (this.disk) {
            if (!this.plainNames.has(name)) { this.plainNames.add(name); this.disk.files++; this.disk.plainFiles++; }
            const bytes = Buffer.byteLength(body); this.disk.totalBytes += bytes; this.disk.plainBytes += bytes;
          }
        } catch (error) {
          this.ready = false;
          if (++this.retries < MAX_WRITE_ATTEMPTS) this.queue.unshift(...batch);
          else { this.retries = 0; this.reportFailure(batch.length, error.code || error.message); }
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

  /**
   * 一间房在**当前这个实例**里说过的话，从盘上读回来（运维面板的只读回看用）。
   *
   * 写法由三件事决定：
   *   1) 房间码会被复用，所以「哪几条算这间房」只能靠实例边界判 —— `since` 传房间的 createdAt（毫秒），
   *      而不是靠码去猜；比它更早的同码记录属于上一间房，交出去就是栽赃。
   *   2) 只为「最新 limit 条」把整天的文件攒进内存没有意义：边读边丢更早的那条，丢过就把 truncated 立起来。
   *   3) 读不出来不是故障，是这份回答不完整：任何 IO 失败都折成 partial:true 返回，绝不往请求路径上抛 ——
   *      面板那边还有房间自己的环形缓冲能交差，让一次读盘失败把整条链路变成 500 才是真的丢信息。
   * @param {{ code: string, since: number, limit?: number, now?: number }} query
   * @returns {Promise<{ messages: { at: number, ip: string|null, playerId: string, name: string, text: string }[],
   *   truncated: boolean, partial: boolean }>} messages 按 at 升序，最多 limit 条；截断时丢的是最旧的那些
   */
  async roomRecords({ code, since, limit = 100, now = this.now() }) {
    const wanted = typeof code === 'string' ? code.toUpperCase() : '';
    const max = Math.min(200, Math.max(1, Number.isSafeInteger(limit) ? limit : 100));
    const sinceMs = Number.isFinite(since) ? since : 0;
    const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
    let fromDay = Math.floor(Math.min(sinceMs, now) / DAY_MS) * DAY_MS;
    let partial = false;
    const days = Math.min(MAX_HISTORY_DAYS, this.retentionDays > 0 ? this.retentionDays : MAX_HISTORY_DAYS);
    if (todayStart - fromDay >= days * DAY_MS) {
      fromDay = todayStart - (days - 1) * DAY_MS;
      partial = true;
    }
    let names;
    try { names = new Set(await readdir(this.dir)); }
    // 目录不存在（还没有任何聊天）与读不了（权限、被一个同名文件占了位置）在调用方眼里是同一件事：这份回答只剩
    // 内存里的那一段。
    catch { return { messages: [], truncated: false, partial: true }; }
    const messages = [];
    let truncated = false;
    for (let day = fromDay; day <= todayStart; day += DAY_MS) {
      const key = new Date(day).toISOString().slice(0, 10);
      const plain = `${key}.jsonl`, archive = `${key}.jsonl.gz`;
      // 明文优先：它是正在追加的那一份。压缩完成与删除明文之间有个很短的窗口，那份文件可能刚好消失，所以
      // 留 gz 当退路；已经读进来的行绝不重读另一份，不然同一条消息会出现两次。
      const candidates = [plain, archive].filter((name) => names.has(name));
      if (!candidates.length) {
        // 今天还没有文件是正常的：要么今天还没人说话，要么那几条还在内存里（环形缓冲兜得住）。更早的日期没有
        // 文件就只能是丢了 —— 那天的聊天记录再也补不回来。
        if (day !== todayStart) partial = true;
        continue;
      }
      let matched = 0, ok = false;
      for (const name of candidates) {
        const file = path.join(this.dir, name);
        try {
          await eachLine(file, (line) => {
            let record;
            // 写一半崩掉的那行不算数；坏一行不能连累它后面的那些。
            try { record = JSON.parse(line); } catch { return; }
            if (!record || record.roomCode !== wanted) return;
            const at = Date.parse(record.at);
            if (!Number.isFinite(at) || at < sinceMs) return;
            messages.push({ at, ip: record.ip ?? null, playerId: record.playerId, name: record.name, text: record.text });
            matched++;
            if (messages.length > max) { messages.shift(); truncated = true; }
          });
          ok = true; break;
        } catch { if (matched) break; }
      }
      if (!ok) partial = true;
    }
    return { messages, truncated, partial };
  }

  async flush() {
    while (this.pending || this.maintenance) await Promise.all([this.pending, this.maintenance]);
  }
  async close() { clearInterval(this.timer); this.closed = true; await this.flush(); }
}
