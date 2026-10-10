import { checkAbort, abortError, TIER_REST } from './common.js';

// Match state only changes queued work; an already-running download is allowed to finish.
const identity = (url) => {
  try { return decodeURI(new URL(url, 'https://resources.invalid').pathname).replace(/^\/_v\/[a-f0-9]{16}/, ''); }
  catch { return ''; }
};

export class ResourceSchedule {
  revision = 0;
  active = false;
  combat = false;
  urls = new Set();
  listeners = new Set();
  paths = new Map();

  wake() { for (const wake of [...this.listeners]) wake(); }

  update({ active = false, combat = false, urls = [] } = {}) {
    const selected = new Set(urls.map(identity).filter(Boolean));
    const changed = this.active !== active || this.combat !== combat || selected.size !== this.urls.size
      || [...selected].some((url) => !this.urls.has(url));
    if (!changed) return;
    this.active = active; this.combat = combat; this.urls = selected; this.revision++;
    this.wake();
  }

  priority(url) {
    if (!this.paths.has(url)) this.paths.set(url, identity(url));
    const path = this.paths.get(url);
    return this.urls.has(path) ? 2 : this.active && /\/map\//.test(path) ? 1 : 0;
  }

  async wait(signal, lane, tier, needed = () => true) {
    checkAbort(signal);
    while (needed() && this.combat && (tier === TIER_REST || lane > 0)) {
      await new Promise((resolve, reject) => {
        const cleanup = () => { this.listeners.delete(wake); signal?.removeEventListener('abort', abort); };
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal.reason || abortError()); };
        this.listeners.add(wake);
        signal?.addEventListener('abort', abort, { once: true });
      });
      checkAbort(signal);
    }
  }
}

/** Collect only units referenced by the current match, never all records in the game database. */
export function matchResourceUrls(match, assets, chessLookup = () => null, local = null) {
  const ids = new Set();
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 8) return;
    for (const [key, item] of Object.entries(value)) {
      if (['charId', 'enemyId', 'tokenId', 'assetId', 'spine', 'avatar', 'defId'].includes(key) && typeof item === 'string') ids.add(item);
      if ((['chessId', 'defId'].includes(key) || (key === 'id' && ['chess', 'op', 'token'].includes(value.kind))) && typeof item === 'string') {
        const chess = chessLookup(item);
        if (chess?.charId) ids.add(chess.charId);
        else ids.add(item);
      }
      if (typeof item === 'object') visit(item, depth + 1);
    }
  };
  visit(match?.public); visit(match?.private); visit(match?.field);
  const urls = new Set();
  const add = (value, depth = 0) => {
    if (depth > 8) return;
    if (typeof value === 'string' && /\/(?:assets|fonts)\//.test(value)) urls.add(value);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) add(item, depth + 1);
  };
  for (const id of ids) {
    const record = assets?.chars?.[id] || assets?.chars?.[id.replace(/_[12]$/, '')] || assets?.enemies?.[id] || assets?.tokens?.[id];
    add(record);
    add(local?.groups?.[record?.spineLocal?.group]);
    if (record?.spineAliasOf) add(assets?.enemies?.[record.spineAliasOf]);
  }
  // All boards currently share this atlas. Its manifest supplies the real PNG/WebP URLs.
  add(local?.groups?.['map/autochess']);
  return [...urls];
}
