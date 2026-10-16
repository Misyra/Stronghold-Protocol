// Adapted from xinhai-ai/Stronghold-Protocol (GPL-3.0-or-later).
// public/js/resources/index.js — the page side of the optional asset preload (docs/ASSETS.md「Preload」).
//
// Resumed after app boot when enabled in the saved settings (设置 ▸ 预载资源). This module fetches /data/resource-manifest.json,
// registers the Service Worker (public/resource-sw.js, so the cached files are also served with no network) and fills
// Cache Storage with required visuals first, then optional audio/tutorials when selected. Turning it off stops the
// downloads until enabled again; 「清理缓存」 deletes them. Cached files are reused on later visits. Nothing here
// blocks entering or playing a match, and a failed download is reported in the resource manager.
//
// The settings panel (public/js/ui/resourcePanel.js) renders `resourceState()`; main.js calls `syncResources()` with the
// persisted setting at boot and on every settings change.

import { CACHE_PREFIX, MANIFEST_URL, resourceWorkerUrl, isResourceWorker, TIER_ESSENTIAL, TIER_REST, checkAbort, formatBytes, isQuotaError, resourceGroup, validateManifest } from './common.js';
import { ResourceStore, normalizeSkinScope } from './store.js';
import { createWorkerCache } from './workerCache.js';
import { ResourceSchedule } from './schedule.js';
import { missingStorage, storageEstimate } from './storage.js';
import { createResourceState } from './state.js';
import { ResourceTasks } from './tasks.js';
import { t } from '../../../shared/i18n.js';

/** @type {any} */
const stateStore = createResourceState({
  enabled: false,
  phase: 'off', // off | checking | download | foreign (another tab) | ready | paused | error
  supported: true,
  reason: '',
  done: 0,
  total: 0,
  wanted: 0,
  tier1Done: 0,
  tier1Total: 0,
  tier2Done: 0,
  tier2Total: 0,
  bytes: 0,
  totalBytes: null,
  sized: 0,
  sizedTotal: 0,
  skipped: 0,
  failed: 0,
  complete: false,
  message: '',
  error: false,
  worker: '',
  version: '',
  archive: '', // import | export; separate from download progress
  archivePhase: '',
  archivePercent: 0,
  archiveGroup: '',
  optional: true,
  voices: true,
  selectionComplete: false,
  groups: [],
  failures: [],
  archiveResult: null,
  storage: null,
  voiceLang: 'cn',
  voiceLanguages: [],
  allVoices: false,
  // 干员皮肤: the per-item selection and the counters the panel's skin list renders (docs/SKINS.md).
  skins: [],
  skinScope: { keys: [], all: false },
  /** Whole-manifest file count and byte total — every scope, whatever is switched on. */
  manifestFiles: 0,
  manifestBytes: 0,
  // 官方特效: how many effect files the manifest offers at all. The panel keeps the 特效 box visible with it, even
  // while the box itself is off (docs/design/vfx-format.md).
  fxFiles: 0,
  requiredComplete: false,
  clearing: false,
  combat: false,
});
const state = stateStore.state;
const set = stateStore.set;
let current = false;
const tasks = new ResourceTasks();
let contextPromise = null;
let optional = true;
let voices = true;
let wantRun = false;
let workerPromise = null;
let voiceLang = 'cn';
let allVoices = false;
/** @type {string[]} the equipped 干员皮肤 (`charId/skinId`) the preload follows — empty when the switch is off. */
let skinKeys = [];
/** @type {boolean} 全部皮肤: preload every outfit the manifest offers instead of the equipped ones (docs/SKINS.md). */
let allSkins = false;
/** @type {boolean} 官方特效: its own preload switch, kept apart from 「额外资源」 (docs/design/vfx-format.md). */
let fx = true;

const schedule = new ResourceSchedule();

export function updateResourcePriority(context) {
  schedule.update(context);
  set({ combat: schedule.combat });
}

/** Suspend worker writes before imports/deletes, including writes already started in another tab. */
async function workerWrites(enabled) {
  const registration = await workerPromise;
  const worker = globalThis.navigator?.serviceWorker?.controller || registration?.active || registration?.installing;
  if (!worker || typeof MessageChannel === 'undefined') return;
  await new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const cleanup = () => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('资源缓存服务响应超时，请刷新页面后重试')); }, 5000);
    channel.port1.onmessage = () => { cleanup(); resolve(undefined); };
    try { worker.postMessage({ type: 'sp-resource-mode', enabled }, [channel.port2]); }
    catch (err) { cleanup(); reject(err); }
  });
}

async function withWorkerWritesPaused(job) {
  try {
    // A missing acknowledgement does not mean the worker ignored the pause.
    // Always send resume, even when the pause times out; never run the job then.
    await workerWrites(false);
    return await job();
  }
  finally { await workerWrites(true).catch(() => {}); }
}

async function updateStorage(store, status, plan, write = set) {
  const revision = tasks.revision;
  const storage = await storageEstimate(plan || missingStorage(store, status, optional));
  if (revision === tasks.revision) write({ storage });
}

/** Subscribe to preload state changes (returns the unsubscribe function). */
export function subscribeResources(fn) {
  return stateStore.subscribe(fn);
}

/** A copy of the current preload state (safe to hand to Preact). */
export function resourceState() {
  return stateStore.snapshot();
}

/**
 * The counters of one store payload (status / progress / result — store.js emits the same fields for all three), in the
 * names the panel renders. One shape for all three is what keeps a progress update from leaving a field undefined.
 */
const counters = (s) => ({
  done: s.count,
  total: s.total,
  wanted: s.wanted,
  tier1Done: s.tier1Present,
  tier1Total: s.tier1,
  tier2Done: s.tier2Present,
  tier2Total: s.tier2,
  tier1Wanted: s.tier1Wanted ?? s.tier1,
  tier2Wanted: s.tier2Wanted ?? s.tier2,
  bytes: s.bytes,
  totalBytes: s.totalBytes,
  sized: s.sized,
  sizedTotal: s.sizedTotal,
  skipped: s.skipped,
  complete: s.complete,
  // The whole current selection is cached. `requiredComplete` is only the required tier: the panel says 「必备已保存」
  // while optional files — or chosen 干员皮肤 — are still outstanding.
  selectionComplete: !!s.complete,
  requiredComplete: requiredComplete(s),
  // migration (kept bytes) vs network (fetched bytes): 0 unless a run is/was in flight
  adopted: s.adopted ?? 0,
  downloaded: s.downloaded ?? 0,
  groups: s.groups ?? [],
  voiceLanguages: s.voiceLanguages ?? [],
  fxFiles: s.fxFiles ?? 0,
  manifestFiles: s.manifestFiles ?? 0,
  manifestBytes: s.manifestBytes ?? 0,
  skins: s.skins ?? [],
  skinScope: s.skinScope ?? { keys: [], all: false },
});

/** Required (tier 1) files of the selection are cached — the store's counters already exclude everything out of scope. */
const requiredComplete = (s) => s.tier1 === 0 || s.tier1Present >= (s.tier1Wanted ?? s.tier1);

/** The 干员皮肤 scope, sorted: the equipped keys, and whether 全部皮肤 asked for every outfit (docs/SKINS.md). */
const skinScopeOf = (raw) => {
  const scope = normalizeSkinScope(raw);
  return { keys: [...scope.keys].sort(), all: scope.all };
};

const sameSkinKeys = (a, b) => a.length === b.length && a.every((key, i) => key === b[i]);

const sameSkinScope = (a, b) => a.all === b.all && sameSkinKeys(a.keys, b.keys);

/** The current selection as the store wants it, whichever axis changed last. */
const storeScope = () => ({ optional, voices, voiceLang, allVoices, skins: { keys: skinKeys, all: allSkins }, fx });

/** Why this browser cannot keep the resources (empty ⇒ it can). */
export function unsupportedReason() {
  if (!globalThis.isSecureContext) return t('需要 HTTPS（或 localhost）才能预载资源');
  if (!globalThis.caches) return t('当前浏览器不支持 Cache Storage');
  if (!globalThis.navigator?.serviceWorker) return t('当前浏览器不支持 Service Worker');
  return '';
}

/**
 * The preload context: the manifest plus (when this browser can cache) its store. Cached for the session; a failure is
 * retried the next time the player enables the preload.
 */
export function resourceContext() {
  contextPromise ??= (async () => {
    const reason = unsupportedReason();
    if (reason) return { unsupported: reason }; // no point in asking for a list this browser cannot store
    let res;
    try {
      const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(10000) : undefined;
      // Revalidate the HTTP cache on every page load: on a 304 the browser supplies the cached body instead of
      // re-downloading the manifest (the server answers with a strong ETag over the full response).
      res = await fetch(MANIFEST_URL, { cache: 'no-cache', signal });
    } catch (err) {
      return { error: t('无法读取资源清单：{0}', { 0: err?.message || err }) };
    }
    if (!res.ok) return { error: t('无法读取资源清单：HTTP {status}', { status: res.status }) };
    let manifest;
    try {
      manifest = validateManifest(await res.json());
    } catch (err) {
      return { error: String(err?.message || err) };
    }
    if (!manifest.files.length) return { manifest, empty: true };
    const ensureCached = createWorkerCache(async () => {
      const worker = globalThis.navigator?.serviceWorker?.controller || (await workerPromise)?.active;
      return isResourceWorker(worker?.scriptURL, location.origin) ? worker : null;
    });
    return { manifest, store: new ResourceStore(manifest, { schedule, ensureCached }) };
  })();
  return contextPromise;
}

/** Register the Service Worker that serves the cached files (downloads work without it). */
async function ensureWorker() {
  const nav = globalThis.navigator;
  if (!nav?.serviceWorker) throw new Error('不支持 Service Worker');
  const reg = await nav.serviceWorker.register(resourceWorkerUrl(), { type: 'module', scope: '/', updateViaCache: 'none' });
  set({ worker: '' });
  return reg;
}

/** Unregister the worker (nothing to serve from the cache any more). */
async function dropWorker() {
  const nav = globalThis.navigator;
  if (!nav?.serviceWorker) return;
  try {
    for (const reg of await nav.serviceWorker.getRegistrations()) {
      if ([reg.active, reg.installing, reg.waiting].some(worker => isResourceWorker(worker?.scriptURL, location.origin))) await reg.unregister();
    }
  } catch { /* the worker is optional */ }
}

/**
 * Turn the preload on or off and hand it the current selection (idempotent: the settings store fires on every volume
 * change).
 * @param {boolean} enabled
 * @param {boolean} [includeOptional] 额外资源: the optional (tier 2) set — voices, sound effects, music, tutorials
 * @param {string} [language] voice language kept in the selection
 * @param {boolean} [includeAllVoices]
 * @param {Iterable<string>|{ keys?: Iterable<string>, all?: boolean, fx?: boolean, voices?: boolean }|'all'|'off'|null} [selection]
 *   干员皮肤: the equipped `charId/skinId` keys to follow, or every outfit with `{ all: true }` (docs/SKINS.md).
 *   官方特效: `{ fx }` — its own switch (tier 2, ~185 MiB, docs/design/vfx-format.md), unaffected by `includeOptional`.
 */
export async function syncResources(enabled, includeOptional = optional, language = voiceLang, includeAllVoices = allVoices, selection = { keys: skinKeys, all: allSkins }) {
  enabled = !!enabled;
  language = ['cn', 'jp', 'en', 'kr'].includes(language) ? language : 'cn';
  const nextScope = skinScopeOf(selection);
  // 官方特效 rides the selection object beside the outfit keys — a scope axis of its own, and never implied by 额外资源.
  const nextFx = selection && !Array.isArray(selection) && typeof selection.fx === 'boolean' ? selection.fx : fx;
  // Older callers tied voices to optional; the manager now exposes the two choices independently.
  const nextVoices = selection && typeof selection.voices === 'boolean' ? selection.voices : !!includeOptional;
  const changed = optional !== !!includeOptional || voiceLang !== language || allVoices !== !!includeAllVoices
    || !sameSkinScope({ keys: skinKeys, all: allSkins }, nextScope) || fx !== nextFx || voices !== nextVoices;
  if (enabled === current && !changed) { set({ enabled }); return; }
  tasks.invalidate();
  current = enabled;
  wantRun = enabled;
  optional = !!includeOptional;
  voices = nextVoices;
  voiceLang = language;
  allVoices = !!includeAllVoices;
  skinKeys = nextScope.keys;
  allSkins = nextScope.all;
  fx = nextFx;
  set({ enabled, optional, voices, voiceLang, allVoices, skinScope: nextScope, error: false, message: '' });
  if (!enabled) {
    tasks.cancel('download', 'archive');
    set({ phase: state.complete ? 'ready' : 'paused', message: state.complete ? t('预载已停止；已保存的资源保留，可继续下载或清理缓存。') : t('已停止预载。') });
    // The selection can still change while preloading is off (the manager's tier / voice / 皮肤 switches): re-read the
    // cache so its counters follow the click instead of showing what the last inspection saw.
    if (changed) void refreshSelection();
    return;
  }
  if (changed) tasks.download.controller?.abort();
  const pending = tasks.archive.promise || tasks.clear;
  if (pending) { await pending.catch(() => {}); if (!current || !wantRun) return; }
  // An aborted run restarts in start()'s finally when wantRun remains true. Reuse that promise instead of starting
  // a second run after the restart has already finished (rapid off/on or tier changes).
  return start();
}

/** Continue (or start) the download of an enabled preload. */
export async function startResources() {
  if (!current) return;
  wantRun = true;
  return start();
}

/**
 * Publish fresh counters after a selection change that no run will follow (preloading off, so `start()` never runs).
 * Waits for a cancelled run to release its slot first: `inspectResources()` refuses to scan while one is in flight.
 */
async function refreshSelection() {
  const stopping = tasks.download.promise || tasks.archive.promise;
  if (stopping) await stopping.catch(() => {});
  if (!current) await inspectResources().catch(() => {});
}

/**
 * The download of one tab at a time (Web Locks): Cache Storage is shared by every tab of the origin, so without this
 * two tabs of the same session would fetch the same ~250 MiB twice. The second tab does not queue behind the first: it
 * reports what is already cached and re-checks when the player comes back to it (`ifAvailable`).
 */
export const DOWNLOAD_LOCK = 'stronghold-resources-preload';

/** Run `job` while holding the download lock; `{ busy: true }` when another tab has it. Unsupported ⇒ just run it. */
async function withDownloadLock(job) {
  const locks = globalThis.navigator?.locks;
  if (!locks || typeof locks.request !== 'function') return job();
  return locks.request(DOWNLOAD_LOCK, { ifAvailable: true }, async (lock) => (lock ? job() : { busy: true }));
}

/** Another tab owns the download: show what is cached and look again when this tab becomes visible. */
function watchOtherTab(store, task) {
  if (globalThis.document?.addEventListener && task.current() && !task.signal.aborted) {
    const recheck = () => {
      if (document.visibilityState !== 'visible' || !current || !wantRun) return;
      tasks.unwatch();
      void startResources();
    };
    tasks.watch(document, recheck);
  }
  return store.status().then((st) => {
    if (!task.signal.aborted) task.publish(set)({
      ...counters(st), phase: 'foreign', error: false,
      message: st.complete ? t('资源已全部预载完成。') : t('另一个标签页正在预载⋯回到这个标签页时会自动继续。'),
    });
  });
}

function start() {
  if (tasks.clear) return tasks.clear;
  if (tasks.archive.promise) return tasks.archive.promise.catch(() => {});
  return tasks.run('download', async (task) => {
    try { await startDownload(task); }
    catch (err) {
      if (!task.signal.aborted) task.publish(set)({ phase: 'error', error: true, message: t('无法访问资源缓存：{0}', { 0: err?.message || err }) });
    }
  }, ({ signal }) => {
    if (current && wantRun && signal.aborted && !tasks.archive.promise && !tasks.clear) return start();
  });
}

async function startDownload(task) {
  const { signal } = task;
  const set = task.publish(stateStore.set);
  set({ phase: 'checking', message: t('正在检查已保存的资源…'), error: false });
  const checkStart = performance.now();
  const ctx = await resourceContext();
  const manifestReady = performance.now();
  if (!current || signal.aborted) { set({ phase: 'paused' }); return; }
  if (ctx.error || ctx.unsupported || ctx.empty) {
    const message = ctx.error || ctx.unsupported || t('服务器没有可预载的资源');
    set({ phase: 'error', message, error: true, supported: !ctx.unsupported });
    if (ctx.unsupported) void dropWorker();
    if (ctx.error) contextPromise = null;
    return;
  }
  const store = ctx.store;
  store.setScope(storeScope());
  // Optional files are in play when the 额外资源 switch asks for them, when 干员皮肤 were picked, or while 官方特效 is
  // on — the store's selection already excludes everything else, so one question covers all three and the sets never ride
  // along on each other.
  const restWanted = store.selectedFiles.some((f) => f.tier === TIER_REST);
  set({ supported: true, version: store.manifest.version });
  // registering an already-registered worker is a cheap no-op, so every start can retry a failed one. A failure here
  // does NOT stop the download (the page fills Cache Storage itself) — it only means nothing can be served offline.
  workerPromise = ensureWorker().catch((err) => {
    console.warn('[resources] service worker not registered — the cached assets cannot be served without the network', err);
    set({ worker: t('预载服务未启用（{0}），资源仍会下载，但不会从本机缓存读取。', { 0: err?.message || err }) });
  });
  const before = await store.status();
  await updateStorage(store, before, undefined, set);
  console.info('[resources] preload check timings', { manifestMs: manifestReady - checkStart,
    ...before.checkTimings, durationMs: performance.now() - checkStart, cached: before.count, files: before.total });
  if (!current || signal.aborted) { set({ phase: 'paused' }); return; }
  const ready = !!before.complete;
  set({ ...counters(before), phase: ready ? 'ready' : 'download',
    message: ready ? restWanted ? t('资源已全部预载完成。') : t('必备资源已预载完成；可选资源按需加载。') : '' });
  if (ready) { if (before.complete) await withDownloadLock(() => store.prune()); return; }
  const onProgress = (p) => {
    if (signal.aborted) return;
    // "整理" instead of "下载" when the files came out of an older cache: nothing is being fetched (store.js 的迁移).
    const message = p.adopted > 0 && p.downloaded === 0 ? t('正在整理已保存的资源（无需重新下载）…') : '';
    set({ ...counters(p), phase: 'download', failed: p.failed, failures: p.failures || [], error: false, message });
  };
  try {
    // Required visuals first, then the optional set (额外资源 / 干员皮肤 / 官方特效 — whichever switches are on).
    const outcome = await withDownloadLock(async () => {
      checkAbort(signal);
      const essential = await store.download({ tiers: [TIER_ESSENTIAL], signal, onProgress });
      const rest = restWanted ? await store.download({ tiers: [TIER_REST], signal,
        onProgress: (p) => onProgress({ ...p, failed: p.failed + essential.failed, failures: [...essential.failures, ...p.failures].slice(0, 10) }) }) : { failed: 0, failures: [] };
      return { busy: false, failed: essential.failed + rest.failed, failures: [...essential.failures, ...rest.failures].slice(0, 10) };
    });
    if (outcome.busy) { await watchOtherTab(store, task); return; }
    const after = await store.status();
    checkAbort(signal);
    await updateStorage(store, after, undefined, set);
    checkAbort(signal);
    set({
      ...counters(after),
      phase: 'ready',
      failed: outcome.failed,
      failures: outcome.failures,
      error: outcome.failed > 0,
      message: after.complete ? restWanted
        ? t('资源已全部预载完成（{0}）。', { 0: formatBytes(after.bytes) })
        : t('必备资源已预载完成；可选资源按需加载。')
        : t('已保存 {count}/{total} 个文件；未完成的会在下次开启时重试。', { count: after.count, total: after.total }),
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      const now = await store.status().catch(() => null);
      set({ ...(now ? counters(now) : {}), phase: 'paused', message: current ? t('已暂停，可继续下载或清理缓存。') : t('已停止预载。') });
      return;
    }
    const message = err?.name === 'QuotaExceededError' || /quota|空间不足/i.test(String(err?.message || ''))
      ? t('浏览器存储空间不足：已保存的文件保留，可清理缓存后重试。')
      : t('预载失败：{0}', { 0: err?.message || err });
    const now = await store.status().catch(() => null);
    set({ ...(now ? counters(now) : {}), phase: 'error', message, error: true });
  }
}

/** Stop downloading (keeps what is cached). */
export function pauseResources() {
  tasks.invalidate();
  wantRun = false;
  tasks.archive.controller?.abort();
  if (tasks.download.controller) {
    tasks.download.controller.abort();
    set({ phase: 'paused', message: t('已暂停，可继续下载或清理缓存。') });
  }
}

/** ZIP support stays out of the initial module graph. An import can be started before enabling network preloading. */
export async function importResources(file, { onImported } = {}) {
  const revision = tasks.revision;
  const outcome = await transferArchive('import', file);
  if (revision !== tasks.revision) return outcome;
  // Persist the UI setting after a successful import, then enable/resume the selected incremental downloads.
  onImported?.();
  const run = current ? startResources() : syncResources(true, optional, voiceLang, allVoices,
    { keys: skinKeys, all: allSkins, fx, voices });
  void run.catch((err) => console.warn('[resources] enable after import failed', err));
  return outcome;
}

export async function exportResources() {
  const resume = current && wantRun && !!tasks.download.promise;
  const revision = tasks.revision;
  try { return await transferArchive('export'); }
  finally {
    if (resume && current && revision === tasks.revision) void startResources();
  }
}

function transferArchive(kind, file) {
  if (tasks.archive.promise || tasks.clear) return Promise.reject(new Error('资源包正在处理中'));
  wantRun = false;
  set({ archive: kind, archiveResult: null, archivePhase: '', archivePercent: 0, archiveGroup: '',
    message: kind === 'import' ? t('正在准备导入资源包…') : t('正在准备导出资源包…'), error: false });
  return tasks.run('archive', async (task) => {
    const { signal } = task;
    const set = task.publish(stateStore.set);
    try {
      const ctx = await resourceContext();
      if (!ctx.store) throw new Error(ctx.error || ctx.unsupported || '服务器没有可预载的资源');
      checkAbort(signal);
      ctx.store.setScope(storeScope());
      const outcome = await withDownloadLock(() => withWorkerWritesPaused(async () => {
        set(counters(await ctx.store.status()));
        const archive = await import('./archive.js');
        checkAbort(signal);
        let lastTime = -Infinity;
        let lastPhase = '';
        const onProgress = (p) => {
          if (signal.aborted) return;
          const now = performance.now();
          // Keep hashing/cache writes running at full speed. UI and category aggregation run at most twice a second;
          // phase boundaries and completion always publish immediately, without timers that could outlive the job.
          if (p.phase === lastPhase && p.done < p.total && now - lastTime < 500) return;
          lastTime = now;
          lastPhase = p.phase;
          const percent = p.total > 0 ? Math.min(100, Math.floor(p.done * 100 / p.total)) : 100;
          const status = p.getStatus?.();
          set({ ...(status ? counters(status) : {}), archivePhase: p.phase, archivePercent: percent,
            archiveGroup: p.file ? resourceGroup(p.file) : '',
            message: t('{0}资源包：{percent}%', { 0: p.phase === 'export' ? t('正在导出') : p.phase === 'verify' ? t('正在校验') : t('正在导入'), percent }) });
        };
        return kind === 'import'
          ? archive.importResourceZip(ctx.store, file, { signal, onProgress,
            onPlan: (plan) => updateStorage(ctx.store, null, plan, set),
            onDiagnostics: (timings) => console.info('[resources] ZIP import timings', timings) })
          : archive.exportResourceZip(ctx.store, { signal, onProgress });
      }));
      if (outcome.busy) throw new Error('另一个标签页正在处理资源，请暂停后重试');
      checkAbort(signal);
      set({ archivePhase: '', archiveGroup: '' });
      const status = await ctx.store.status();
      await updateStorage(ctx.store, status, undefined, set);
      const missing = (status.tier1Wanted - status.tier1Present) + (status.tier2Wanted - status.tier2Present);
      set({ ...counters(status), failed: 0, phase: status.complete ? 'ready' : 'paused',
        message: kind === 'export'
          ? t('已导出 {count} 个资源文件。', { count: outcome.count })
          : t('已导入 {imported} 个资源文件，已有 {already} 个，跳过 {skippedPackage} 个不适用的资源；{2}', { imported: outcome.imported, already: outcome.already || 0, skippedPackage: outcome.skippedPackage, 2: missing === 0 ? t('所选资源已齐全。') : t('所选资源还需下载 {missing} 个文件。', { missing }) }) });
      set({ archiveResult: { kind, status: 'success', imported: outcome.imported || 0, already: outcome.already || 0,
        count: outcome.count, skippedPackage: outcome.skippedPackage || 0, skipReasons: outcome.skipReasons || {}, message: state.message } });
      if (kind === 'import') {
        await ensureWorker().catch((err) => set({ worker: t('预载服务未启用（{0}）', { 0: err?.message || err }) }));
      }
      checkAbort(signal);
      return outcome;
    } catch (err) {
      const ctx = await resourceContext();
      const status = await ctx.store?.status().catch(() => null);
      const aborted = err?.name === 'AbortError';
      set({ ...(status ? counters(status) : {}), phase: aborted ? 'paused' : 'error', error: !aborted,
        message: aborted ? t('资源包处理已取消，已保存的资源保留。')
          : isQuotaError(err) || /空间不足/i.test(String(err?.message || '')) ? t('浏览器存储空间不足，已保存的资源保留，可清理后重试。')
            : t('资源包{0}失败：{1}', { 0: kind === 'import' ? t('导入') : t('导出'), 1: err?.message || err }) });
      set({ archiveResult: { kind, status: aborted ? 'cancelled' : 'error', message: state.message } });
      throw err;
    }
  }, () => { set({ archive: '', archivePhase: '', archiveGroup: '' }); });
}

/**
 * Delete every cached resource (all versions) and stop.
 */
export function clearResources({ optionalOnly = false } = {}) {
  if (tasks.clear) return tasks.clear;
  tasks.invalidate();
  wantRun = false;
  set({ clearing: true });
  return tasks.run('clearing', async (task) => {
    const set = task.publish(stateStore.set);
    try {
      const ctx = await resourceContext();
      if (ctx.store?.running) { try { await ctx.store.running; } catch { /* aborted */ } }
      const outcome = await withDownloadLock(() => withWorkerWritesPaused(async () => {
        let status;
        if (ctx.store) status = await ctx.store.clear({ optionalOnly });
        else if (optionalOnly) throw new Error('无法读取资源清单，请重试或清理全部资源');
        else if (globalThis.caches) {
          const names = await caches.keys();
          await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX)).map((name) => caches.delete(name)));
        }
        if (!current) { await workerPromise; await dropWorker(); }
        return { busy: false, status };
      }));
      if (outcome.busy) {
        set({ error: true, message: t('另一个标签页正在预载，请先暂停该标签页再清理缓存。') });
        return outcome;
      }
      const status = outcome.status;
      if (status) { set(counters(status)); await updateStorage(ctx.store, status, undefined, set); }
      set({ failed: 0, failures: [], error: false, archiveResult: null,
        phase: current ? 'paused' : 'off',
        message: optionalOnly ? t('已清理可选资源缓存，必备资源和个人设置保留。') : t('已清理预载资源缓存。'),
      });
      return outcome;
    } catch (err) {
      set({ error: true, message: t('清理缓存失败：{0}', { 0: err?.message || err }) });
      return { busy: false, error: true };
    }
  }, () => { set({ clearing: false }); });
}

/** Opening the manager checks the cache without starting network asset downloads. */
export async function inspectResources() {
  // An active run already publishes authoritative counters; opening the panel must not enqueue another cache scan.
  if (tasks.busy) return;
  const isCurrent = tasks.inspection();
  const set = (patch) => { if (isCurrent()) stateStore.set(patch); };
  if (!tasks.download.promise && !tasks.archive.promise) set({ phase: 'checking', error: false, message: t('正在检查已保存的资源…') });
  const ctx = await resourceContext();
  if (!isCurrent()) return;
  if (!ctx.store) {
    set({ phase: 'error', supported: !ctx.unsupported, error: true, message: ctx.error || ctx.unsupported || t('服务器没有可预载的资源') });
    // A later open can retry a temporarily unavailable manifest.
    contextPromise = null;
    return;
  }
  try {
    if (tasks.download.promise || tasks.archive.promise || tasks.clear) return;
    const revision = tasks.revision;
    ctx.store.setScope(storeScope());
    const status = await ctx.store.status();
    await updateStorage(ctx.store, status, undefined, set);
    if (tasks.download.promise || tasks.archive.promise || tasks.clear || revision !== tasks.revision) return;
    set({ ...counters(status), version: ctx.manifest.version, supported: true,
      ...(!tasks.download.promise && !tasks.archive.promise ? { phase: status.complete ? 'ready' : 'paused', message: '', error: false } : {}) });
  } catch (err) {
    set({ phase: 'error', error: true, message: t('无法读取本机资源缓存：{0}', { 0: err?.message || err }) });
  }
}
