// Atomic, single-process state storage. Kept outside every HTTP static mount.
//
// Two on-disk layouts, chosen by the state path (docs/operations/PERSISTENCE.md):
//   * file — one JSON document (a path ending in .json, or an existing plain file). The classic layout: rewritten
//            atomically (tmp → fsync → rename) on every save. Right for the usual handful of rooms.
//   * dir  — index.json holds sessions/rooms; runtime.json holds clocks and the last durable heartbeat. Each match
//            has a matches/<CODE>.json shard, written only when its body changes. Clock-only refreshes never rewrite
//            the index or shards. A shard includes its initial clocks and a revision: if a save stops before runtime
//            commits, recovery uses the shard's own clocks instead of an older round's runtime clocks. Old directory
//            and sibling `<dir>.state.json` layouts are read and upgraded on the next save.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SHARD_SUFFIX = '.json';
const DIRECTORY_LAYOUT = 2;

/** Only stable metadata participates in the index dirty check; clocks/heartbeat have their own small file. */
function indexMetadata(index) {
  const { savedAt, clocks, matches, layout, revision, ...rest } = index;
  return rest;
}

function canonicalIndex(index) {
  return JSON.stringify(indexMetadata(index));
}

export class FileStateStore {
  constructor({ file, log = console }) {
    this.file = path.resolve(file);
    this.log = log;
    this.kind = 'file';
    this.label = this.file;
    this.lockToken = randomUUID();
    this.locked = false;
    this.saved = 0;
    this.pending = Promise.resolve();
    this.closed = false;
    this.mode = null;          // resolved once, on first use: 'file' | 'dir'
    /** dir mode: exactly what is on disk per room code — the shard dirty check. */
    this.shards = new Map();
    /** The shard revision and match generation on disk; unchanged bodies retain their revision. */
    this.shardRevisions = new Map();
    this.shardWrites = 0;
    /** dir mode: the index on disk, canonicalized (savedAt stripped — it stamps the last actual write). */
    this.indexCommit = null;
    this.indexRevision = null;
    this.indexWrites = 0;
    this.runtimeCommit = null;
    this.runtimeWrites = 0;
  }

  async resolveMode() {
    if (this.mode) return this.mode;
    if (this.file.endsWith(SHARD_SUFFIX)) {
      this.mode = 'file';
    } else {
      let st = null;
      try { st = await fs.stat(this.file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      this.mode = st && !st.isDirectory() ? 'file' : 'dir';
    }
    if (this.mode === 'dir') {
      this.dir = this.file;
      this.indexFile = path.join(this.dir, 'index.json');
      this.runtimeFile = path.join(this.dir, 'runtime.json');
      this.matchesDir = path.join(this.dir, 'matches');
      this.lockFile = path.join(this.dir, 'state.lock');
      this.label = `${this.file} (sharded)`;
    } else {
      this.lockFile = `${this.file}.lock`;
    }
    return this.mode;
  }

  async acquire() {
    if (this.locked) return;
    const mode = await this.resolveMode();
    await fs.mkdir(mode === 'dir' ? this.matchesDir : path.dirname(this.file), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 3; attempt++) {
      let handle;
      try {
        handle = await fs.open(this.lockFile, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, token: this.lockToken }));
        await handle.close();
        this.locked = true;
        return;
      } catch (err) {
        await handle?.close().catch(() => {});
        if (err.code !== 'EEXIST') throw err;
        const raw = await fs.readFile(this.lockFile, 'utf8');
        let owner;
        try { owner = JSON.parse(raw); } catch { throw new Error('状态文件锁损坏，请确认没有其他游戏进程后移除锁文件'); }
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('状态文件锁无效');
        try { process.kill(owner.pid, 0); throw new Error('状态文件正被其他游戏进程使用，请为每个站点指定不同 SP_STATE_FILE'); }
        catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
        // Only reclaim the exact stale lock that was examined.
        if (await fs.readFile(this.lockFile, 'utf8') === raw) await fs.unlink(this.lockFile);
      }
    }
    throw new Error('无法取得状态文件锁');
  }

  async load() {
    await this.acquire();
    if (this.mode === 'dir') return this.loadSharded();
    let raw;
    try { raw = await fs.readFile(this.file, 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    try {
      const doc = JSON.parse(raw);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('invalid document');
      return doc;
    } catch { throw new Error('状态文件损坏，已保留原文件；请从备份恢复后再启动'); }
  }

  /** dir mode: the index plus every shard of a room the index still knows. */
  async loadSharded() {
    let index;
    try {
      index = JSON.parse(await fs.readFile(this.indexFile, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return this.loadLegacySibling();
      throw new Error('状态文件损坏，已保留原文件；请从备份恢复后再启动');
    }
    if (!index || typeof index !== 'object' || Array.isArray(index)) {
      throw new Error('状态文件损坏，已保留原文件；请从备份恢复后再启动');
    }
    if (index.layout != null && index.layout !== DIRECTORY_LAYOUT) throw new Error('状态文件存储格式不兼容，已保留原文件');
    if (index.layout === DIRECTORY_LAYOUT && (typeof index.revision !== 'string' || !index.revision)) {
      throw new Error('状态文件损坏，已保留原文件；索引缺少版本标记');
    }
    // Force a metadata write when upgrading the old directory layout, even if no rooms changed.
    this.indexCommit = index.layout === DIRECTORY_LAYOUT ? canonicalIndex(index) : null;
    this.indexRevision = index.revision || null;
    let runtime = null;
    if (index.layout === DIRECTORY_LAYOUT) {
      try {
        const raw = await fs.readFile(this.runtimeFile, 'utf8');
        runtime = JSON.parse(raw);
        if (!runtime || runtime.v !== 1 || !Number.isFinite(runtime.savedAt)
          || typeof runtime.indexRevision !== 'string' || !runtime.clocks || typeof runtime.clocks !== 'object'
          || Array.isArray(runtime.clocks)) throw new Error('invalid runtime');
        this.runtimeCommit = raw;
      } catch (err) {
        // A crash after the index write but before the first runtime write is recoverable from shard-local clocks.
        if (err.code !== 'ENOENT') throw new Error('状态运行时文件损坏，已保留原文件；请从备份恢复后再启动');
      }
    }
    const runtimeMatches = runtime && runtime.indexRevision === this.indexRevision;
    const legacyClocks = index.clocks && typeof index.clocks === 'object' ? index.clocks : {};
    const clocks = {};
    const rooms = new Map((Array.isArray(index.rooms) ? index.rooms : []).filter((r) => r?.code).map((r) => [r.code, r]));
    const matches = {};
    this.shards.clear();
    this.shardRevisions.clear();
    let files = [];
    try { files = await fs.readdir(this.matchesDir); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    for (const name of files) {
      if (!name.endsWith(SHARD_SUFFIX)) continue;
      const code = name.slice(0, -SHARD_SUFFIX.length);
      const shardFile = path.join(this.matchesDir, name);
      const room = rooms.get(code);
      if (!room || room.hasMatch === false) {
        // the room closed (or the index rolled back) after the shard was written
        await fs.unlink(shardFile).catch(() => {});
        continue;
      }
      let raw;
      let body;
      try {
        raw = await fs.readFile(shardFile, 'utf8');
        body = JSON.parse(raw);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid shard');
      } catch {
        this.log.warn?.(`[persist] ${code}: shard unreadable, the room restores without its match`);
        continue;
      }
      let c = legacyClocks[code];
      if (body.storage === 1) {
        const envelope = body;
        body = envelope.checkpoint;
        if (!body || typeof body !== 'object' || Array.isArray(body) || typeof envelope.revision !== 'string') {
          this.log.warn?.(`[persist] ${code}: invalid shard envelope, the room restores without its match`);
          continue;
        }
        // An index write may not have committed the start of a new match in the same room yet.
        if ((envelope.matchCount ?? null) !== (room.matchCount ?? null)) continue;
        this.shardRevisions.set(code, { revision: envelope.revision, matchCount: room.matchCount });
        this.shards.set(code, JSON.stringify(body));
        const fresh = runtimeMatches && runtime.clocks[code];
        c = fresh && fresh.revision === envelope.revision ? fresh : envelope.clocks;
      } else {
        this.shards.set(code, raw);                  // legacy, clock-free shard; upgraded on the next save
      }
      if (c && typeof c === 'object') clocks[code] = c;
      if (c && Number.isFinite(c.deadlineRemainingMs)) body.deadlineRemainingMs = c.deadlineRemainingMs;
      if (c && Number.isFinite(c.startedAtAgoMs)) body.startedAtAgoMs = c.startedAtAgoMs;
      matches[code] = body;
    }
    // restoreServer uses this timestamp only for previously connected identities. Real disconnect times stay intact.
    const savedAt = runtimeMatches ? Math.max(Number(index.savedAt) || 0, runtime.savedAt) : index.savedAt;
    return { ...index, savedAt, clocks, matches };
  }

  /** The pre-sharding default layout was a single file next to what is now the directory. */
  async loadLegacySibling() {
    const legacy = `${this.file}.state.json`;
    let raw;
    try { raw = await fs.readFile(legacy, 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    try {
      const doc = JSON.parse(raw);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('invalid document');
      this.log.info?.(`[persist] migrating legacy state file ${legacy} into ${this.dir}`);
      return doc;
    } catch { throw new Error('状态文件损坏，已保留原文件；请从备份恢复后再启动'); }
  }

  save(doc) {
    if (this.closed) return Promise.resolve(false);
    // Serialize writes, including a final write submitted while an interval write is still running.
    const work = async () => {
      await this.acquire();
      if (this.mode === 'dir') return this.runShardedWrite(this.shardedPayloadFromDoc(doc));
      try {
        await this.writeAtomic(this.file, JSON.stringify(doc));
        this.saved++;
        return true;
      } catch (err) {
        this.log.warn?.('[persist] state file save failed', err.message);
        return false;
      }
    };
    const result = this.pending.then(work, work);
    this.pending = result.catch(() => false);
    return result;
  }

  /**
   * dir mode entry point. `shards` is the full current set of clock-free checkpoint bodies (JSON text) keyed by room
   * code; only shards whose text differs from what is on disk are rewritten. A single-file store accepts the same
   * payload and merges it back into the classic one-file document — callers need not know which layout is in use.
   * @param {{ index: object, shards: Map<string, string> }} payload
   */
  saveSharded({ index, shards }) {
    if (this.closed) return Promise.resolve(false);
    // Checkpoint events can replace/delete entries while disk I/O yields; capture this round's complete set now.
    shards = new Map(shards);
    const work = async () => {
      await this.acquire();
      if (this.mode !== 'dir') {
        const clocks = index.clocks && typeof index.clocks === 'object' ? index.clocks : {};
        const doc = { ...index, clocks, matches: {} };
        for (const [code, body] of shards) {
          const parsed = JSON.parse(body);
          const c = clocks[code];
          doc.matches[code] = c ? { ...parsed, deadlineRemainingMs: c.deadlineRemainingMs, startedAtAgoMs: c.startedAtAgoMs } : parsed;
        }
        try {
          await this.writeAtomic(this.file, JSON.stringify(doc));
          this.saved++;
          return true;
        } catch (err) {
          this.log.warn?.('[persist] state file save failed', err.message);
          return false;
        }
      }
      return this.runShardedWrite({ index, shards });
    };
    const result = this.pending.then(work, work);
    this.pending = result.catch(() => false);
    return result;
  }

  /** Runs inside the serialized work queue — never called from another queued work item. */
  async runShardedWrite({ index, shards }) {
    let ok = true;
    const savedAt = Number.isFinite(index.savedAt) ? index.savedAt : Date.now();
    const rooms = new Map((index.rooms || []).map((room) => [room.code, room]));
    for (const [code, body] of shards) {
      const matchCount = rooms.get(code)?.matchCount;
      const previous = this.shardRevisions.get(code);
      if (this.shards.get(code) === body && previous && previous.matchCount === matchCount) continue;
      const revision = randomUUID();
      const clocks = index.clocks?.[code] || {};
      try {
        // Embed Worker-encoded JSON verbatim: no parse/encode of the large checkpoint on the game thread.
        const content = `{"storage":1,"revision":${JSON.stringify(revision)},"matchCount":${JSON.stringify(matchCount ?? null)},"clocks":${JSON.stringify(clocks)},"checkpoint":${body}}`;
        await this.writeAtomic(path.join(this.matchesDir, code + SHARD_SUFFIX), content);
        this.shards.set(code, body);
        this.shardRevisions.set(code, { revision, matchCount });
        this.shardWrites++;
      } catch (err) {
        ok = false;
        this.log.warn?.(`[persist] ${code}: shard write failed`, err.message);
      }
    }
    if (!ok) return false;                          // never publish clocks for a checkpoint that failed to land
    const commit = canonicalIndex(index);
    if (commit !== this.indexCommit) {
      const revision = randomUUID();
      const meta = { ...indexMetadata(index), savedAt, layout: DIRECTORY_LAYOUT, revision };
      try {
        await this.writeAtomic(this.indexFile, JSON.stringify(meta));
        this.indexCommit = commit;                  // only successful writes become the retry/dirty baseline
        this.indexRevision = revision;
        this.indexWrites++;
      } catch (err) {
        this.log.warn?.('[persist] index write failed', err.message);
        return false;
      }
    }
    const clocks = {};
    for (const code of shards.keys()) {
      clocks[code] = { ...index.clocks?.[code], revision: this.shardRevisions.get(code).revision };
    }
    const runtime = JSON.stringify({ v: 1, indexRevision: this.indexRevision, savedAt, clocks });
    if (runtime !== this.runtimeCommit) {
      try {
        await this.writeAtomic(this.runtimeFile, runtime);
        this.runtimeCommit = runtime;
        this.runtimeWrites++;
      } catch (err) {
        this.log.warn?.('[persist] runtime write failed', err.message);
        return false;
      }
    }
    // Remove obsolete shards only after the metadata/runtime commit. A failed removal remains queued for retry.
    for (const code of [...this.shards.keys()]) {
      if (shards.has(code)) continue;
      try {
        await fs.unlink(path.join(this.matchesDir, code + SHARD_SUFFIX));
      } catch (err) {
        if (err.code !== 'ENOENT') {
          ok = false;
          this.log.warn?.(`[persist] ${code}: shard removal failed`, err.message);
          continue;
        }
      }
      this.shards.delete(code);
      this.shardRevisions.delete(code);
    }
    if (ok) this.saved++;
    return ok;
  }

  /** Object-document bridge so the classic save(doc) API also works against a directory. */
  shardedPayloadFromDoc(doc) {
    const clocks = doc.clocks && typeof doc.clocks === 'object' ? { ...doc.clocks } : {};
    const shards = new Map();
    for (const [code, checkpoint] of Object.entries(doc.matches || {})) {
      if (!checkpoint || typeof checkpoint !== 'object') continue;
      const { deadlineRemainingMs, startedAtAgoMs, ...body } = checkpoint;
      if (!clocks[code] && Number.isFinite(deadlineRemainingMs)) clocks[code] = { deadlineRemainingMs, startedAtAgoMs };
      shards.set(code, JSON.stringify(body));
    }
    return { index: { ...doc, matches: undefined, clocks }, shards };
  }

  /** tmp → fsync → rename: a reader never sees a half-written file, a crash never corrupts the target. */
  async writeAtomic(file, content) {
    const tmp = `${file}.${this.lockToken}.tmp`;
    let handle;
    try {
      handle = await fs.open(tmp, 'w', 0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close(); handle = null;
      await fs.rename(tmp, file);
    } catch (err) {
      await handle?.close().catch(() => {});
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
  }

  async close() {
    this.closed = true;
    await this.pending;
    if (!this.locked) return;
    try {
      const owner = JSON.parse(await fs.readFile(this.lockFile, 'utf8'));
      if (owner.token === this.lockToken) await fs.unlink(this.lockFile);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    } finally { this.locked = false; }
  }
}
