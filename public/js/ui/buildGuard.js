// public/js/ui/buildGuard.js — the "this page is running an outdated build" guard, plus the recovery path for a page
// the browser gate has stopped admitting.
//
// WHY (build): every module a page imports lives in its module map for the whole page lifetime, so a deploy can never
// reach an already-open tab — not even a client-only one, which is served `Cache-Control: no-cache` and would be picked
// up by a reload. A client-only battle fix shipped exactly that way and stayed invisible on the reporting player's page:
// the nginx log shows the page loaded the PRE-fix module blob and made no module request at all for the rest of the
// session.
//
// HOW (build): the server stamps this release's tag into the HTML (assetVersion.js, `globalThis.__spAssetVersion`) and
// reports it at `/healthz` as `build` (server/http/static.js). A plain static host without that stamp uses the first
// successful check as its baseline. The tag lives in page memory: nothing survives a reload, and a duplicated tab must
// not inherit the first tab's tag.
// A later check reporting a DIFFERENT tag means the server changed under this page:
//   * outside a match the page reloads itself, once;
//   * during a match the guard never throws the player's game away — `onStale` fires (the connection banner offers
//     刷新页面) and the reload happens by itself as soon as the match, settlement screen included, is over.
// A check that cannot read a build (`/healthz` down or restarting, no `build` field, no answer in time) is 'unknown' and
// NEVER reloads: a restarting server must not turn a playing page into the browser's error page. A new tag is acted on
// only after two checks in a row report the SAME one, so a deploy that is still copying files cannot ping-pong a page.
//
// WHY (gate): every fleet location sits behind `auth_request /_sp/gate-check`. The gate admits a browser only with a
// signed cookie bound to (IP, host, scheme, user-agent) that lives 6 hours and renews on admitted HTTP requests.
// An invalid cookie needs a NAVIGATION — `error_page 401 = @sp_gate_needed` serves the proof-of-work page when `$sp_gate_navigation` is set and
// answers `return 444` (connection closed, no headers) to anything else. A page whose cookie lapsed — 6 hours on an
// idle tab, a phone that changed cell, a shell restored from the service worker — therefore keeps failing `/healthz`
// and its WebSocket with a bare connection error, forever: nothing in that page is a navigation, so nothing ever
// re-challenges it. The nginx logs show exactly that shape (one IP, 900 identical `/ws` 444s at 10s intervals, a day
// after it had 1114 successful upgrades).
// HOW (gate): /_gate/status explicitly marks a missing or invalid cookie with X-Gate-Required: 1.
// Ordinary 429/503 responses and reachable public assets do not prove a gate failure.
// Two refusals in a row are required, a live match is never thrown away (`onGateLost` fires and the banner offers the
// reload), and a reload loop is impossible: one automatic gate reload per GATE_RELOAD_BACKOFF_MS, after which the page
// stops trying and leaves the button to the player.
//
// The same `/healthz` body carries what else a page reads of the server before it says hello: `onHealth(body)` is told
// every body a check reads (main.js: how many plugins the server has, for the title screen — DESIGN §32 P1a).
//
// Kept dependency-free and injectable (fetch / reload / inMatch / timers / storage) so test/ui/buildGuard.test.js can
// drive it.

/** How often a page re-asks the server for its build tag. */
export const BUILD_CHECK_MS = 60_000;
/** Give up on a `/healthz` that does not answer: a request left hanging must not stop the guard from ever checking again. */
export const BUILD_FETCH_TIMEOUT_MS = 5_000;
/** How many checks in a row must report the same NEW build before the page acts on it. */
export const BUILD_CONFIRMATIONS = 2;
/** Read-only gate status; failure never grants admission. */
export const GATE_PROBE_URL = '/_gate/status';
/** How many checks in a row must be refused-with-the-server-up before the page treats its gate cookie as lapsed. */
export const GATE_LOST_CONFIRMATIONS = 2;
/** At most one automatic gate reload in this window; after that the page leaves the button to the player. */
export const GATE_RELOAD_BACKOFF_MS = 5 * 60_000;
/** sessionStorage key holding the timestamp of the last automatic gate reload. */
export const GATE_RELOAD_KEY = 'sp.gateReloadAt';

/** sessionStorage, or null where the browser refuses it (private mode, disabled storage, a worker). */
function defaultStorage() {
  try { return globalThis.sessionStorage || null; } catch { return null; }
}

/** An abortable fetch race: `{ signal, timeout, clear }`. The timeout promise never resolves, only rejects. */
function abortable(o, timeoutMs) {
  const setT = o.setTimeout || ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearT = o.clearTimeout || ((h) => globalThis.clearTimeout(h));
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setT(() => { try { ctrl?.abort(); } catch { /* ignore */ } reject(new Error('timeout')); }, timeoutMs);
  });
  // A rejected race loser must not surface as an unhandled rejection.
  timeout.catch(() => {});
  return { signal: ctrl ? ctrl.signal : undefined, timeout, clear: () => { if (timer != null) clearT(timer); } };
}

/**
 * Fetch `/healthz` and return its `build` tag (null when unavailable, not reported, or too slow). Never throws.
 * @param {Function} fetchFn
 * @param {{ timeoutMs?: number, setTimeout?: Function, clearTimeout?: Function, onHealth?: (body: any) => void }} [o]
 *   onHealth: told the body it read (see the header)
 * @returns {Promise<string|null>}
 */
export async function fetchBuild(fetchFn, o = {}) {
  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : BUILD_FETCH_TIMEOUT_MS;
  const race = abortable(o, timeoutMs);
  try {
    // Older servers ignore the query and return full health, whose build field still works.
    const res = await Promise.race([fetchFn('/healthz?build=1', { cache: 'no-store', signal: race.signal }), race.timeout]);
    if (!res || !res.ok) return null;
    const body = await res.json();
    try { if (body && typeof body === 'object') o.onHealth?.(body); } catch { /* the listener's own trouble */ }
    return body && typeof body.build === 'string' && body.build ? body.build : null;
  } catch {
    return null;
  } finally {
    race.clear();
  }
}

/**
 * Ask the gate whether this cookie requires a fresh challenge. Never infer this from server reachability.
 * @param {Function} fetchFn
 * @param {{ timeoutMs?: number, setTimeout?: Function, clearTimeout?: Function }} [o]
 * @returns {Promise<boolean>}
 */
export async function probeGateRequired(fetchFn, o = {}) {
  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : BUILD_FETCH_TIMEOUT_MS;
  const race = abortable(o, timeoutMs);
  try {
    const res = await Promise.race([fetchFn(GATE_PROBE_URL, { cache: 'no-store', credentials: 'same-origin', signal: race.signal }), race.timeout]);
    return res?.status === 200 && res.headers?.get('X-Gate-Required') === '1';
  } catch {
    return false;
  } finally {
    race.clear();
  }
}

/**
 * One check, against the build this page already knows.
 * @param {{ fetchFn?: Function, known?: string|null, timeoutMs?: number, setTimeout?: Function, clearTimeout?: Function,
 *   onHealth?: (body: any) => void }} [o]
 * @returns {Promise<{ status: 'first'|'current'|'new'|'unknown', build: string|null }>}
 */
export async function checkBuildOnce(o = {}) {
  const fetchFn = o.fetchFn || ((url, init) => globalThis.fetch(url, init));
  const build = await fetchBuild(fetchFn, o);
  if (!build) return { status: 'unknown', build: null };            // unreachable / not reported: never a reload
  if (!o.known) return { status: 'first', build };
  return { status: o.known === build ? 'current' : 'new', build };
}

/**
 * Watch for a new build, and for a browser-gate credential that has lapsed under this page.
 * @param {{ fetchFn?: Function, reload?: Function, inMatch?: () => boolean, intervalMs?: number, timeoutMs?: number,
 *           document?: Document, setInterval?: Function, clearInterval?: Function, setTimeout?: Function,
 *           clearTimeout?: Function, storage?: Storage|null,
 *           onStale?: (info: { build: string, known: string|null, waiting: boolean }) => void,
 *           onGateLost?: (info: { waiting: boolean, exhausted: boolean }) => void,
 *           onGateRecovered?: () => void,
 *           onHealth?: (body: any) => void }} [o]  onHealth: every /healthz body a check reads (see the header)
 * @returns {{ stop: () => void, check: () => Promise<object>, stale: () => boolean, gateLost: () => boolean,
 *   known: () => string|null }}
 */
export function startBuildGuard(o = {}) {
  const fetchFn = o.fetchFn || ((url, init) => globalThis.fetch(url, init));
  const reload = o.reload || (() => globalThis.location.reload());
  const inMatch = typeof o.inMatch === 'function' ? o.inMatch : () => false;
  const setIv = o.setInterval || ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearIv = o.clearInterval || ((h) => globalThis.clearInterval(h));
  const intervalMs = Number.isFinite(o.intervalMs) && o.intervalMs > 0 ? o.intervalMs : BUILD_CHECK_MS;
  const doc = o.document === undefined ? globalThis.document : o.document;
  const storage = o.storage === undefined ? defaultStorage() : o.storage;
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  let known = globalThis.__spAssetVersion || null; // stamped into this page before its modules load
  let candidate = null;  // the last new build seen; needs BUILD_CONFIRMATIONS checks in a row to be acted on
  let seen = 0;          // consecutive checks that reported `candidate`
  let stale = false;     // a new build is confirmed → reload as soon as no match is on screen
  let refused = 0;       // consecutive checks the server answered but the gate refused this page for
  let lost = false;      // the gate credential is confirmed lapsed → reload as soon as no match is on screen
  let pending = false;
  let timer = null;
  let stopped = false;

  const stopTimer = () => { if (timer != null) { clearIv(timer); timer = null; } };
  const reloadNow = () => { stopped = true; stopTimer(); doc?.removeEventListener('visibilitychange', visibility); reload(); };

  /** One automatic gate reload per window. false = the page already tried and must leave it to the player. */
  const claimGateReload = () => {
    let last = 0;
    try { last = Number(storage?.getItem?.(GATE_RELOAD_KEY) || 0) || 0; } catch { last = 0; }
    if (last > 0 && now() - last < GATE_RELOAD_BACKOFF_MS) return false;
    try { storage?.setItem?.(GATE_RELOAD_KEY, String(now())); } catch { /* storage may refuse; the timer still applies */ }
    return true;
  };

  const check = async () => {
    if (stopped) return { status: 'stopped', build: null };
    if (doc?.hidden) return { status: 'paused', build: null };
    if (pending) return { status: 'pending', build: null };
    pending = true;
    let r;
    try { r = await checkBuildOnce({ fetchFn, known, timeoutMs: o.timeoutMs, setTimeout: o.setTimeout, clearTimeout: o.clearTimeout, onHealth: o.onHealth }); }
    finally { pending = false; }
    if (stopped) return { status: 'stopped', build: null };
    if (doc?.hidden) { candidate = null; seen = 0; return { status: 'paused', build: null }; }
    if (r.status === 'unknown') {
      candidate = null; seen = 0;                                   // review: a failed check never reloads a stale page
      // Require the explicit gate verdict before treating an unknown health check as lost admission.
      const required = await probeGateRequired(fetchFn, { timeoutMs: o.timeoutMs, setTimeout: o.setTimeout, clearTimeout: o.clearTimeout });
      if (stopped) return { status: 'stopped', build: null };
      if (doc?.hidden) { refused = 0; return { status: 'paused', build: null }; }
      if (!required) { refused = 0; return r; }                           // the server is really down: stay quiet
      refused++;
      if (refused < GATE_LOST_CONFIRMATIONS) return { status: 'refused', build: null };
      const first = !lost;
      lost = true;
      const waiting = inMatch();
      const canReload = waiting ? false : claimGateReload();
      if (first || (!waiting && canReload)) { try { o.onGateLost?.({ waiting, exhausted: !waiting && !canReload }); } catch { /* ignore */ } }
      if (!waiting && canReload) { reloadNow(); return { status: 'refused', build: null, reloading: true }; }
      return { status: 'refused', build: null, waiting };
    }
    refused = 0;
    if (lost) { lost = false; try { o.onGateRecovered?.(); } catch { /* ignore */ } }
    if (r.status === 'first') { known = r.build; return r; }
    if (r.status === 'current') { candidate = null; seen = 0; return r; }
    // a different build: only BUILD_CONFIRMATIONS checks in a row with the SAME tag count (a deploy that is still
    // copying files exposes a tag that keeps moving, and must not ping-pong the page)
    if (candidate !== r.build) { candidate = r.build; seen = 1; } else { seen++; }
    if (seen < BUILD_CONFIRMATIONS) return { status: 'new', build: r.build };
    const first = !stale;
    stale = true;
    const waiting = inMatch();
    if (first) { try { o.onStale?.({ build: r.build, known, waiting }); } catch { /* ignore */ } }
    if (!waiting) reloadNow();
    return { status: 'stale', build: r.build, known };
  };

  const tick = () => { check().catch(() => {}); };
  const visibility = () => {
    if (doc?.hidden) { candidate = null; seen = 0; }
    else tick();
  };
  doc?.addEventListener('visibilitychange', visibility);
  check().catch(() => {});
  timer = setIv(tick, intervalMs);
  return {
    stop: () => { stopped = true; stopTimer(); doc?.removeEventListener('visibilitychange', visibility); },
    check,
    stale: () => stale,
    gateLost: () => lost,
    known: () => known,
  };
}
