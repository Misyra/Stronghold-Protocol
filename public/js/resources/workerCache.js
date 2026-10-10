// Page/worker handoff carries metadata only: verified resource bodies stay in Cache Storage.
import { CONTENT_HASH_RE, absoluteUrl, checkAbort } from './common.js';
import { waitForResource } from './network.js';

function request(worker, data, { signal, timeoutMs }) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const cleanup = () => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      channel.port1.close(); channel.port2.close();
    };
    const abort = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => { cleanup(); reject(Object.assign(new Error('资源缓存服务响应超时'), { name: 'TimeoutError' })); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    channel.port1.onmessage = ({ data: reply }) => { cleanup(); resolve(reply); };
    try { worker.postMessage({ ...data, type: 'sp-resource-cache-v1' }, [channel.port2]); }
    catch (err) { cleanup(); reject(err); }
  });
}

function capability(promise, signal) {
  checkAbort(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then((value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (err) => { signal.removeEventListener('abort', abort); reject(err); });
  });
}

/** Old/unavailable workers fall back once per worker; CDN headers never count as verification receipts. */
export function createWorkerCache(getWorker, { origin = globalThis.location?.origin || 'http://localhost',
  timeoutMs = 30000, helloTimeoutMs = 1000, retries = 2, retryDelayMs = 500 } = {}) {
  const capabilities = new WeakMap();
  return async (file, { signal, cachedOnly = false } = {}) => {
    checkAbort(signal);
    if (!CONTENT_HASH_RE.test(file.hash || '') || typeof MessageChannel === 'undefined') return null;
    const worker = await getWorker();
    checkAbort(signal);
    if (!worker) return null;
    let supported = capabilities.get(worker);
    if (!supported) {
      supported = request(worker, { hello: true }, { timeoutMs: helloTimeoutMs })
        .then((reply) => reply?.protocol === 1).catch(() => false);
      capabilities.set(worker, supported);
    }
    if (!await capability(supported, signal)) { checkAbort(signal); return null; }
    const url = absoluteUrl(file.url, origin);
    if (!url) return null;
    for (let attempt = 0; ; attempt++) {
      checkAbort(signal);
      let reply;
      try { reply = await request(worker, { url, hash: file.hash, size: file.size ?? null, cachedOnly }, { signal, timeoutMs }); }
      catch {
        checkAbort(signal);
        capabilities.set(worker, Promise.resolve(false));
        return null; // worker replacement/crash: retain the independently verified page path
      }
      checkAbort(signal);
      if (!reply?.error) {
        const result = reply?.result;
        return result?.cached === true && result.url === url && result.hash === file.hash && result.size === (file.size ?? null) ? result : null;
      }
      const err = Object.assign(new Error(reply.error.message || '资源下载失败'), reply.error);
      const transient = err.name === 'TimeoutError' || err.name === 'TypeError' || err.transient
        || err.status === 408 || err.status === 429 || err.status >= 500;
      if (!transient || attempt >= retries) throw err;
      await waitForResource(Math.min(30000, Math.max(0, err.retryAfter || 0, retryDelayMs * 2 ** attempt)), signal);
    }
  };
}
