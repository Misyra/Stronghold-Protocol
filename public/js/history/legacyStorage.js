// Read-only access to the retired database. Never create/upgrade a database during migration.
export function readLegacyHistory({ indexedDB = globalThis.indexedDB, name = 'stronghold-match-history' } = {}) {
  return new Promise((resolve, reject) => {
    if (!indexedDB) { reject(new Error('浏览器不支持本地对局记录')); return; }
    let settled = false, missing = false;
    const finish = (error, rows) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(rows);
    };
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => {
      missing = true;
      request.transaction.abort(); // rollback initial creation; there are no legacy records to read
      request.result.close();
    };
    request.onerror = () => finish(missing ? null : request.error, missing ? [] : undefined);
    request.onblocked = () => finish(new Error('本地记录数据库被其他页面占用，请关闭旧页面后重试'));
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      db.onversionchange = () => db.close();
      try {
        const tx = db.transaction('matches', 'readonly');
        const query = tx.objectStore('matches').getAll();
        tx.oncomplete = () => {
          db.close();
          const time = (value) => Number.isFinite(value) ? value : 0;
          const rows = query.result.filter((row) => row && !row.deleted).sort((a, b) =>
            time(b.endedAt) - time(a.endedAt) || time(b.recordedAt) - time(a.recordedAt) || String(a.id).localeCompare(String(b.id)));
          finish(null, rows);
        };
        tx.onabort = () => { db.close(); finish(tx.error || new Error('本地记录读取失败')); };
      } catch (error) { db.close(); finish(error); }
    };
  });
}
