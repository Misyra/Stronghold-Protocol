import { createStore } from '../store.js';
import { makeRecord } from './record.js';
import { createHistoryStorage } from './storage.js';
import { t } from '../../../shared/i18n.js';

export const historyStore = createStore({ open: false, records: [], loading: false, error: '',
  saveState: 'idle', latestId: null, saveError: '' });
export const historyStorage = createHistoryStorage();
let channel;
let revision = 0;
let saveSeq = 0;

function connectChannel() {
  if (channel || typeof BroadcastChannel === 'undefined') return;
  try {
    channel = new BroadcastChannel('stronghold-match-history');
    channel.onmessage = () => { if (historyStore.get().open) void refreshHistory(); };
  } catch { /* Cross-tab updates are optional; storage itself still serializes writes. */ }
}
function changed() {
  connectChannel();
  try { channel?.postMessage('changed'); } catch { /* A closed notification channel does not undo a saved record. */ }
  if (historyStore.get().open) void refreshHistory();
}
export async function refreshHistory() {
  const version = ++revision;
  historyStore.set({ loading: true, error: '' });
  try {
    const records = await historyStorage.list();
    if (version === revision) {
      const current = historyStore.get();
      historyStore.set({ records, loading: false,
        ...(current.saveState === 'saved' && !records.some((r) => r.id === current.latestId) ? { saveState: 'idle' } : {}) });
    }
  } catch (err) {
    if (version === revision) historyStore.set({ error: err.message || t('本地记录读取失败'), loading: false });
  }
}
export function openHistory() {
  connectChannel();
  historyStore.set({ open: true });
  void refreshHistory();
}
export const closeHistory = () => historyStore.set({ open: false });

/** Fire-and-forget from m.result. IndexedDB work never delays rendering or the WebSocket handler. */
export async function recordMatchResult(result, playerId, metadata) {
  const seq = ++saveSeq;
  try {
    const record = makeRecord(result, playerId, metadata);
    if (!record) { historyStore.set({ saveState: 'idle', latestId: null }); return; }
    historyStore.set({ saveState: 'saving', latestId: record.id, saveError: '' });
    const status = await historyStorage.add(record);
    if (seq === saveSeq) historyStore.set({ saveState: status === 'discarded' ? 'idle' : 'saved' });
    changed();
  } catch (err) {
    if (seq === saveSeq) historyStore.set({ saveState: 'error', saveError: err.message || t('本地记录保存失败') });
  }
}
export async function removeHistory(id) {
  await historyStorage.remove(id);
  if (id === historyStore.get().latestId) historyStore.set({ saveState: 'idle', latestId: null });
  changed();
  await refreshHistory();
}
export async function clearHistory() {
  await historyStorage.clear();
  historyStore.set({ saveState: 'idle', latestId: null, saveError: '' });
  changed();
  await refreshHistory();
}
