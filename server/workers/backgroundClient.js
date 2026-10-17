// 取自 xinhai-ai/Stronghold-Protocol（GPL-3.0-or-later，同本仓库）。
import { Worker } from 'node:worker_threads';

// Lazy, bounded-lifetime background I/O/encoding worker. Callers coalesce their jobs.
export class BackgroundClient {
  constructor(url, workerData, timeoutMs = 120000) {
    this.url = url; this.workerData = workerData; this.timeoutMs = timeoutMs;
    this.worker = null; this.pending = new Map(); this.nextId = 0; this.closed = false;
  }
  request(payload) {
    if (this.closed) return Promise.reject(new Error('background worker closed'));
    if (!this.worker) {
      const worker = this.worker = new Worker(this.url, { workerData: this.workerData });
      worker.on('message', ({ id, value, error }) => {
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id); clearTimeout(item.timer);
        if (error) item.reject(new Error(error)); else item.resolve(value);
        if (!this.pending.size) worker.unref();
      });
      worker.on('error', (error) => this.drop(worker, error));
      worker.on('exit', (code) => this.drop(worker, new Error(`background worker exited ${code}`)));
    }
    const worker = this.worker, id = ++this.nextId;
    worker.ref();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.drop(worker, new Error('background worker timed out')), this.timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ id, payload }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); if (!this.pending.size) worker.unref(); }
    });
  }
  drop(worker, error) {
    if (this.worker !== worker) return;
    this.worker = null;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    return worker.terminate().catch(() => {});
  }
  async close() {
    this.closed = true;
    if (this.worker) await this.drop(this.worker, new Error('background worker closed'));
  }
}
