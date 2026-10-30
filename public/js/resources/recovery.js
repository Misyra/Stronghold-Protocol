/** One cancellable recovery subscription per page. Hidden/offline tabs never poll the cache or origin. */
export class ResourceRecovery {
  constructor({ window = globalThis.window, document = globalThis.document, navigator = globalThis.navigator,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id), now = Date.now } = {}) {
    this.window = window;
    this.document = document;
    this.navigator = navigator;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.cleanup = null;
  }

  cancel() { this.cleanup?.(); this.cleanup = null; }

  wait(resume, { delay = null } = {}) {
    this.cancel();
    let timer;
    const due = delay == null ? 0 : this.now() + delay;
    const ready = () => this.navigator?.onLine !== false && this.document?.visibilityState !== 'hidden';
    const retry = () => {
      if (!ready() || this.now() < due) return;
      this.cancel();
      resume();
    };
    const visible = () => { if (this.document?.visibilityState === 'visible') retry(); };
    this.window?.addEventListener('online', retry);
    this.document?.addEventListener('visibilitychange', visible);
    if (delay != null) timer = this.setTimer(retry, delay);
    this.cleanup = () => {
      this.clearTimer(timer);
      this.window?.removeEventListener('online', retry);
      this.document?.removeEventListener('visibilitychange', visible);
    };
  }
}
