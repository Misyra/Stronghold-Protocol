// A module Worker with its own response CSP. No fetch: checked content bytes/data arrive from the page.
import { createSimWorker } from './simWorkerRuntime.js';

// worker 里没有页面注入的版本号（server/assetVersion 的 transform 只改 HTML）。simHost 建 worker 时把
// `?v=<runtimeTag>` 挂在了脚本地址上，这里从自己的 location 捞回来：simLoader 之后 import 的
// `/sim/…`、`/shared/…` 才会带上同一个 tag，那些模块才能被浏览器当 immutable 存着。
try {
  const tag = new URL(globalThis.location.href).searchParams.get('v');
  if (!globalThis.__spRuntimeVersion && /^[a-f0-9]{16}$/.test(tag || '')) globalThis.__spRuntimeVersion = tag;
} catch { /* 拿不到自己的地址：保持未版本化，行为与改动前一致 */ }

const dispatch = createSimWorker();
// Serialize asynchronous boot/start/control calls; a second command never observes half-installed content.
let queue = Promise.resolve();
globalThis.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try { globalThis.postMessage({ id: data.id, value: await dispatch(data.method, data.args) }); }
    catch (e) { globalThis.postMessage({ id: data.id, error: { code: e.code || 'PLUGIN_WORKER_FAILED', message: String(e.message || e).slice(0, 300) } }); }
  });
};
