// Adapted from xinhai-ai/Stronghold-Protocol (GPL-3.0-or-later).
// public/js/resources/store.js — the preload store: downloads the manifest's files into Cache Storage and reports what
// is already there (docs/ASSETS.md「Preload」).
//
// One cache per preload card (`resourceScope`, common.js) holds that card's assets, whatever manifest they came from, and
// each file's *hash* decides whether the stored bytes are still current: an asset update re-downloads the changed files
// only (~310 MiB → a few MiB), and a re-run of the extraction or a redeploy with unchanged art costs nothing. Each card
// keeps its own index entry (`/__sp-resource-index__`, absolute URL → hash), written as the run advances — an interrupted
// run keeps the progress it flushed. The cards also keep every listing enumerable: the browser refuses one `Cache.keys()`
// above ~10 MiB of keys, which a complete 干员语音 + 干员皮肤 + 官方特效 preload reaches (docs/ASSETS.md「Preload」).
//
// The current worker verifies/writes once and acknowledges over a private channel; the page owns the index.
// Without a compatible worker the page does the downloading (`fetch` plus `cache.put`), so a page without a Service Worker
// still builds the cache and only *serving it from the cache* needs one. Files are fetched with `cache: 'no-store'` on
// purpose: they are stored in Cache Storage, and letting the HTTP cache keep a second copy would double the disk the
// browser needs (~250 MiB of art). Everything is injected (`caches`, `fetcher`) so this module is unit-testable.

import { markResourceHeaders, cacheIndex, readCacheIndex } from './cacheMetadata.js';
import { resourceIdentity } from '../../../shared/resourcePaths.js';
import { VOICE_LANGS } from '../voicePrefs.js';
import { absoluteUrl, CACHE_NAME, CACHE_PREFIX, cacheNameForScope, checkAbort, CONTENT_HASH_RE, indexUrl, isCacheQueryLimit, isQuotaError, isSkinKey, MAX_FILE_BYTES, RESOURCE_GROUPS, RESOURCE_SCOPES, resourceGroup, resourceScope, resourceType, SHARD_CACHE_NAMES, TIER_ESSENTIAL, TIER_REST } from './common.js';
import { resourceDigests, verifiedResourceBytes } from './integrity.js';
import { fetchResource } from './network.js';

/** Files above this are downloaded one at a time (a 20 MiB Spine texture should not race three others). */
const BIG_FILE_BYTES = 4 << 20;
/** Failures kept for the UI (the count is always exact). */
const MAX_FAILURES = 10;
/** Successful files between two index writes (a flush is one put of a few KiB; 64 keeps an abort at ~1 % loss). */
const INDEX_FLUSH_EVERY = 64;
const SMALL_IMPORT_BYTES = 256 * 1024;
const IMPORT_BUFFER_BYTES = 4 * SMALL_IMPORT_BYTES;

/**
 * The 干员皮肤 selection: the `charId/skinId` keys the player has equipped in this browser. An empty set means no skin
 * is preloaded, which is the default (a full install is ~328 MiB, docs/SKINS.md). Accepts a list, a Set, `{ keys }` or
 * `'off'`/null; anything that is not a skin key is dropped, so a hand-edited settings blob cannot widen the selection.
 * @param {Iterable<string>|{ keys?: Iterable<string> }|'off'|null} [raw]
 * @returns {Set<string>}
 */
export function normalizeSkinKeys(raw = null) {
  if (raw === 'off' || raw == null) return new Set();
  // A Set advertises `keys` as a *method*, so it has to be taken apart before the `{ keys }` shape is read.
  const list = raw instanceof Set ? [...raw] : Array.isArray(raw) ? raw : (typeof raw === 'object' && raw.keys != null ? [...raw.keys] : []);
  return new Set(list.filter(isSkinKey));
}

/**
 * The 干员皮肤 scope: the equipped keys to follow, or every outfit the manifest offers (`all`). A full install is
 * ~328 MiB, so 全部皮肤 is always an explicit choice (设置 ▸ 预载资源 ▸ 全部皮肤): it never rides 额外资源,
 * and an install without skins has nothing for it to widen (docs/SKINS.md).
 * @param {Iterable<string>|{ keys?: Iterable<string>, all?: boolean }|'all'|'off'|null} [raw]
 * @returns {{ keys: Set<string>, all: boolean }}
 */
export function normalizeSkinScope(raw = null) {
  if (raw === 'all') return { keys: new Set(), all: true };
  if (raw === 'off' || raw == null) return { keys: new Set(), all: false };
  const all = !(raw instanceof Set) && !Array.isArray(raw) && typeof raw === 'object' && raw.all === true;
  return { keys: normalizeSkinKeys(raw), all };
}

/** Whether two skin selections ask for the same thing (`setScope` uses it to skip a no-op rebuild). */
function sameSkinKeys(a, b) {
  if (a.size !== b.size) return false;
  for (const key of a) if (!b.has(key)) return false;
  return true;
}

/**
 * The 12-hex SHA-1 of a response body — the same digest the server puts in the manifest (tools/asset-hashes.mjs,
 * tools/local-extract/extract.py). WebCrypto has no streaming digest, so one file is read at a time (Big files go
 * through the single big-file lane, so at most one of them is ever in memory).
 * @param {Response} response
 * @param {{ consume?: boolean }} [opts]
 * @returns {Promise<string>} rejects when verification cannot be completed
 */
async function digestOf(response, { consume = false } = {}) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前浏览器无法计算资源指纹');
  try {
    return (await resourceDigests(await (consume ? response : response.clone()).arrayBuffer())).hash;
  } catch (cause) {
    throw new Error('无法校验资源内容，请重试', { cause });
  }
}

export class ResourceStore {
  /** Cache names whose whole-cache `keys()` query the browser refuses: the page-owned index answers instead. */
  #keysRefused = new Set();
  /** Key → recorded hash across every card, as of the last `status()`: `#download` reads that snapshot instead of
   *  opening and parsing four indexes again (only `#status()` writes it). */
  #indexSnapshot = new Map();

  /**
   * @param {{ files: { url: string, tier: number, size?: number, hash?: string }[], version: string, totalBytes?: number|null }} manifest
   * @param {{ caches?: any, fetcher?: typeof fetch, origin?: string, smallLanes?: number, bigLanes?: number,
   *           now?: () => number, network?: any, schedule?: any, ensureCached?: any }} [opts]
   */
  constructor(manifest, { caches = globalThis.caches, fetcher = globalThis.fetch?.bind(globalThis), origin, smallLanes = 4, bigLanes = 1, now = () => Date.now(), network = {}, schedule = null, ensureCached = null } = {}) {
    this.manifest = manifest;
    this.files = Array.isArray(manifest.files) ? manifest.files : [];
    this.voiceLanguages = [...new Set(this.files.filter((f) => resourceGroup(f) === 'voice')
      .map((f) => /\/voice\/([^/]+)\//.exec(new URL(f.url, 'https://resources.invalid').pathname)?.[1]).filter(Boolean))];
    this.caches = caches;
    this.fetcher = fetcher;
    this.origin = origin || globalThis.location?.origin || 'http://localhost';
    this.smallLanes = Math.max(1, smallLanes);
    this.bigLanes = Math.max(1, bigLanes);
    this.now = now;
    this.network = network;
    this.schedule = schedule;
    this.ensureCached = ensureCached;
    // The catch-all card keeps the pre-split name; `shardName(file)` picks the card a manifest entry lives in.
    this.cacheName = CACHE_NAME;
    /** @type {Promise<any> | null} */
    this.running = null;
    this.statusPromise = null;
    /** @type {string|null} voice language the selection keeps, or null for every language. */
    this.voiceScope = null;
    /** @type {boolean} whether the optional (tier 2) set is part of the selection at all. */
    this.optional = true;
    this.voices = true;
    /** @type {Set<string>} the 干员皮肤 (`charId/skinId`) this browser has equipped (docs/SKINS.md). */
    this.skins = normalizeSkinKeys('off');
    /** @type {boolean} 全部皮肤: want every outfit the manifest offers, whatever 干员调配 has equipped. */
    this.allSkins = false;
    /** @type {boolean} 官方特效 (`data/local-fx.json`, docs/design/vfx-format.md): the panel's third switch. */
    this.fx = true;
    // The default selection is already scoped (no skins), not just an alias for "everything".
    this.scopedFiles = this.files.filter((file) => this.inScope(file));
  }

  /**
   * The preload selection — which optional files are wanted (`optional`), which voice language (`voiceLang` /
   * `allVoices`), which 干员皮肤 (`skins` — the equipped ones, or every outfit with `all`) and whether 官方特效
   * (`fx`) ride along. It narrows download and status only: every manifest entry stays importable and retained, so a
   * ZIP import or an older cache still counts.
   *
   * 干员皮肤 and 官方特效 ride switches of their own rather than 「额外资源」: a player who wants a handful of outfits
   * should not have to take every voice, soundtrack and effect as well, and one who wants the soundtrack should not
   * get 328 MiB of skins or 185 MiB of effects.
   * @param {{ optional?: boolean, voices?: boolean, voiceLang?: string, allVoices?: boolean, fx?: boolean,
   *           skins?: Iterable<string>|{ keys?: Iterable<string>, all?: boolean }|'all'|'off'|null }} [scope]
   */
  setScope({ optional = this.optional, voices = optional, voiceLang = 'cn', allVoices = false, skins = null, fx = this.fx } = {}) {
    const voice = allVoices ? null : (VOICE_LANGS.includes(voiceLang) ? voiceLang : 'cn');
    const next = normalizeSkinScope(skins);
    if (voice === this.voiceScope && !!optional === this.optional && next.all === this.allSkins
      && sameSkinKeys(next.keys, this.skins) && !!fx === this.fx && !!voices === this.voices) return;
    this.voiceScope = voice;
    this.optional = !!optional;
    this.voices = !!voices;
    this.skins = next.keys;
    this.allSkins = next.all;
    this.fx = !!fx;
    this.scopedFiles = this.files.filter((file) => this.inScope(file));
    this.statusPromise = null;
  }

  /** Language + all-voices only (the shape the voice panel and the older callers use). */
  setVoiceScope(language = 'cn', all = false) {
    this.setScope({ voiceLang: language, allVoices: all, voices: this.voices });
  }

  /** Whether a manifest entry is part of what this selection downloads and counts. */
  inScope(file) {
    // 官方特效 is not bound to `optional`: unchecking 额外资源 keeps the effects (and the other way round) — each
    // switch means exactly what its own label says (`public/js/ui/resourcePanel.js`).
    if (file.fx) { if (!this.fx) return false; }
    else if (file.skin) { if (!this.skinWanted(file)) return false; }
    else if (file.tier === TIER_REST && resourceGroup(file) === 'voice') { if (!this.voices) return false; }
    else if (file.tier === TIER_REST && !this.optional) return false;
    return this.languageOk(file);
  }

  /**
   * The voice-language half of `inScope` on its own: the panel's per-group figures span the whole manifest and only
   * the language knob narrows them, since that knob picks files rather than a scope (docs/ASSETS.md).
   */
  languageOk(file) {
    if (!this.voiceScope) return true;
    const language = /\/assets\/audio\/voice\/([^/]+)\//.exec(new URL(file.url, this.origin).pathname)?.[1];
    return !language || language === this.voiceScope;
  }

  /** Whether this file's skin is wanted: 全部皮肤 takes them all, otherwise only the equipped ones. */
  skinWanted(file) {
    return isSkinKey(file?.skin) && (this.allSkins || this.skins.has(file.skin));
  }

  /** The equipped skin keys this store is scoping by (sorted, for the status payload and for tests). */
  skinKeys() {
    return [...this.skins].sort();
  }

  /** The skin scope as the status payload reports it: the equipped keys, and whether every outfit is wanted. */
  skinScope() {
    return { keys: this.skinKeys(), all: this.allSkins };
  }

  get selectedFiles() { return this.scopedFiles; }

  /** Cache key (absolute URL) of a manifest entry. */
  keyOf(url) {
    return absoluteUrl(url, this.origin) || String(url);
  }

  /** read(file) returns bytes or a locally verified resource. Callers own the download lock. */
  async importFiles(files, { read, signal, onProgress } = {}) {
    const entries = async function* () {
      for await (const file of files) yield { files: [file], size: file.size, read: () => read(file) };
    };
    return this.importEntries(entries(), { signal, onProgress, concurrency: 1 });
  }

  /** Entries own their verifier so the producer can advance without sharing a mutable current-resource slot. */
  async importEntries(entries, { signal, onProgress, onDiagnostics, concurrency = 4 } = {}) {
    checkAbort(signal);
    if (this.running) throw new Error('请先暂停资源下载');
    const lanes = Number.isInteger(concurrency) ? Math.max(1, Math.min(4, concurrency)) : 4;
    const cards = new Map();
    // One card per name, memoized as a *promise*: four lanes reach the same name at once, and a memoized state
    // object would let each of them read the index separately and then flush only whichever object won the map.
    const card = (name) => {
      let pending = cards.get(name);
      if (!pending) {
        pending = (async () => {
          const cache = await this.caches.open(name);
          return { name, cache, index: await this.#readIndex(cache), dirty: false };
        })();
        cards.set(name, pending);
      }
      return pending;
    };
    // The flag lives on the card, not on the index object, and is set beside every index write.
    const flushIndexes = async () => {
      for (const state of await Promise.all(cards.values())) {
        if (!state.dirty) continue;
        state.dirty = false;
        await this.#writeIndex(state.cache, state.index.files, this.manifest.version);
      }
    };
    const before = await this.status();
    const allowed = new Set(this.files);
    const groups = new Map(before.groups.map((group) => [group.id, group]));
    const byKey = new Map();
    for (const file of this.selectedFiles) {
      if (!this.eligible(file)) continue;
      const key = this.keyOf(file.url);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(file);
    }
    let imported = 0;
    let already = 0;
    let processed = 0;
    let failed = false;
    let failure;
    let inFlightBytes = 0;
    let indexFlush = Promise.resolve();
    const pending = new Set();
    const timings = { cacheCheckMs: 0, cacheWriteMs: 0, cacheWriteCount: 0, indexWriteMs: 0, maxInFlight: 0, maxInFlightBytes: 0 };
    const started = performance.now();
    const fail = (err) => { if (!failed) { failed = true; failure = err; } };
    const check = () => { if (failed) throw failure; checkAbort(signal); };
    const writeIndex = async () => {
      const start = performance.now();
      try { await flushIndexes(); }
      finally { timings.indexWriteMs += performance.now() - start; }
    };
    // Update counters per completed key; publishing copies only the small category list, not the whole manifest.
    const getStatus = () => {
      const { present: _present, ...status } = before;
      return { ...status, groups: before.groups.map((group) => ({ ...group })) };
    };
    const markPresent = (key) => {
      if (before.present.has(key)) return;
      before.present.add(key);
      for (const file of byKey.get(key) || []) {
        before.count++;
        if (file.tier === TIER_ESSENTIAL) before.tier1Present++; else before.tier2Present++;
        const group = groups.get(resourceGroup(file));
        group.allPresent++;
        if (Number.isSafeInteger(file.size)) group.allCached += file.size;
        group.present++;
        if (Number.isSafeInteger(file.size)) { before.bytes += file.size; before.sized++; group.bytes += file.size; }
      }
      before.complete = before.wanted > 0 && before.count >= before.wanted;
    };
    const one = async (entry) => {
      check();
      for (const file of entry.files) {
        if (!allowed.has(file) || !this.eligible(file) || !CONTENT_HASH_RE.test(file.hash || '')) {
          throw new Error('资源缺少可校验的当前指纹');
        }
      }
      // ZIP entries, including skipped/already-cached ones, must verify before inspecting their cache destinations.
      const prepared = entry.verify ? await entry.verify() : null;
      let currentFile = entry.files[0];
      for (const file of entry.files) {
        currentFile = file;
        check();
        const key = this.keyOf(file.url);
        const state = await card(this.shardName(file));
        const { cache, index } = state;
        const cacheStart = performance.now();
        let current;
        try {
          const existing = before.present.has(key) ? await cache.match(key) : null;
          current = !!existing && await digestOf(existing, { consume: true }) === file.hash;
        } finally { timings.cacheCheckMs += performance.now() - cacheStart; }
        if (current) already++;
        if (!current) {
          const data = prepared || await entry.read();
          const verifiedBytes = verifiedResourceBytes(data, file.hash);
          const bytes = verifiedBytes || data;
          if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_FILE_BYTES
            || (file.size != null && bytes.byteLength !== file.size)
            || (entry.size != null && bytes.byteLength !== entry.size)) throw new Error(`资源大小无效：${file.url}`);
          if (!verifiedBytes) {
            const { hash } = await resourceDigests(bytes);
            if (hash !== file.hash) throw new Error(`资源校验失败：${file.url}`);
          }
          check();
          const response = new Response(bytes, { headers: { 'Content-Type': resourceType(new URL(file.url, this.origin).pathname), 'Content-Length': String(bytes.byteLength) } });
          const writeStart = performance.now();
          timings.cacheWriteCount++;
          try { await cache.put(key, this.storable(response, file.hash)); }
          finally { timings.cacheWriteMs += performance.now() - writeStart; }
          // A put cannot be cancelled: always index successful writes, even when another lane has since failed.
          index.files[key] = file.hash;
          state.dirty = true;
          markPresent(key);
          imported++;
          if (imported % INDEX_FLUSH_EVERY === 0) {
            indexFlush = indexFlush.then(writeIndex);
            await indexFlush;
          }
        }
      }
      onProgress?.({ imported, processed: ++processed, file: currentFile, getStatus });
    };
    try {
      onProgress?.({ imported, processed, getStatus });
      for await (const entry of entries) {
        check();
        const size = Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : MAX_FILE_BYTES;
        const exclusive = size > SMALL_IMPORT_BYTES;
        while (pending.size && (exclusive || pending.size >= lanes || inFlightBytes + size > IMPORT_BUFFER_BYTES)) {
          await Promise.race(pending);
          check();
        }
        checkAbort(signal);
        inFlightBytes += size;
        const task = one(entry).catch(fail).finally(() => { pending.delete(task); inFlightBytes -= size; });
        pending.add(task);
        timings.maxInFlight = Math.max(timings.maxInFlight, pending.size);
        timings.maxInFlightBytes = Math.max(timings.maxInFlightBytes, inFlightBytes);
        if (exclusive) {
          await task;
          check();
        }
      }
    } catch (err) { fail(err); }
    await Promise.all(pending);
    try { checkAbort(signal); } catch (err) { fail(err); }
    try { await writeIndex(); } catch (err) { fail(err); }
    const report = { ...timings, durationMs: performance.now() - started, imported, processed, failed,
      errorName: failed ? failure?.name || 'Error' : '', stageTimeMode: 'sum-of-overlapping-operations',
      averageCacheWriteMs: timings.cacheWriteCount ? timings.cacheWriteMs / timings.cacheWriteCount : 0 };
    try { onDiagnostics?.(report); } catch { /* diagnostics must not affect verified imports */ }
    if (failed) throw failure;
    return { ...await this.status(), imported, already, timings: report };
  }

  /**
   * The hashes of what this cache holds: `<absolute url>` → hash. A missing or unreadable index means "nothing is
   * verified": existing bodies must be checked against their content hash before they can be reused.
   * @param {any} cache
   */
  async #readIndex(cache) {
    let doc = null;
    try {
      const res = await cache.match(indexUrl(this.origin));
      if (res) doc = await res.json();
    } catch { doc = null; }
    return readCacheIndex(doc);
  }

  /** Write the index entry (the only synthetic entry of the cache; the worker never answers it: not /assets|/fonts). */
  async #writeIndex(cache, files, manifest) {
    const body = JSON.stringify(cacheIndex(files, manifest));
    await cache.put(indexUrl(this.origin), new Response(body, { headers: { 'Content-Type': 'application/json' } }));
    this.statusPromise = null;
  }

  /** A file this store will fetch: small enough to be worth caching (a huge one is skipped, never fails the run). */
  eligible(file) {
    return !(Number.isSafeInteger(file.size) && file.size > MAX_FILE_BYTES);
  }

  /** The response we store: original type, `Accept-Ranges` (the worker answers ranges) and our marker. */
  storable(response, verifiedHash = '') {
    const headers = new Headers();
    const type = response.headers.get('content-type');
    if (type) headers.set('Content-Type', type);
    // A stored body must never claim a length it does not have: `fetch` hands us the DECODED body, so a compressed
    // transfer's Content-Length (372 for a 100 000-byte gzipped .skel) would describe the wrong bytes and the browser
    // would truncate it. Keep the header only when the response was not content-encoded — there it is exactly the
    // length we store (and DevTools' Cache Storage view can show a size instead of 0).
    if (!response.headers.get('content-encoding')) {
      const raw = response.headers.get('content-length');
      const len = raw == null ? NaN : Number(raw);
      if (Number.isSafeInteger(len) && len >= 0) headers.set('Content-Length', String(len));
    }
    markResourceHeaders(headers, verifiedHash);
    return new Response(response.body, { status: 200, statusText: 'OK', headers });
  }

  /**
   * What is already cached *and current*: `present` holds the absolute URLs whose stored bytes match the manifest's
   * hash, plus every counter the settings panel shows. An entry of another revision (or with no index record yet) does
   * not count, which is what makes the next run fetch it again.
   */
  async status() {
    if (!this.statusPromise) {
      const pending = this.#status().finally(() => { if (this.statusPromise === pending) this.statusPromise = null; });
      this.statusPromise = pending;
    }
    const status = await this.statusPromise;
    // Coalesce only in-flight reads. Each caller gets its own counters/set; later calls check real cache eviction.
    return { ...status, groups: status.groups.map((group) => ({ ...group })),
      skins: (status.skins || []).map((skin) => ({ ...skin })),
      skinScope: { keys: [...(status.skinScope?.keys || [])], all: !!status.skinScope?.all },
      present: new Set(status.present) };
  }

  /**
   * Every key the cache holds, as absolute URLs. `Cache.keys()` is ONE query whose answer the browser builds from every
   * entry: Chrome refuses it once that answer would exceed ~10 MiB of serialized requests
   * (`kMaxQueryCacheResultBytes` in content/browser/cache_storage/cache_storage_cache.cc — about 16 000 entries at this
   * manifest's URL length) and hands back an AbortError reading "Operation too large.". Above that line the page-owned
   * index is the authority instead: it records every entry this store wrote (the ZIP import included), and an entry with
   * no record never counted as current anyway (`#fresh`), so the numbers stay right. What the fallback loses is noticing
   * browser-side eviction of an *indexed* entry — `ensureCached`/`#adopt` verify those bytes again on the next run.
   * Only that refusal falls back: any other failure of the query is a real failure and has to surface (a status that
   * quietly reported "nothing is cached" would hide it).
   * @param {any} cache
   * @param {string} name cache name (a refusal is remembered per name — size class, not one unlucky call)
   */
  async #keyUrls(cache, name) {
    if (!this.#keysRefused.has(name)) {
      try { return new Set((await cache.keys()).map((key) => key.url)); }
      catch (err) {
        if (!isCacheQueryLimit(err)) throw err;
        this.#keysRefused.add(name);
        console.warn('[resources] Cache.keys() refused — reading the resource index instead', err);
      }
    }
    const index = await this.#readIndex(cache);
    return new Set(Object.keys(index.files));
  }

  /** Which card a manifest entry lives in (`essential` / `voice` / `skin` / `fx`). */
  scopeOf(file) {
    return resourceScope(file);
  }

  /** The Cache Storage name of that card. */
  shardName(file) {
    return cacheNameForScope(resourceScope(file));
  }

  /** Every cache of this app: the four cards first, then the leftovers of older layouts. */
  async #cacheNames() {
    const names = ((await this.caches.keys()) || []).filter((n) => n.startsWith(CACHE_PREFIX));
    return [...SHARD_CACHE_NAMES.filter((n) => names.includes(n)), ...names.filter((n) => !SHARD_CACHE_NAMES.includes(n))];
  }

  /** The cards this browser has right now, in panel order. Reading status must not create one. */
  async #shards() {
    const existing = new Set((await this.caches.keys()) || []);
    const shards = [];
    for (const name of SHARD_CACHE_NAMES) {
      if (existing.has(name)) shards.push({ name, cache: await this.caches.open(name) });
    }
    return shards;
  }

  /** Every key every cache of this app holds (`archive.js` finds cached-but-unindexed entries through this). Each card
   *  stays enumerable on its own; an older build's cache is asked too, because its entries are still served. */
  async cachedKeys() {
    const keys = new Set();
    for (const name of await this.#cacheNames()) {
      for (const key of await this.#keyUrls(await this.caches.open(name), name)) keys.add(key);
    }
    return keys;
  }

  /** The stored entry of a manifest file: its own card first, then any other cache (an older layout's copy). */
  async cachedResponse(file) {
    return this.cachedResponseFor(this.keyOf(file.url), this.shardName(file));
  }

  /** @param {string} key absolute URL @param {string} [preferred] cache name to look in first */
  async cachedResponseFor(key, preferred = '') {
    const names = await this.#cacheNames();
    const ordered = preferred && names.includes(preferred) ? [preferred, ...names.filter((n) => n !== preferred)] : names;
    for (const name of ordered) {
      const hit = await (await this.caches.open(name)).match(key);
      if (hit) return hit;
    }
    return null;
  }

  /** A reader for a whole export — `(key, preferred) => Promise<Response|null>` over the caches that exist right now
   *  (`archive.js` asks for tens of thousands of entries: the list is resolved once, not per file). */
  async entryReader() {
    const cards = await Promise.all((await this.#cacheNames()).map(async (name) => ({ name, cache: await this.caches.open(name) })));
    return async (key, preferred = '') => {
      for (const card of cards) if (card.name === preferred) { const hit = await card.cache.match(key); if (hit) return hit; }
      for (const card of cards) { if (card.name === preferred) continue; const hit = await card.cache.match(key); if (hit) return hit; }
      return null;
    };
  }

  async #status() {
    const started = performance.now();
    let keysMs = 0;
    let indexMs = 0;
    let refused = false;
    let misplaced = false;
    let stale = false;
    const cached = new Set();
    const files = new Map();
    const indexKey = indexUrl(this.origin);
    // What every manifest entry is called and which card it belongs in: a listing can then tell whether some card holds
    // an entry that belongs elsewhere (#tidy) or one the manifest no longer wants (prune), instead of both passes
    // enumerating every card again on a run that changes nothing.
    const byKey = new Map(this.files.map((f) => [this.keyOf(f.url), f]));
    await Promise.all((await this.#shards()).map(async ({ name, cache }) => {
      // One query for the keys and one index read, started together: the pair is what makes a status check a
      // single round of cache metadata reads, and a refused enumeration must not delay the index by a whole query.
      // The two timers are read where each promise settles — reading them after `Promise.all` would report the
      // slower of the pair twice and hide which half a slow status check actually spent its time in.
      const keysStart = performance.now();
      const keysRead = this.#keyUrls(cache, name).then((value) => { keysMs += performance.now() - keysStart; return value; });
      const indexStart = performance.now();
      const indexRead = this.#readIndex(cache).then((value) => { indexMs += performance.now() - indexStart; return value; });
      const [keys, index] = await Promise.all([keysRead, indexRead]);
      if (this.#keysRefused.has(name)) refused = true;
      for (const key of keys) {
        cached.add(key);
        if (key === indexKey) continue; // the index document is not an asset of the manifest
        const file = byKey.get(key);
        if (!file) stale = true;
        else if (this.shardName(file) !== name) misplaced = true;
      }
      for (const [key, hash] of Object.entries(index.files)) {
        files.set(key, hash);
        if (!byKey.has(key)) stale = true; // a record of a file the manifest dropped
      }
    }));
    const fresh = this.#fresh(cached, files);
    // `#download` inherits the alias map from here: every card was just read, so no index has to be parsed twice.
    this.#indexSnapshot = files;
    // A refused listing answers from the index, which says nothing about where an entry actually sits: the run has to
    // look for itself.
    if (refused) misplaced = true;
    return { ...this.#tally(fresh), present: fresh, scan: refused ? 'index' : 'keys', misplaced, stale,
      checkTimings: { statusMs: performance.now() - started, cacheKeysMs: keysMs, indexReadMs: indexMs } };
  }

  /** The subset of `cached` whose recorded hash equals the manifest's (an entry without a hash counts as current). */
  #fresh(cached, files) {
    const fresh = new Set();
    for (const f of this.files) {
      const key = this.keyOf(f.url);
      if (!cached.has(key)) continue;
      if (f.hash && files.get(key) !== f.hash) continue;
      fresh.add(key);
    }
    return fresh;
  }

  /** Caches of earlier builds this app wrote: their entries carry no hash record and are verified before being kept. */
  async #olderCaches() {
    return (await this.#cacheNames()).filter((n) => !SHARD_CACHE_NAMES.includes(n));
  }

  /** Fetch a file and hand back a storable response (an opaque or empty or failed answer throws). */
  async #fetchStorable(url, signal) {
    return fetchResource(url, { ...this.network, fetcher: this.fetcher, signal });
  }

  /**
   * Recover an unindexed current entry or a file from the previous layout instead of downloading it again: hash the bytes and, when
   * they are exactly the revision this manifest wants, move the entry into the current cache. A mismatching entry is
   * dropped (the caller downloads the right bytes next) so a stale copy can never shadow the fresh one.
   * @returns {Promise<boolean>} true when the file needed no network at all
   */
  async #adopt(file, cache, older, aliases, signal) {
    const key = this.keyOf(file.url);
    const alias = aliases.get(resourceIdentity(key));
    if (file.hash && CONTENT_HASH_RE.test(file.hash) && alias?.hash === file.hash && alias.key !== key) {
      const hit = await this.cachedResponseFor(alias.key, this.shardName(file));
      if (hit) { await cache.put(key, hit); return true; }
    }
    if (!file.hash || !CONTENT_HASH_RE.test(file.hash)) return false; // nothing to compare against
    // A tab can close after cache.put but before the batched index flush. Recover those
    // already-downloaded bytes instead of asking the network for the same file again.
    const current = await cache.match(key);
    if (current) {
      if (await this.ensureCached?.(file, { signal, cachedOnly: true })) return true;
      if ((await digestOf(current)) === file.hash) return true;
      // Otherwise the active worker could serve this stale copy to our next fetch,
      // requiring another request with the integrity-retry query.
      await cache.delete(key);
    }
    for (const name of older) {
      const other = await this.caches.open(name);
      const hit = await other.match(key);
      if (!hit) continue;
      if ((await digestOf(hit)) === file.hash) {
        await cache.put(key, hit); // same bytes, now in the current cache…
        await other.delete(key); // …and gone from the old one: never two copies, never a stale shadow
        return true;
      }
      await other.delete(key);
    }
    return false;
  }

  /** Counters for a set of cached URLs (shared by status() and clear(), which must not re-create a cache). */
  #tally(present) {
    const selected = this.selectedFiles;
    const total = selected.length;
    const scopedSizes = this.voiceScope ? selected.filter((f) => Number.isSafeInteger(f.size)) : null;
    let count = 0;
    let bytes = 0;
    let sized = 0;
    let skipped = 0;
    let tier1 = 0;
    let tier1Present = 0;
    let tier2 = 0;
    let tier2Present = 0;
    let tier1Wanted = 0;
    let tier2Wanted = 0;
    const groups = Object.fromEntries(Object.entries(RESOURCE_GROUPS).map(([id, group]) => [id,
      { id, ...group, total: 0, wanted: 0, present: 0, bytes: 0, totalBytes: 0, unknownSize: 0,
        allTotal: 0, allPresent: 0, allBytes: 0, allCached: 0, allUnknown: 0 }]));
    for (const f of selected) {
      const hit = present.has(this.keyOf(f.url));
      const group = groups[resourceGroup(f)];
      group.total++;
      if (f.tier === TIER_ESSENTIAL) tier1++; else tier2++;
      if (!this.eligible(f)) { skipped++; continue; }
      if (hit) { if (f.tier === TIER_ESSENTIAL) tier1Present++; else tier2Present++; }
      group.wanted++;
      if (Number.isSafeInteger(f.size)) group.totalBytes += f.size;
      else group.unknownSize++;
      if (hit) { group.present++; if (Number.isSafeInteger(f.size)) group.bytes += f.size; }
      if (f.tier === TIER_ESSENTIAL) tier1Wanted++; else tier2Wanted++;
      if (hit) {
        count++;
        if (Number.isSafeInteger(f.size)) { bytes += f.size; sized++; }
      }
    }
    // Per-skin counters for the panel's 干员皮肤 list: every skin the manifest offers (not just the selected ones), so
    // the list can show what is cached, what is wanted and how big each one is. ~2 000 entries, built from the same
    // single pass over `this.files` that the groups need.
    const skins = new Map();
    for (const f of this.files) {
      if (!isSkinKey(f.skin)) continue;
      let entry = skins.get(f.skin);
      if (!entry) {
        entry = { id: f.skin, files: 0, wanted: 0, present: 0, bytes: 0, totalBytes: 0, unknownSize: 0 };
        skins.set(f.skin, entry);
      }
      entry.files++;
      if (Number.isSafeInteger(f.size)) entry.totalBytes += f.size; else entry.unknownSize++;
      // `present` spans every file of the skin (so the list can say 「已保存」 even while the skin is out of scope);
      // `wanted` is what the current selection asks for.
      const cached = present.has(this.keyOf(f.url));
      if (cached) {
        entry.present++;
        if (Number.isSafeInteger(f.size)) entry.bytes += f.size;
      }
      if (!this.inScope(f)) continue;
      entry.wanted++;
    }
    // 官方特效 availability, counted over the whole manifest rather than the selection: the panel decides whether the
    // effect box exists at all, so it has to know the tree is there even while the box itself is switched off —
    // counting the selection instead would delete the way back (docs/design/vfx-format.md).
    let fxFiles = 0;
    let fxPresent = 0;
    for (const f of this.files) {
      if (!f.fx) continue;
      fxFiles++;
      if (present.has(this.keyOf(f.url))) fxPresent++;
    }
    // Per-group figures over the whole manifest — switched-off scopes included, narrowed only by the voice language.
    // The panel draws its cards from these: a box that is off greys out its card instead of
    // deleting it, and no figure moves while boxes are toggled (docs/ASSETS.md).
    // The same pass feeds the per-card figures the ZIP card exports from: one card at a time, and no figure moves
    // while a switch is toggled (docs/ASSETS.md). The catch-all card is the whole tree minus the other three.
    const scopes = new Map(RESOURCE_SCOPES.map((id) => [id, { id, total: 0, cached: 0, bytes: 0, totalBytes: 0 }]));
    for (const f of this.files) {
      if (!this.languageOk(f)) continue;
      const group = groups[resourceGroup(f)];
      const scope = scopes.get(resourceScope(f));
      const stored = present.has(this.keyOf(f.url));
      group.allTotal++;
      scope.total++;
      if (Number.isSafeInteger(f.size)) { group.allBytes += f.size; scope.totalBytes += f.size; } else group.allUnknown++;
      if (stored) {
        group.allPresent++;
        scope.cached++;
        if (Number.isSafeInteger(f.size)) { group.allCached += f.size; scope.bytes += f.size; }
      }
    }
    // Whole-manifest totals, independent of the selection: the per-tier figures only ever add up what is switched
    // on, so the panel needs one honest number for what the entire tree weighs (docs/ASSETS.md).
    let manifestBytes = 0;
    for (const f of this.files) if (Number.isSafeInteger(f.size)) manifestBytes += f.size;
    const wanted = total - skipped;
    return {
      version: this.manifest.version,
      cacheName: this.cacheName,
      count,
      total,
      wanted,
      skipped,
      bytes,
      totalBytes: scopedSizes ? (scopedSizes.length ? scopedSizes.reduce((n, f) => n + f.size, 0) : null)
        : Number.isSafeInteger(this.manifest.totalBytes) ? this.manifest.totalBytes : null,
      sized,
      sizedTotal: scopedSizes ? scopedSizes.length : Number.isSafeInteger(this.manifest.sized) ? this.manifest.sized : null,
      tier1,
      tier1Present,
      tier2,
      tier2Present,
      tier1Wanted,
      tier2Wanted,
      groups: Object.values(groups).filter((g) => g.allTotal > 0),
      scopes: [...scopes.values()],
      // Sorted by key so the panel's list is stable; the UI joins the ids with the skin catalogue for names.
      skins: [...skins.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      manifestFiles: this.files.length,
      manifestBytes,
      voiceLanguages: this.voiceLanguages,
      fxFiles,
      fxPresent,
      skinScope: this.skinScope(),
      complete: wanted > 0 && count >= wanted,
    };
  }

  /**
   * Move entries that sit in a card they do not belong to: an install from before the split keeps every byte in the
   * catch-all cache, and such a file must not be downloaded a second time. One file at a time — copy it with its index
   * record, then delete the old copy — so an interrupted pass never leaves two copies and the extra storage the pass
   * needs is one file. An entry that had no index record does not gain one: the next run verifies its bytes like any
   * other unindexed entry.
   * @returns {Promise<number>} how many entries moved
   */
  async #tidy({ signal } = {}) {
    const cards = new Map();
    // One card per name, memoized as a *promise*: four lanes reach the same name at once, and a memoized state
    // object would let each of them read the index separately and then flush only whichever object won the map.
    const card = (name) => {
      let pending = cards.get(name);
      if (!pending) {
        pending = (async () => {
          const cache = await this.caches.open(name);
          return { name, cache, index: await this.#readIndex(cache), dirty: false };
        })();
        cards.set(name, pending);
      }
      return pending;
    };
    const flush = async () => {
      for (const state of await Promise.all(cards.values())) {
        if (!state.dirty) continue;
        state.dirty = false;
        await this.#writeIndex(state.cache, state.index.files, this.manifest.version);
      }
    };
    const wanted = new Map(this.files.map((f) => [this.keyOf(f.url), f]));
    let moved = 0;
    for (const { name, cache } of await this.#shards()) {
      const source = await card(name);
      for (const key of await this.#keyUrls(cache, name)) {
        checkAbort(signal);
        const file = wanted.get(key);
        if (!file || this.shardName(file) === name) continue;
        const hit = await cache.match(key);
        if (!hit) {
          if (key in source.index.files) { delete source.index.files[key]; source.dirty = true; }
          continue;
        }
        const destination = await card(this.shardName(file));
        await destination.cache.put(key, hit);
        if (key in source.index.files) destination.index.files[key] = source.index.files[key];
        destination.dirty = true;
        await cache.delete(key);
        if (key in source.index.files) delete source.index.files[key];
        source.dirty = true;
        moved++;
        if (moved % INDEX_FLUSH_EVERY === 0) await flush();
      }
      // Smaller now (or verified empty): let the next status try one-shot enumeration again.
      this.#keysRefused.delete(name);
    }
    if (moved) await flush();
    return moved;
  }

  /**
   * Download every missing file (essential tier first). Aborting the signal stops within one file; single file failures
   * are collected instead, so one broken file cannot waste a whole run.
   * @param {{ signal?: AbortSignal, onProgress?: (p: any) => void, tiers?: number[] }} [opts]
   */
  download({ signal, onProgress, tiers = [TIER_ESSENTIAL, TIER_REST] } = {}) {
    if (this.running) return this.running;
    const run = this.#download({ signal, onProgress, tiers }).finally(() => { this.running = null; });
    this.running = run;
    return run;
  }

  async #download({ signal, onProgress, tiers }) {
    const wanted = new Set(tiers);
    const cards = new Map();
    // One card per name, memoized as a *promise*: four lanes reach the same name at once, and a memoized state
    // object would let each of them read the index separately and then flush only whichever object won the map.
    const card = (name) => {
      let pending = cards.get(name);
      if (!pending) {
        pending = (async () => {
          const cache = await this.caches.open(name);
          return { name, cache, index: await this.#readIndex(cache), dirty: false };
        })();
        cards.set(name, pending);
      }
      return pending;
    };
    const flushIndexes = async () => {
      for (const state of await Promise.all(cards.values())) {
        if (!state.dirty) continue;
        state.dirty = false;
        await this.#writeIndex(state.cache, state.index.files, this.manifest.version);
      }
    };
    const start = await this.status();
    checkAbort(signal);
    const work = this.selectedFiles.filter((f) => wanted.has(f.tier) && this.eligible(f) && !start.present.has(this.keyOf(f.url)));
    let done = start.count;
    let bytes = start.bytes;
    let sized = start.sized;
    let failed = 0;
    let tier1Done = start.tier1Present;
    let tier2Done = start.tier2Present;
    let pendingFlush = 0;
    // Migration and network traffic are reported separately: the panel says "整理已保存的资源" while nothing is fetched.
    let adopted = 0;
    let downloaded = 0;
    /** @type {{ url: string, message: string }[]} */
    const failures = [];
    let lastEmit = 0;
    // Exactly the counters of status(): the UI maps one shape for both, so a field can never be missing mid-run.
    const progress = (current = null) => {
      const tally = this.#tally(start.present);
      return {
        phase: 'download', count: done, total: start.total, wanted: start.wanted, skipped: start.skipped,
        bytes, totalBytes: start.totalBytes, sized, sizedTotal: start.sizedTotal,
        tier1: start.tier1, tier1Present: tier1Done, tier2: start.tier2, tier2Present: tier2Done,
        tier1Wanted: start.tier1Wanted, tier2Wanted: start.tier2Wanted,
        groups: tally.groups, scopes: tally.scopes, skins: tally.skins, skinScope: tally.skinScope,
        complete: false, failed, failures: failures.slice(), current, adopted, downloaded,
      };
    };
    const emit = (current = null, force = false) => {
      if (!onProgress) return;
      const t = this.now();
      if (!force && t - lastEmit < 120) return;
      lastEmit = t;
      onProgress(progress(current));
    };
    emit(null, true);
    // Cards from before the split hold another card's files: move them before anything is fetched (no network traffic).
    // Only when the listing saw an entry out of place: the pass costs one enumeration of every card, which an install
    // that is already laid out correctly would pay for nothing.
    if (start.misplaced) {
      adopted += await this.#tidy({ signal });
      if (adopted) emit(null, true);
    }
    if (work.length) {
      // the manifest is sorted essential-first, so a plain order keeps tier 1 ahead of tier 2
      const small = [];
      const big = [];
      for (const f of work) (Number.isSafeInteger(f.size) && f.size > BIG_FILE_BYTES ? big : small).push(f);
      // Caches of the pre-hash layout: their entries are verified (and moved) before anything is fetched.
      const older = await this.#olderCaches();
      // Old-layout keys (aliases) come from the snapshot `status()` just built: it spans every card, so an alias
      // cannot go missing merely because its entry sits in another one.
      const aliases = new Map();
      for (const [key, hash] of this.#indexSnapshot) aliases.set(resourceIdentity(key), { key, hash });
      const one = async (file) => {
        checkAbort(signal);
        const key = this.keyOf(file.url);
        const state = await card(this.shardName(file));
        const { cache, index } = state;
        try {
          if (await this.#adopt(file, cache, older, aliases, signal)) adopted++;
          else {
            const receipt = await this.ensureCached?.(file, { signal });
            checkAbort(signal);
            if (receipt) { if (receipt.downloaded) downloaded++; else adopted++; }
            else {
              let res = await this.#fetchStorable(key, signal);
              // `cache: 'no-store'` bypasses the HTTP cache, not Cache Storage: a Service Worker of an older build may
              // answer this fetch out of its own cache (and a stale one at that). Verify the bytes against the manifest
              // hash and, when they disagree, ask again on a URL no cache entry can match — the worker matches full URLs.
              // A second mismatch fails this file; never mark mismatching bytes as the requested revision.
              if (file.hash && CONTENT_HASH_RE.test(file.hash)) {
                const seen = await digestOf(res);
                if (seen !== file.hash) {
                  res = await this.#fetchStorable(`${key}${key.includes('?') ? '&' : '?'}sp=${file.hash}`, signal);
                  const retried = await digestOf(res);
                  if (retried !== file.hash) throw new Error('资源内容与清单不一致，请更新 CDN 缓存或资源指纹');
                }
              }
              checkAbort(signal);
              await cache.put(key, this.storable(res, file.hash));
              downloaded++;
            }
          }
          checkAbort(signal);
          // A missing index record is recovered by verifying the saved bytes on the next run.
          if (file.hash) {
            index.files[key] = file.hash;
            state.dirty = true;
            if (++pendingFlush >= INDEX_FLUSH_EVERY) { pendingFlush = 0; await flushIndexes(); }
          }
          done++;
          start.present.add(key);
          if (file.tier === TIER_ESSENTIAL) tier1Done++; else tier2Done++;
          if (Number.isSafeInteger(file.size)) { bytes += file.size; sized++; }
        } catch (err) {
          checkAbort(signal); // an abort wins over a per-file error: the run is being stopped
          if (isQuotaError(err)) {
            const quota = new Error('quota exceeded');
            quota.name = 'QuotaExceededError';
            quota.cause = err;
            throw quota;
          }
          failed++;
          if (failures.length < MAX_FAILURES) failures.push({ url: file.url, message: String(err?.message || err) });
        }
        emit(file.url);
      };
      const drain = async (list, lanes) => {
        let next = 0;
        let revision = -1;
        let failure = null;
        const drained = new AbortController();
        const abortWait = () => drained.abort(signal.reason);
        signal?.addEventListener('abort', abortWait, { once: true });
        const waitSignal = drained.signal;
        if (signal?.aborted) abortWait();
        try { await Promise.all(Array.from({ length: Math.min(lanes, list.length) }, async (_, lane) => {
          try {
            while (next < list.length && !failure) {
              await this.schedule?.wait(waitSignal, lane, list[next].tier, () => next < list.length && !failure);
              checkAbort(signal);
              if (next >= list.length || failure) break;
              if (this.schedule && revision !== this.schedule.revision) {
                revision = this.schedule.revision;
                const buckets = [[], [], []];
                for (let i = next; i < list.length; i++) buckets[this.schedule.priority(list[i].url)].push(list[i]);
                const tail = [...buckets[2], ...buckets[1], ...buckets[0]];
                list.splice(next, tail.length, ...tail);
              }
              const file = list[next++];
              if (next === list.length) this.schedule?.wake();
              await one(file);
            }
          }
          catch (err) { failure ??= err; drained.abort(err); }
        })); } finally { signal?.removeEventListener('abort', abortWait); }
        if (failure) throw failure;
      };
      try {
        await drain(small, this.smallLanes);
        await drain(big, this.bigLanes);
        checkAbort(signal);
      } finally {
        // Flush on every exit — an abort or a quota failure included: the files stored so far must count as current
        // next time. A failing write requires verifying their saved bytes on the next run.
        try { await flushIndexes(); } catch { /* out of storage: the run is already failing */ }
      }
    } else {
      checkAbort(signal);
    }
    const after = await this.status();
    const result = { ...after, phase: 'ready', failed, failures: failures.slice(), adopted, downloaded };
    onProgress?.(result);
    // Only a complete set may drop anything: a partial run never deletes files it did not replace. Cleanup is
    // maintenance, not part of the download - it enumerates every card again, so it runs only when this run changed
    // something or the listing already saw an entry the manifest no longer wants (a dropped asset, an earlier
    // layout's cache). An install that is complete and in order has nothing to clean.
    if (result.complete && (downloaded || adopted || start.stale)) await this.prune();
    return result;
  }
  /** Delete every cache this app owns, of every version — 「清理缓存」 in the settings panel. Never re-creates one. */
  async clear({ optionalOnly = false } = {}) {
    this.statusPromise = null;
    if (optionalOnly) {
      const identity = (url) => new URL(url, this.origin).pathname.match(/\/(?:assets|fonts)\/.*/)?.[0];
      const optional = new Set(this.files.filter((f) => f.tier === TIER_REST).map((f) => identity(f.url)));
      const isOptional = (url) => optional.has(identity(url)) || /\/assets\/audio\//.test(new URL(url, this.origin).pathname);
      for (const name of await this.caches.keys()) {
        if (!name.startsWith(CACHE_PREFIX)) continue;
        const cache = await this.caches.open(name);
        const index = await this.#readIndex(cache);
        // `keys()` may be refused here too — this cleanup is exactly what a cache over the query budget needs — and the
        // index lists the same entries, minus the ones a game request wrote without a record (not ours to call optional).
        for (const url of await this.#keyUrls(cache, name)) if (isOptional(url)) await cache.delete(url);
        for (const key of Object.keys(index.files)) if (isOptional(key)) delete index.files[key];
        await this.#writeIndex(cache, index.files, this.manifest.version);
        // Smaller now: let the next status try one-shot enumeration again.
        this.#keysRefused.delete(name);
      }
      return this.status();
    }
    if (this.caches?.keys) {
      const names = await this.caches.keys();
      await Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX)).map((n) => this.caches.delete(n)));
    }
    this.#keysRefused.clear();
    this.statusPromise = null;
    return { ...this.#tally(new Set()), present: new Set(), scan: 'keys' };
  }

  /** Drop the caches of other versions (a new asset manifest frees the files of the previous one). */
  async pruneOld() {
    const names = (await this.caches.keys()) || [];
    const stale = names.filter((n) => n.startsWith(CACHE_PREFIX) && !SHARD_CACHE_NAMES.includes(n));
    const removed = [];
    for (const name of stale) {
      if (this.voiceScope) {
        const cache = await this.caches.open(name);
        // An older cache has no index to fall back on (`#adopt` moves its entries file by file), so a refused
        // enumeration means "cannot tell": keep it rather than delete the only copy of another language's voices.
        let entries;
        try { entries = await cache.keys(); }
        catch { continue; }
        const keep = entries.some((key) => {
          const language = /\/assets\/audio\/voice\/([^/]+)\//.exec(new URL(key.url).pathname)?.[1];
          return language && language !== this.voiceScope;
        });
        if (keep) continue;
      }
      await this.caches.delete(name);
      removed.push(name);
    }
    return removed;
  }

  /**
   * Delete cached entries that the manifest no longer lists (a file that was renamed or dropped would otherwise sit in
   * the cache forever, and its index record with it). Older caches are only cleaned up once they held no serviceable
   * entry at all — i.e. after the migration of this run moved or dropped what it could.
   */
  async pruneStale() {
    const wanted = new Set(this.files.map((f) => this.keyOf(f.url)));
    const indexKey = indexUrl(this.origin);
    let removed = 0;
    for (const { name, cache } of await this.#shards()) {
      const index = await this.#readIndex(cache);
      const doomed = [...await this.#keyUrls(cache, name)].filter((url) => url !== indexKey && !wanted.has(url));
      if (!doomed.length) continue;
      await Promise.all(doomed.map((url) => cache.delete(url)));
      for (const url of doomed) delete index.files[url];
      await this.#writeIndex(cache, index.files, this.manifest.version);
      removed += doomed.length;
    }
    return removed;
  }

  /**
   * Housekeeping after a complete run: other caches (the version-named layout of earlier builds) and the entries this
   * manifest dropped. `includeStale: false` is used from a download, where the cache was just brought up to date.
   */
  async prune(includeStale = true) {
    const caches = await this.pruneOld();
    const files = includeStale ? await this.pruneStale() : 0;
    return { caches, files };
  }
}
