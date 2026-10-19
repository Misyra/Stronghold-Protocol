// Site policy (DESIGN §32.11). Hash only import maps, never arbitrary inline script. Worker/UI policies are independent.
// worker-src 'self' is the asset service worker at /sw.js. blob: stays for workers the page already creates
// (the simulation worker). Do not add a remote worker origin. SIM_WORKER_CSP is that worker's own policy and
// must not gain the asset worker.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// SES evaluates confined code. This relaxation belongs only to the simulation Worker, never its parent document.
export const SIM_WORKER_CSP = "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'";


// This fork rewrites each page at serve time (assetVersion.js: versioned URLs and an injected release-tag
// script in <head>), so the served import map is not the one on disk. Hashing the file alone rejected both
// inline scripts and left the client without a module graph (2026-10-16: boot died on 游戏脚本加载失败 while
// /healthz tags were correct). Both variants are hashed; nothing else may become an inline script.
const CANDIDATES = ['index.html', 'build/index.html', 'studio/index.html', 'dev/game-mock.html', 'dev/render-demo.html', 'dev/battle-perf.html', 'dev/uikit.html'];
const IMPORT_MAP = /<script\s+type=["']importmap["']\s*>([\s\S]*?)<\/script>/g;
const INJECTED_RELEASE = /<script>(globalThis\.__sp[A-Za-z]+=[\s\S]*?)<\/script>/g;

function addInlineHashes(hashes, html) {
  for (const re of [IMPORT_MAP, INJECTED_RELEASE]) {
    for (const m of html.matchAll(re)) hashes.add(`'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  }
}
/** The page policy: every response carries it, and it may only allow scripts this server writes itself. */
export function siteCsp(publicDir, transformPage = null, cdnBase = '') {
  const hashes = new Set();
  for (const rel of CANDIDATES) {
    let html;
    try { html = fs.readFileSync(path.join(publicDir, rel), 'utf8'); } catch { continue; }
    addInlineHashes(hashes, html);
    // The bytes a browser validates are the transformed page, not the file on disk.
    if (!transformPage) continue;
    try { addInlineHashes(hashes, transformPage(html, path.extname(rel))); } catch {}
  }
  // Art served from `assetsCdn` (SP_ASSETS_CDN) arrives from a second origin, and CSP does not care that it is ours:
  // every directive the pictures, audio and fonts land in has to name it, and connect-src covers the preload's own
  // fetches. `script-src` never gains it — a CDN may ship art, never code.
  let art = '';
  if (cdnBase) { try { art = ` ${new URL(cdnBase).origin}`; } catch { art = ''; } }
  // `connect-src` names `blob:` for the object URLs public/js/resourceNetwork.js hands to Pixi: a runtime texture
  // page is downloaded by our transport and then decoded by Pixi 7.4, which fetches the blob when
  // `createImageBitmap` exists. `'self'` does not cover a blob: URL, so every Spine page failed in the texture
  // loader and the battle units fell back to their tokens (2026-10-19).
  return `default-src 'self'; script-src 'self'${hashes.size ? ' ' + [...hashes].join(' ') : ''}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com${art}; font-src 'self' https://fonts.gstatic.com${art}; img-src 'self' data: blob:${art}; media-src 'self'${art}; connect-src 'self' blob:${art}; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'`;
}
