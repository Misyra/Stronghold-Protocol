// Adapted from xinhai-ai/Stronghold-Protocol (GPL-3.0-or-later).
// public/resource-sw.js — the optional asset-preload Service Worker (docs/development/ASSETS.md「Preload」).
//
// Registered with `type: 'module'` by public/js/resources/index.js when the player turns the preload on (设置 ▸ 预载资源)
// and unregistered when its retained cache is cleared. Its scope is "/", but it only ever touches GET requests for the resource trees
// (`/assets/**`, `/fonts/**`, and the extension-less `/media/**` audio route the game asks audio through — site paths or
// CDN URLs): code, game data, API calls and WebSocket upgrades pass straight through to the network, so a stale worker
// can never serve a stale game.

import { isResourcePath } from './js/resources/common.js';
import { createWorkerManifestLoader } from './js/resources/workerManifest.js';
import { createResourceResponder } from './js/resources/readThrough.js';

const responder = createResourceResponder({ network: { timeoutMs: 25000, retries: 0 },
  getManifest: createWorkerManifestLoader({ scriptUrl: self.location.href }) });

self.addEventListener('message', (event) => {
  if (event.data?.type === 'sp-resource-cache-v1') {
    const reply = (data) => { event.ports[0]?.postMessage(data); event.ports[0]?.close(); };
    if (event.data.hello) { reply({ protocol: 1 }); return; }
    event.waitUntil(responder.ensureCached(event.data).then((result) => reply({ result }), (err) => reply({ error: {
      name: err?.name, message: err?.message, status: err?.status, retryAfter: err?.retryAfter, transient: err?.transient,
    } })));
    return;
  }
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
