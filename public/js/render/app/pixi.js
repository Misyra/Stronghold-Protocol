// public/js/render/app/pixi.js — load PIXI and pixi-spine once (one module-level promise).

import { resourceUrl } from '../../resourceUrl.js';

const VENDOR = { pixi: '/vendor/pixi.min.js', spine: '/vendor/pixi-spine.js' };

let pixiPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = resourceUrl(src);
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

/** Make sure PIXI and PIXI.spine exist (classic scripts; loaded once). */
export function ensurePixi() {
  if (globalThis.PIXI && globalThis.PIXI.spine) return Promise.resolve(globalThis.PIXI);
  if (!pixiPromise) {
    pixiPromise = (async () => {
      if (!globalThis.PIXI) await loadScript(VENDOR.pixi);
      if (!globalThis.PIXI?.spine) await loadScript(VENDOR.spine);
      if (!globalThis.PIXI || !globalThis.PIXI.spine) throw new Error('PIXI / pixi-spine unavailable');
      return globalThis.PIXI;
    })();
    pixiPromise.catch(() => { pixiPromise = null; });
  }
  return pixiPromise;
}

/** Pixi 7 retains extension objects across loss, but WebGL disables the extensions. */
export function restorePixiExtensions(renderer) {
  const canvas = renderer.view;
  const restore = () => renderer.context.getExtensions();
  // Run before Pixi's bubble listener rebuilds GPU resources using extension enums.
  canvas.addEventListener('webglcontextrestored', restore, true);
  return () => canvas.removeEventListener('webglcontextrestored', restore, true);
}
