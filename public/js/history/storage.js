// IndexedDB transactions serialize tabs as well as this page: duplicate resends never add a second record.
import { HISTORY_LIMIT, newestFirst } from './record.js';

export function createHistoryStorage(options = {}) {
  const { limit = HISTORY_LIMIT, name = 'stronghold-match-history' } = options;
  let opening = null;
  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      // Access can itself throw under restrictive browser storage policies; keep that out of app boot.
      const indexedDB = Object.hasOwn(options, 'indexedDB') ? options.indexedDB : globalThis.indexedDB;
      if (!indexedDB) { reject(new Error('浏览器不支持本地对局记录')); return; }
      const request = indexedDB.open(name, 1);
      let cancelled = false;
      request.onupgradeneeded = () => request.result.createObjectStore('matches', { keyPath: 'id' });
      request.onerror = () => reject(request.error);
      request.onblocked = () => { cancelled = true; reject(new Error('本地记录数据库被其他页面占用，请关闭旧页面后重试')); };
      request.onsuccess = () => {
        const db = request.result;
        if (cancelled) { db.close(); return; }
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
    }).catch((err) => { opening = null; throw err; });
    return opening;
  }
  async function transact(mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('matches', mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error('本地记录保存失败'));
      // Request errors bubble to the transaction and abort it. Only completion means a durable write.
      try { work(tx.objectStore('matches'), (value) => { result = value; }); }
      catch (err) { tx.abort(); reject(err); }
    });
  }
  return {
    list: () => transact('readonly', (s, done) => { s.getAll().onsuccess = (e) => done(newestFirst(e.target.result.filter((r) => !r.deleted))); }),
    add: (record) => transact('readwrite', (s, done) => {
      s.get(record.id).onsuccess = (e) => {
        if (e.target.result) { done(e.target.result.deleted ? 'discarded' : 'existing'); return; }
        s.add(record);
        s.getAll().onsuccess = (all) => {
          const records = newestFirst(all.target.result);
          const pruned = records.filter((r) => !r.deleted).slice(limit);
          for (const old of [...pruned, ...records.filter((r) => r.deleted).slice(1000)]) s.delete(old.id);
          done(pruned.some((r) => r.id === record.id) ? 'discarded' : 'saved');
        };
      };
    }),
    // Explicit imports may restore deleted rows. One transaction keeps a failed import from partially writing.
    import: (incoming) => transact('readwrite', (s, done) => {
      s.getAll().onsuccess = (e) => {
        const rows = new Map(e.target.result.map((r) => [r.id, r]));
        const added = new Set();
        let skipped = 0;
        for (const r of incoming) {
          const existing = rows.get(r.id);
          if (existing && !existing.deleted) { skipped++; continue; }
          rows.set(r.id, r); added.add(r.id); s.put(r);
        }
        const records = newestFirst([...rows.values()]);
        const pruned = records.filter((r) => !r.deleted).slice(limit);
        for (const old of [...pruned, ...records.filter((r) => r.deleted).slice(1000)]) s.delete(old.id);
        const discarded = pruned.filter((r) => added.has(r.id)).length;
        done({ added: added.size - discarded, skipped, discarded });
      };
    }),
    // Small tombstones suppress a reconnect's replay of the latest result after the user deleted it.
    remove: (id) => transact('readwrite', (s) => {
      s.get(id).onsuccess = (e) => {
        const r = e.target.result;
        if (r) s.put({ id: r.id, endedAt: r.endedAt, recordedAt: r.recordedAt, deleted: true });
      };
    }),
    clear: () => transact('readwrite', (s) => {
      s.getAll().onsuccess = (e) => {
        for (const r of e.target.result) s.put({ id: r.id, endedAt: r.endedAt, recordedAt: r.recordedAt, deleted: true });
      };
    }),
  };
}
