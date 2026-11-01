// 取自 Stardust fork 的 server/persist/valkey.js（GPL-3.0-or-later，同本仓库），逐行照搬、仅注释与日志措辞随本仓。
// server/valkeyClient.js — 一个小的 Valkey / Redis 客户端（RESP2，TCP 或 TLS），给可选的 Valkey 持久化后端
// （server/valkeyState.js，docs/DEPLOY.md「断点续玩」）。零 npm 依赖：服务器只需要少数几条命令（GET、SET with PX、
// DEL、MGET、PING），且绝不能让存储拖慢对局，所以规则很简单：
//
//   * 一条连接，第一条命令时打开，失败后再开（退避 0.2 s → 5 s）；
//   * 连接不在服务时命令立即失败（UNAVAILABLE）——没有任何东西排在坏存储后面排队；只有连接尝试期间的命令
//     会等它（受 connectTimeoutMs 和 maxPending 约束）；
//   * 欠着回复的连接必须持续有进展：commandTimeoutMs 内一个字节都没来，这条流就不可再信，丢弃连接并让所有
//     在途命令失败。还在到达中的大回复（满员大厅的启动读，几十 MB）不算停滞；
//   * 回复解析是线性时间：完整的元素随到随取，bulk string 只在全部到齐后拼接一次；
//   * 还在把数据集读进内存的存储会回 `-LOADING …`（对连接的 PING 也一样）：这个回复有自己的错误码（LOADING），
//     绝不会当成拒密的 AUTH——启动读会等它过去（Persister 的 deferLoad / retryLoad）；
//   * URL 可带用户 / 密码（redis://user:pass@host:port/db；rediss:// 或 valkeys:// 走 TLS），或密码来自文件
//     （SP_VALKEY_PASSWORD_FILE，由 server/valkeyState.js 读入）——两者都不会被记进日志。

import net from 'node:net';
import tls from 'node:tls';

const CRLF = Buffer.from('\r\n');

export class ValkeyError extends Error {
  constructor(code, message = code) { super(message); this.name = 'ValkeyError'; this.code = code; }
}

/**
 * Parse a store URL. @param {string} raw
 * @returns {{ host: string, port: number, tls: boolean, username: string | null, password: string | null, db: number }}
 */
export function parseValkeyUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { throw new TypeError('invalid SP_VALKEY_URL'); }
  const scheme = url.protocol.replace(/:$/, '');
  if (!['redis', 'rediss', 'valkey', 'valkeys'].includes(scheme) || !url.hostname || url.search || url.hash) throw new TypeError('invalid SP_VALKEY_URL');
  const db = url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : 0;
  if (!Number.isInteger(db) || db < 0 || db > 255) throw new TypeError('invalid SP_VALKEY_URL database');
  const port = url.port ? Number(url.port) : 6379;
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port, tls: scheme === 'rediss' || scheme === 'valkeys',
    username: url.username ? decodeURIComponent(url.username) : null, password: url.password ? decodeURIComponent(url.password) : null, db };
}

/** RESP2 encoding of one command. @param {(string | Buffer | number)[]} args */
export function encodeCommand(args) {
  const parts = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
    parts.push(Buffer.from(`$${b.length}\r\n`), b, CRLF);
  }
  return Buffer.concat(parts);
}

/**
 * Incremental RESP2 reply parser. feed() takes a chunk and returns the complete replies (an error reply is a
 * ValkeyError value — code LOADING for `-LOADING …`, REPLY otherwise; bulk strings are Buffers; null bulk / array is null).
 * Linear in the bytes fed: an open array keeps the elements already parsed (`stack`), and while a bulk string of known
 * length is incomplete the chunks are only collected (`parts`), joined once it is all there.
 */
export class ReplyParser {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.pos = 0;
    /** @type {Buffer[]} chunks not yet joined to buf */
    this.parts = [];
    this.partsLength = 0;
    /** bytes needed from pos before the next element can be parsed */
    this.need = 0;
    /** @type {{ items: any[], left: number }[]} the open arrays, outermost first */
    this.stack = [];
  }

  feed(chunk) {
    this.parts.push(chunk);
    this.partsLength += chunk.length;
    const out = [];
    if (this.buf.length - this.pos + this.partsLength < this.need) return out;
    this.buf = this.pos < this.buf.length ? Buffer.concat([this.buf.subarray(this.pos), ...this.parts]) : this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
    this.pos = 0;
    this.parts = [];
    this.partsLength = 0;
    this.need = 0;
    for (;;) { // loop-cap: every pass consumes one element (or an array header) from the buffer, or stops
      const r = this.element();
      if (r === INCOMPLETE) break;
      let value = r;
      if (r instanceof ArrayHeader) {
        if (r.n > 0) { this.stack.push({ items: [], left: r.n }); continue; }
        value = r.n === 0 ? [] : null;
      }
      while (this.stack.length) { // loop-cap: every pass closes one open array
        const top = this.stack[this.stack.length - 1];
        top.items.push(value);
        if (--top.left > 0) { value = INCOMPLETE; break; }
        this.stack.pop();
        value = top.items;
      }
      if (value !== INCOMPLETE) out.push(value);
    }
    return out;
  }

  /** The next element at pos (consumed), an ArrayHeader, or INCOMPLETE (pos unchanged, `need` set). */
  element() {
    const buf = this.buf, at = this.pos;
    if (at >= buf.length) { this.need = 1; return INCOMPLETE; }
    const i = buf.indexOf(CRLF, at);
    if (i < 0) { this.need = buf.length - at + 1; return INCOMPLETE; }
    const type = buf[at], text = buf.toString('utf8', at + 1, i), next = i + 2;
    switch (type) {
      case 0x2b: this.pos = next; return text; // +
      case 0x2d: this.pos = next; return new ValkeyError(/^LOADING\b/.test(text) ? 'LOADING' : 'REPLY', text.slice(0, 200)); // -
      case 0x3a: this.pos = next; return Number(text); // :
      case 0x24: { // $
        const n = Number(text);
        if (!Number.isInteger(n)) throw new ValkeyError('PROTOCOL', 'bad bulk length');
        if (n < 0) { this.pos = next; return null; }
        if (buf.length < next + n + 2) { this.need = next + n + 2 - at; return INCOMPLETE; }
        this.pos = next + n + 2;
        return buf.subarray(next, next + n);
      }
      case 0x2a: { // *
        const n = Number(text);
        if (!Number.isInteger(n)) throw new ValkeyError('PROTOCOL', 'bad array length');
        this.pos = next;
        return new ArrayHeader(n);
      }
      default: throw new ValkeyError('PROTOCOL', 'unexpected reply type');
    }
  }
}

const INCOMPLETE = Symbol('incomplete');
class ArrayHeader { constructor(n) { this.n = n; } }

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

export class ValkeyClient {
  /**
   * @param {{ url: string, password?: string | null, log?: object, connectTimeoutMs?: number, commandTimeoutMs?: number,
   *   maxPending?: number, connect?: Function }} opts  `connect` (tests): (options) => a net.Socket-like stream
   */
  constructor({ url, password = null, log = noopLog, connectTimeoutMs = 2000, commandTimeoutMs = 3000, maxPending = 256, connect = null }) {
    this.target = parseValkeyUrl(url);
    if (password) this.target.password = password;
    this.log = log;
    this.connectTimeoutMs = connectTimeoutMs;
    this.commandTimeoutMs = commandTimeoutMs;
    this.maxPending = maxPending;
    this.connectFn = connect;
    this.socket = null;
    /** @type {{ resolve: Function, reject: Function }[]} replies the open connection still owes */
    this.inflight = [];
    /** the last time the stream made progress (a byte arrived, or a reply became owed on an idle stream) */
    this.progressAt = 0;
    this.watchdog = null;
    /** @type {{ args: any[], resolve: Function, reject: Function }[]} commands waiting for the connection attempt */
    this.waiting = [];
    this.state = 'idle'; // idle | connecting | ready | closed
    this.retryAt = 0;
    this.backoffMs = 200;
    this.connecting = null;
    this.stats = { connects: 0, failures: 0, commands: 0, errors: 0 };
    this.warnedAt = -Infinity;
  }

  get ready() { return this.state === 'ready'; }

  /** One command. @returns {Promise<any>} the reply; rejects with ValkeyError (UNAVAILABLE, TIMEOUT, LOADING, REPLY, …) */
  command(...args) {
    if (this.state === 'closed') return Promise.reject(new ValkeyError('CLOSED'));
    this.stats.commands++;
    if (this.state === 'ready') return this.send(args);
    if (this.state === 'idle') {
      if (Date.now() < this.retryAt) return Promise.reject(new ValkeyError('UNAVAILABLE'));
      this.open();
    }
    if (this.waiting.length >= this.maxPending) return Promise.reject(new ValkeyError('UNAVAILABLE'));
    return new Promise((resolve, reject) => this.waiting.push({ args, resolve, reject }));
  }

  send(args) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.state !== 'ready' && this.state !== 'connecting') { reject(new ValkeyError('UNAVAILABLE')); return; }
      if (!this.inflight.length) this.progressAt = Date.now();
      this.inflight.push({ resolve, reject });
      this.watch();
      try { this.socket.write(encodeCommand(args)); } catch { this.drop(new ValkeyError('UNAVAILABLE')); }
    });
  }

  /** Drop the connection once it owes a reply and nothing has arrived for commandTimeoutMs. */
  watch() {
    if (this.watchdog || !this.inflight.length) return;
    const left = this.progressAt + this.commandTimeoutMs - Date.now();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (!this.inflight.length) return;
      if (Date.now() - this.progressAt >= this.commandTimeoutMs) this.drop(new ValkeyError('TIMEOUT'));
      else this.watch();
    }, Math.max(1, left));
    this.watchdog.unref?.();
  }

  open() {
    this.state = 'connecting';
    const t = this.target;
    const parser = new ReplyParser();
    let socket;
    try {
      socket = this.connectFn ? this.connectFn(t)
        : t.tls ? tls.connect({ host: t.host, port: t.port, servername: net.isIP(t.host) ? undefined : t.host })
          : net.connect({ host: t.host, port: t.port });
    } catch { this.fail(new ValkeyError('UNAVAILABLE')); return; }
    this.socket = socket;
    socket.setNoDelay?.(true);
    const timer = setTimeout(() => { if (this.socket === socket && this.state === 'connecting') this.drop(new ValkeyError('UNAVAILABLE')); }, this.connectTimeoutMs);
    timer.unref?.();
    socket.on('data', (chunk) => {
      if (this.socket !== socket) return;
      this.progressAt = Date.now();
      let replies;
      try { replies = parser.feed(chunk); } catch (e) { this.drop(e); return; }
      for (const value of replies) {
        const entry = this.inflight.shift();
        if (!entry) { this.drop(new ValkeyError('PROTOCOL', 'unexpected reply')); return; }
        if (value instanceof ValkeyError) { this.stats.errors++; entry.reject(value); } else entry.resolve(value);
      }
    });
    socket.on('error', () => { if (this.socket === socket) this.drop(new ValkeyError('UNAVAILABLE')); });
    socket.on('close', () => { if (this.socket === socket) this.drop(new ValkeyError('UNAVAILABLE')); });
    socket.once(t.tls ? 'secureConnect' : 'connect', async () => {
      if (this.socket !== socket) return;
      try {
        if (t.password) await this.send(t.username ? ['AUTH', t.username, t.password] : ['AUTH', t.password]);
        if (t.db) await this.send(['SELECT', t.db]);
        await this.send(['PING']);
      } catch (e) {
        if (this.socket === socket) this.drop(e instanceof ValkeyError && e.code === 'REPLY' ? new ValkeyError('AUTH') : e);
        return;
      }
      if (this.socket !== socket) return;
      clearTimeout(timer);
      this.state = 'ready';
      this.backoffMs = 200;
      this.stats.connects++;
      const waiting = this.waiting; this.waiting = [];
      for (const w of waiting) this.send(w.args).then(w.resolve, w.reject);
    });
  }

  /** The connection failed or can no longer be trusted: fail everything it owes and back off. */
  drop(error) {
    const socket = this.socket;
    this.socket = null;
    try { socket?.destroy(); } catch { /* already gone */ }
    clearTimeout(this.watchdog); this.watchdog = null;
    const inflight = this.inflight; this.inflight = [];
    for (const e of inflight) e.reject(error);
    this.fail(error);
  }

  fail(error) {
    if (this.state === 'closed') return;
    this.stats.failures++;
    this.state = 'idle';
    this.retryAt = Date.now() + this.backoffMs;
    this.backoffMs = Math.min(5000, this.backoffMs * 2);
    const waiting = this.waiting; this.waiting = [];
    for (const w of waiting) w.reject(error);
    const now = Date.now();
    if (now - this.warnedAt > 60_000) {
      this.warnedAt = now;
      try { this.log.warn?.(`[persist] 存储不可用（${error?.code || 'error'}）：在它恢复应答之前检查点跳过`); } catch { /* logging only */ }
    }
  }

  async close() {
    if (this.state === 'closed') return;
    const socket = this.socket;
    this.state = 'closed';
    this.socket = null;
    clearTimeout(this.watchdog); this.watchdog = null;
    const inflight = this.inflight; this.inflight = [];
    for (const e of inflight) e.reject(new ValkeyError('CLOSED'));
    for (const w of this.waiting) w.reject(new ValkeyError('CLOSED'));
    this.waiting = [];
    if (socket) await new Promise((resolve) => { socket.once('close', resolve); try { socket.end(); } catch { resolve(); } setTimeout(() => { try { socket.destroy(); } catch { /* gone */ } resolve(); }, 500).unref?.(); });
  }
}
