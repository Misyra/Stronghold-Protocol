// public/js/spineManifest.js — the pure Spine-manifest layer of public/js/assets.js, which re-exports it.
//
// Resolving a unit asset id to its Spine entry (operators with their 干员皮肤, tokens, enemies), the Back-model
// questions and the local-client (`data/local-assets.json`) variant: manifest in, entry out. Nothing here fetches,
// keeps a store or touches assets.js, so a module that only needs these can import this file without pulling the
// asset store into the page’s startup graph — test/ui/plugins-client.test.js pins that graph (a vanilla page must
// not load public/js/assets.js), and render/spinePreview.js is the fork’s consumer of it.

// ---- helpers ------------------------------------------------------------------------------------------------

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const str = (v) => (typeof v === 'string' && v ? v : null);
export const get = (o, k) => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined);
/** The URL without its per-file cache-bust query (CDN manifest mode appends `?v=<16 hex>`; the query is part of the
 *  URL, never of the file it names — extension-based derivations must run on the bare path). */
export const bareAssetUrl = (u) => String(u).replace(/\?v=[0-9a-f]{16}$/, '');

/** Strip a trailing `_1` / `_2` art-phase suffix (data/chess.json asset ids). */
export function baseCharId(id) {
  const s = str(id);
  if (!s) return null;
  return s.replace(/_(1|2)$/, '');
}

/**
 * Spine manifest entry for a unit asset id (operator charId, token id, enemy id). `opts.back` asks for the Back
 * model (operators only; falls back to Front). Enemy aliases are resolved transparently. Returns the Spine
 * object of docs/ASSETS.md or null.
 * `opts.local` (the data/local-assets.json manifest): an enemy or token whose official model only the local client has
 * (`spineLocal`, e.g. 灼热源石虫 — user feedback after 0.1.0, D3 — and most 自选 summons) gets that model when the
 * manifest lists every one of its files; the returned entry's `fallback` is the web model (an enemy's alias; a token's
 * web model, mostly none — its view then keeps the avatar diamond), for a load failure (DESIGN §13: local art is
 * optional, everything works without it).
 */
export function spineEntry(m, id, opts) {
  const s = str(id);
  if (!s) return null;
  const ch = get(get(m, 'chars'), s) || get(get(m, 'chars'), baseCharId(s));
  if (ch) {
    // 干员皮肤 (custom_docs/SKINS.md): an installed skin replaces the operator's own model. `opts.skin` is a skinId; when it
    // is absent — or names a skin this install does not have — the operator's default model is used, so a client
    // meeting a manifest without that skin still works.
    const skin = opts && str(opts.skin) ? get(get(ch, 'skins'), opts.skin) : null;
    const src = (skin && isObj(skin.spine)) ? skin.spine : ch.spine;
    if (isObj(src)) {
      const sp = (opts && opts.back && isObj(src.back)) ? src.back : src.front;
      return validSpine(sp) ? sp : null;
    }
  }
  const tk = get(get(m, 'tokens'), s);
  if (tk) {
    const web = validSpine(tk.spine) ? tk.spine : null;
    return (opts && opts.local && localSpineEntry(tk.spineLocal, opts.local, web)) || web;
  }
  const en = get(get(m, 'enemies'), s);
  if (en) {
    let web = null;
    if (validSpine(en.spine)) web = en.spine;
    else {
      const alias = str(en.spineAliasOf);
      const al = alias ? get(get(m, 'enemies'), alias) : null;
      web = al && validSpine(al.spine) ? al.spine : null;
    }
    return (opts && opts.local && localSpineEntry(en.spineLocal, opts.local, web)) || web;
  }
  return null;
}

const localSpines = new WeakMap(); // spineLocal record → { local, web, entry } (one entry object per manifest pair)

/**
 * A manifest `spineLocal` (`{ group, skel, atlas, textures[], pma, anims, … }`, file names in the data/local-assets.json
 * group) as a Spine entry with URLs, when `local` lists every file — skeleton and atlas side by side (pixi-spine finds
 * the atlas by the skeleton's name); else null. `fallback` = `web`.
 */
export function localSpineEntry(sl, local, web) {
  if (!isObj(sl) || !isObj(local)) return null;
  const c = localSpines.get(sl);
  if (c && c.local === local && c.web === web) return c.entry;
  const g = str(sl.group);
  const url = (name) => (g ? localAssetUrl(local, g, name) : null);
  const skel = url(sl.skel), atlas = url(sl.atlas);
  const textures = Array.isArray(sl.textures) ? sl.textures.map(url) : [];
  let entry = null;
  if (skel && atlas && bareAssetUrl(skel).replace(/\.skel$/, '.atlas') === bareAssetUrl(atlas) && textures.length && textures.every(Boolean)) {
    entry = { skel, atlas, textures, pma: !!sl.pma, anims: sl.anims, animations: sl.animations, events: sl.events, hits: sl.hits, bounds: sl.bounds, local: true, fallback: web || null };
    if (!validSpine(entry)) entry = null;
  }
  localSpines.set(sl, { local, web, entry });
  return entry;
}

/** Whether an operator/token/enemy has a Back model. `skinId` asks about an installed skin (custom_docs/SKINS.md). */
export function hasBackSpine(m, id, skinId) {
  const ch = get(get(m, 'chars'), str(id) || '') || get(get(m, 'chars'), baseCharId(id) || '');
  if (!ch) return false;
  // 干员皮肤 (custom_docs/SKINS.md): a skin may ship its own Front/Back pair, so both questions are asked of the skin
  const skin = str(skinId) ? get(get(ch, 'skins'), skinId) : null;
  const src = (skin && isObj(skin.spine)) ? skin.spine : ch.spine;
  return !!(isObj(src) && validSpine(src.back));
}

export function validSpine(sp) {
  if (!isObj(sp) || typeof sp.skel !== 'string' || /\s/.test(sp.skel) || typeof sp.atlas !== 'string' || !isObj(sp.anims)) return false;
  // A CDN URL may carry exactly the per-file cache-bust query (shared/assetCdn.js query mode); any other
  // query still disqualifies the entry.
  const skel = bareAssetUrl(sp.skel);
  if (/^\/[^\s]*\.skel$/.test(skel)) return true;
  try {
    const url = new URL(skel);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith('.skel');
  } catch { return false; }
}

/** URL of a local-client art entry from a data/local-assets.json manifest (`{ groups: { g: { name: { path } } } }`). */
export function localAssetUrl(m, group, name) {
  const e = get(get(get(m, 'groups'), str(group) || ''), str(name) || '');
  return isObj(e) ? str(e.path) : null;
}
