import { resourceUrl, resourceCache } from './resourceUrl.js';

/** Only the fork's per-file CDN atlas adapter; the ordinary PIXI loader stays upstream-owned. */
export async function cdnSpineSource(entry, PIXI) {
  const atlasPath = entry.atlas || String(entry.skel).replace(/\?v=[0-9a-f]{16}$/, '').replace(/\.skel$/, '.atlas');
  const atlas = resourceUrl(atlasPath);
  const response = await fetch(atlas, { cache: resourceCache(atlas), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`atlas failed (${response.status}): ${atlas}`);
  const text = await response.text();
  // PIXI's default path drops page queries. Resolve every actual atlas page's content hash explicitly.
  const spineAtlas = await new Promise((resolve, reject) => {
    new PIXI.spine.TextureAtlas(text, (name, done) => {
      const page = resourceUrl(new URL(name, new URL(atlas, 'http://localhost')).href);
      PIXI.Assets.loader.load(page).then((texture) => {
        const base = texture?.baseTexture;
        if (!base || base.destroyed || base.valid === false) { reject(new Error(`invalid atlas texture: ${page}`)); return; }
        try { done(base); } catch (error) { reject(error); }
      }, reject);
    }, (parsed) => parsed ? resolve(parsed) : reject(new Error(`atlas texture failed: ${atlas}`)));
  });
  const source = { src: resourceUrl(entry.skel), data: { spineAtlas } };
  // Resolver metadata outlives unloaded textures; a reload must replace the retired atlas.
  if (PIXI.Assets.resolver?.hasKey(source.src)) {
    const resolved = PIXI.Assets.resolver.resolve(source.src);
    resolved.data = { ...resolved.data, spineAtlas };
  }
  return source;
}
