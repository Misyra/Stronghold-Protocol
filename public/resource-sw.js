// Adapted from xinhai-ai/Stronghold-Protocol (GPL-3.0-or-later).
// public/resource-sw.js — the optional asset-preload Service Worker (docs/development/ASSETS.md「Preload」).
//
// Registered with `type: 'module'` by public/js/resources/index.js when the player turns the preload on (设置 ▸ 预载资源)
// and unregistered when its retained cache is cleared. Its scope is "/", but it only ever touches GET requests for the resource trees
// (`/assets/**`, `/fonts/**`, and the extension-less `/media/**` audio route the game asks audio through — site paths or
// CDN URLs): code, game data, API calls and WebSocket upgrades pass straight through to the network, so a stale worker
// can never serve a stale game.

import { isResourcePath, MANIFEST_URL, validateManifest } from './js/resources/common.js';
import { fetchResource } from './js/resources/network.js';
import { createResourceResponder } from './js/resources/readThrough.js';

let manifestPromise;
let manifestRetryAt = 0;
const responder = createResourceResponder({ network: { timeoutMs: 25000, retries: 0 }, getManifest: () => {
  if (!manifestPromise && Date.now() < manifestRetryAt) return Promise.resolve(null);
  manifestPromise ??= fetchResource(new URL(MANIFEST_URL, self.location.origin).href, { timeoutMs: 10000, retries: 0 })
    .then((res) => res.json()).then(validateManifest).catch((err) => { manifestPromise = null; manifestRetryAt = Date.now() + 10000; throw err; });
  return manifestPromise;
} });

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'sp-resource-mode') return;
  event.waitUntil(responder.mode(event.data.enabled).then(() => event.ports[0]?.postMessage({ ok: true })));
});

self.addEventListener('install', (event) => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url;
  try { url = new URL(request.url); } catch { return; }
  if (!isResourcePath(url.pathname)) return;
  event.respondWith(responder.respond(request));
});
