// One browser dismissal for legacy notices; visit notices only remember this page's close.
// Construct once per mounted banner so regular polling never reopens a closed visit notice.
export function createAnnouncementDisplay({ storage = globalThis.localStorage } = {}) {
  const closed = new Set();
  const key = 'sp.announcement.dismissed';
  const persisted = () => { try { return storage?.getItem(key); } catch { return null; } };
  return {
    isDismissed(notice) {
      return closed.has(notice.id) || (notice.displayMode !== 'visit' && persisted() === notice.id);
    },
    dismiss(notice) {
      closed.add(notice.id);
      if (notice.displayMode !== 'visit') {
        try { storage?.setItem(key, notice.id); } catch { /* In-memory dismissal still works. */ }
      }
    },
  };
}
