// 按需安装皮肤 (docs/SKINS.md) — the server side of the in-game 「安装」 button.
//
// The work itself is `tools/install-skins.mjs`, the same code the CLI runs, imported rather than spawned so it
// shares this process and its atomic manifest writes. Two properties shape everything here:
//
//   * An install takes tens of seconds — the seven files come from GitHub at whatever the link manages (measured
//     ~35 KB/s on a mainland China line, so ~1 MB is ~30 s). A request must therefore never wait for one: the
//     client gives up after 8 s (public/js/net.js REQUEST_TIMEOUT_MS). Callers get an immediate acknowledgement
//     and the outcome arrives later, as a broadcast.
//
//   * `installSkins` reads data/assets.json, adds its entry and writes the file back. Two of those interleaved
//     would lose one of the two updates — the second write starts from a manifest read before the first landed.
//     Every call therefore goes through ONE queue, and only one install ever runs.

/**
 * How many installs may wait behind the running one. Deliberately small: each one is tens of seconds of a private
 * server's bandwidth, and a bigger queue would only turn a client's mistake into a long stall for everyone.
 */
const MAX_QUEUED = 8;

/** @type {{ skinId: string, onDone: Function, onProgress: Function }[]} */
const queue = [];
/** @type {string|null} the skinId being installed right now */
let running = null;
let draining = false;
/** @type {Map<string, boolean>} skinIds that finished (or failed) — a second click reports the cached outcome */
const settled = new Map();

/** Whether an install is in flight, and how many are waiting behind it. */
export function skinInstallStatus() {
  return { running, queued: queue.length };
}

/**
 * Queue one skin for installation and return at once.
 * @param {string} skinId
 * @param {{ log?: Function, onDone?: (r: { skinId: string, ok: boolean, why?: string }) => void,
 *   onProgress?: (p: { skinId: string, phase: string, done: number, total: number }) => void }} [opts]
 * @returns {{ ok: true, state: 'queued'|'already-queued'|'running' } | { error: string, detail: string }}
 */
export function installSkinInBackground(skinId, { log = console.log, onDone, onProgress } = {}) {
  const notify = typeof onDone === 'function' ? onDone : () => {};
  const tick = typeof onProgress === 'function' ? onProgress : () => {};
  if (running === skinId) return { ok: true, state: 'running' };
  if (queue.some((q) => q.skinId === skinId)) return { ok: true, state: 'already-queued' };
  if (queue.length >= MAX_QUEUED) return { error: 'RATE', detail: `太多安装排着队（${queue.length}），等它们完成再试` };
  queue.push({ skinId, onDone: notify, onProgress: tick });
  if (!draining) void drain(log);
  return { ok: true, state: 'queued' };
}

async function drain(log) {
  draining = true;
  while (queue.length) {
    const { skinId, onDone, onProgress } = queue.shift();
    running = skinId;
    let result;
    try {
      // imported lazily: the spine parser and the asset tooling are only needed once someone actually installs
      const mod = await import('../tools/install-skins.mjs');
      const res = await mod.installSkins([skinId], {
        log,
        onProgress: (p) => { try { onProgress(p); } catch (e) { log(`[skins] onProgress threw: ${e?.message || e}`); } },
      });
      const failure = (res.failed || []).find((f) => f.id === skinId);
      result = failure ? { skinId, ok: false, why: failure.why } : { skinId, ok: true };
    } catch (e) {
      log(`[skins] install ${skinId} failed: ${e?.message || e}`);
      result = { skinId, ok: false, why: String(e?.message || e).slice(0, 200) };
    }
    running = null;
    settled.set(skinId, result.ok);
    try { onDone(result); } catch (e) { log(`[skins] onDone for ${skinId} threw: ${e?.message || e}`); }
  }
  draining = false;
}

/** Test seam: forget the remembered outcomes and empty the queue. */
export function resetSkinInstallForTests() {
  queue.length = 0;
  running = null;
  draining = false;
  settled.clear();
}
