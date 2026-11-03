// Compat module (stronghold-ui package) — install ONLY when the target has no public/js/ui/cloudStats.js.
// The original deployment keeps a logged-in player's match records in its accounts service (the same list on every
// device). Here the account is local (ui/accounts.js of this package), so "the account's records" ARE this browser's:
// the game's own list in localStorage (ui/stats.js, `sp.pref.stats`). Nothing is uploaded. 点赞 / 好友 need a shared
// service: accountApi refuses, and the settlement greys those buttons out. Replace this file together with
// accounts.js when a real account system is connected (AGENTS.md §3.2).
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { loadStats, statsRevision, subscribeStats } from './stats.js';
import { N_ } from '../../../shared/i18n.js';

const NO_SERVICE = N_('本服未接入账号服务（成就与战绩只保存在这台设备的浏览器里）');
/** Every open record panel reads the same snapshot; one slow poll per page is enough (a save notifies at once). */
const POLL_MS = 60_000;
const subscribers = new Set();
let cachedValue = null;
let cachedRevision;
let published = null;
let poll = null;
let storageBound = false;

/** No accounts service here. */
export async function accountApi() { throw new Error(NO_SERVICE); }

/** { records (newest first), source, ready, failed, likes } — the local account's list = this browser's records. */
export function currentRecords() {
  const records = [...loadStats().records].sort((a, b) => (b?.t || 0) - (a?.t || 0));
  return { records, source: 'account', local: true, ready: true, failed: false, likes: null };
}

/**
 * The records, re-read only when the stored value actually changed. `statsRevision()` is the raw stored string, so an
 * unchanged poll compares text instead of parsing and sorting the whole history (UI panels call this from a timer).
 */
export function recordsSnapshot() {
  const revision = statsRevision();
  if (cachedValue && revision === cachedRevision) return cachedValue;
  cachedValue = currentRecords();
  // Reading may self-heal the stored shape (ui/stats.js), so the revision is taken again after the read.
  cachedRevision = statsRevision();
  return cachedValue;
}

function refresh() {
  const value = recordsSnapshot();
  if (value === published) return;
  published = value;
  for (const fn of subscribers) fn(value);
}

function onStorage(e) { if (!e.key || e.key.startsWith('sp.pref.stats')) refresh(); }

function subscribe(fn) {
  subscribers.add(fn);
  if (!storageBound) {
    storageBound = true;
    globalThis.addEventListener?.('storage', onStorage);
    subscribeStats(() => refresh()); // a match recorded in this tab notifies at once
  }
  if (poll == null) poll = setInterval(() => { if (!globalThis.document?.hidden) refresh(); }, POLL_MS);
  return () => {
    subscribers.delete(fn);
    if (!subscribers.size && poll != null) { clearInterval(poll); poll = null; }
  };
}

export function syncRecords() { refresh(); return Promise.resolve(); }
/** Nothing is uploaded: a record is never "on the account service". */
export async function ensureUploaded() { return false; }
export async function uploadRecords() { return 0; }
export const importDeviceRecords = () => uploadRecords();
export async function clearAccountRecords() {}
export async function loadFriendRecords() { throw new Error(NO_SERVICE); }

/** Preact: the records, re-read when another tab writes them and when a match is recorded here. */
export function useRecords() {
  const [cur, setCur] = useState(recordsSnapshot);
  useEffect(() => {
    const fn = (value) => setCur(value);
    const off = subscribe(fn);
    refresh();
    return () => off();
  }, []);
  return cur;
}
export function startCloudStats() {}
