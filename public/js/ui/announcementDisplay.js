// One browser dismissal per notice id; regular polling never reopens a dismissed notice.
// (The fork's per-visit displayMode never reaches this port: the schedule carries no displayMode field.)
export function createAnnouncementDisplay({ storage = globalThis.localStorage } = {}) {
  const closed = new Set();
  const key = 'sp.announcement.dismissed';
  const persisted = () => { try { return storage?.getItem(key); } catch { return null; } };
  return {
    isDismissed(notice) {
      return closed.has(notice.id) || persisted() === notice.id;
    },
    dismiss(notice) {
      closed.add(notice.id);
      try { storage?.setItem(key, notice.id); } catch { /* In-memory dismissal still works. */ }
    },
  };
}
