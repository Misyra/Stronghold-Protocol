// Atomic, single-process state storage. Kept outside every HTTP static mount.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class FileStateStore {
  constructor({ file, log = console }) {
    this.file = path.resolve(file);
    this.log = log;
    this.kind = 'file';
    this.label = this.file;
    this.lockFile = `${this.file}.lock`;
    this.lockToken = randomUUID();
    this.locked = false;
    this.saved = 0;
    this.pending = Promise.resolve();
    this.closed = false;
  }
  async acquire() {
    if (this.locked) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
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
    let raw;
    try { raw = await fs.readFile(this.file, 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    try {
      const doc = JSON.parse(raw);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('invalid document');
      return doc;
    } catch { throw new Error('状态文件损坏，已保留原文件；请从备份恢复后再启动'); }
  }
  save(doc) {
    if (this.closed) return Promise.resolve(false);
    // Serialize writes, including a final write submitted while an interval write is still running.
    const work = async () => {
      await this.acquire();
      const tmp = `${this.file}.${this.lockToken}.tmp`;
      let handle;
      try {
        const json = JSON.stringify(doc);
        handle = await fs.open(tmp, 'w', 0o600);
        await handle.writeFile(json, 'utf8');
        await handle.sync();
        await handle.close(); handle = null;
        await fs.rename(tmp, this.file);
        this.saved++;
        return true;
      } catch (err) {
        await handle?.close().catch(() => {});
        await fs.unlink(tmp).catch(() => {});
        this.log.warn?.('[persist] state file save failed', err.message);
        return false;
      }
    };
    const result = this.pending.then(work, work);
    this.pending = result.catch(() => false);
    return result;
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
