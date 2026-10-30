// Page-local task ownership. Cache writes across tabs still use the Web Lock in index.js.
export class ResourceTasks {
  download = { promise: null, controller: null };
  archive = { promise: null, controller: null };
  clearing = { promise: null, controller: null };
  revision = 0;
  epoch = 0;
  stopWatching = null;

  get clear() { return this.clearing.promise; }
  get busy() { return !!(this.download.promise || this.archive.promise || this.clear); }

  invalidate() {
    this.revision++;
    this.unwatch();
  }

  unwatch() {
    this.stopWatching?.();
    this.stopWatching = null;
  }

  cancel(...kinds) {
    for (const kind of kinds) this[kind].controller?.abort();
  }

  // Reserve the slot before invoking work. A replacing task owns publication immediately,
  // even while it waits for the cancelled predecessor to release its cache operations.
  run(kind, work, onFinally = () => {}) {
    if (kind === 'download' && this.clear) return this.clear;
    if (kind === 'download' && this.archive.promise) return this.archive.promise.catch(() => {});
    if (kind === 'archive' && (this.archive.promise || this.clear)) return Promise.reject(new Error('资源包正在处理中'));
    const slot = this[kind];
    if (slot.promise) return slot.promise;
    const predecessors = kind === 'clearing' ? [this.download.promise, this.archive.promise]
      : kind === 'archive' ? [this.download.promise] : [];
    if (kind === 'clearing') this.cancel('download', 'archive');
    if (kind === 'archive') this.cancel('download');
    this.unwatch();
    const epoch = ++this.epoch;
    const controller = new AbortController();
    slot.controller = controller;
    const token = {
      signal: controller.signal,
      current: () => epoch === this.epoch,
      publish: (write) => (patch) => { if (epoch === this.epoch) write(patch); },
    };
    slot.promise = Promise.resolve().then(async () => {
      await Promise.allSettled(predecessors.filter(Boolean));
      return work(token);
    }).finally(() => {
      slot.promise = null;
      slot.controller = null;
      return onFinally(token);
    });
    return slot.promise;
  }

  inspection() {
    const revision = this.revision, epoch = ++this.epoch;
    return () => !this.busy && revision === this.revision && epoch === this.epoch;
  }

  watch(target, listener) {
    this.unwatch();
    target.addEventListener('visibilitychange', listener);
    this.stopWatching = () => target.removeEventListener('visibilitychange', listener);
  }
}
