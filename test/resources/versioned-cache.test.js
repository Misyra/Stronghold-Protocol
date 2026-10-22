import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createResourceResponder } from '../../public/js/resources/readThrough.js';
import { markResourceHeaders } from '../../public/js/resources/cacheMetadata.js';
import { CACHE_NAME } from '../../public/js/resources/common.js';

const origin = 'https://game.example';
const base = 'https://assets.example/assets/char/avatar/amiya.png';
const body = 'preloaded avatar bytes';
const hash = createHash('sha1').update(body).digest('hex').slice(0, 12);
const version = createHash('sha256').update(body).digest('hex').slice(0, 16);
function fixture({ getManifest, path = base, marker = true, size = body.length } = {}) {
  const entries = new Map();
  const headers = new Headers({ 'Content-Type': 'image/png', 'Content-Length': String(size) });
  if (marker) markResourceHeaders(headers, hash);
  entries.set(path, new Response(body, { headers }));
  const cache = { match: async (key) => entries.get(key)?.clone() };
  let network = 0, manifests = 0;
  const responder = createResourceResponder({ origin, caches: { keys: async () => [CACHE_NAME], open: async () => cache },
    getManifest: () => { manifests++; return getManifest ? getManifest() : Promise.resolve({ files: [{ url: path, hash, size: body.length, tier: 1 }] }); },
    fetcher: async () => { network++; return new Response('NETWORK'); } });
  return { responder, entries, get network() { return network; }, get manifests() { return manifests; } };
}

test('versioned render requests reuse bare preload bytes while a cold worker manifest is unavailable', async () => {
  const f = fixture({ getManifest: () => new Promise(() => {}) });
  const response = await f.responder.respond(new Request(base + '?v=' + version));
  assert.equal(await response.text(), body);
  assert.deepEqual([f.network, f.manifests], [0, 0]);
  const range = await f.responder.respond(new Request(base + '?v=' + version, { headers: { Range: 'bytes=0-8' } }));
  assert.equal(range.status, 206);
  assert.equal(await range.text(), body.slice(0, 9));
});

test('a different revision or arbitrary query never receives the bare preload copy', async () => {
  const f = fixture();
  for (const suffix of ['?v=0000000000000000', '?v=' + version + '&other=1', '?v=' + version + '&v=' + version, '?sp=retry&v=' + version]) {
    assert.equal(await (await f.responder.respond(new Request(base + suffix))).text(), 'NETWORK');
  }
  assert.equal(f.network, 4);
});

test('an unmarked entry, invalid length or non-resource cannot use the revision fast path', async () => {
  for (const options of [{ marker: false }, { size: 1 }, { path: origin + '/api/private' }]) {
    const f = fixture(options);
    assert.equal(await (await f.responder.respond(new Request((options.path || base) + '?v=' + version))).text(), 'NETWORK');
    assert.equal(f.network, 1);
  }
});

test('a verified revision is hashed once, but an evicted entry is never invented from the memo', async (t) => {
  const f = fixture();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let hashes = 0;
  t.mock.method(crypto.subtle, 'digest', (...args) => { if (args[0] === 'SHA-256') hashes++; return digest(...args); });
  for (let i = 0; i < 3; i++) assert.equal(await (await f.responder.respond(new Request(base + '?v=' + version))).text(), body);
  assert.equal(hashes, 1);
  f.entries.delete(base);
  assert.equal(await (await f.responder.respond(new Request(base + '?v=' + version))).text(), 'NETWORK');
  assert.equal(f.network, 1);
});
