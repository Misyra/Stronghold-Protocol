import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadImageElement } from '../../public/js/assets.js';
import { recoverImageError } from '../../public/js/image.js';

function environment(t, failures, response = { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }) {
  let attempts = 0;
  const requests = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  globalThis.Image = class {
    set src(url) {
      assert.equal(this.crossOrigin, 'anonymous');
      this.url = url;
      const failed = attempts++ < failures;
      queueMicrotask(() => failed ? this.onerror?.() : this.onload?.());
    }
  };
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'Image', previous);
    else delete globalThis.Image;
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    if (response instanceof Error) throw response;
    return response;
  });
  return { requests, attempts: () => attempts };
}

test('successful image loads keep their normal browser cache path', async t => {
  const env = environment(t, 0);
  const img = await loadImageElement('https://assets.example/icon.png?v=123');
  assert.equal(img.url, 'https://assets.example/icon.png?v=123');
  assert.equal(env.attempts(), 1);
  assert.deepEqual(env.requests, []);
});

test('a cached non-CORS image is refreshed once before decoding the original URL again', async t => {
  const env = environment(t, 1);
  const url = 'https://assets.example/icon.png?v=123';
  assert.equal((await loadImageElement(url)).url, url);
  assert.equal(env.attempts(), 2);
  assert.equal(env.requests.length, 1);
  const { signal, ...options } = env.requests[0].options;
  assert.equal(env.requests[0].url, url);
  assert.deepEqual(options, { mode: 'cors', credentials: 'same-origin', cache: 'reload' },
    'the repair fetch keeps the host session cookie: an anonymous one is exactly what a challenged host refuses');
  assert.ok(signal instanceof AbortSignal);
});

test('a persistent decode error never loops or silently accepts an unsafe image', async t => {
  const env = environment(t, 10);
  await assert.rejects(loadImageElement('https://assets.example/bad.png'), /image failed/);
  assert.equal(env.attempts(), 2);
  assert.equal(env.requests.length, 1);
});

for (const response of [{ ok: false, status: 404 }, new Error('CORS denied')]) {
  test(`failed recovery stops without another image attempt: ${response.status || response.message}`, async t => {
    const env = environment(t, 1, response);
    await assert.rejects(loadImageElement('https://assets.example/missing.png'), /image failed/);
    assert.equal(env.attempts(), 1);
    assert.equal(env.requests.length, 1);
  });
}

test('concurrent repairs share one fetch without changing the content-hashed URL', async t => {
  const env = environment(t, 0);
  const url = 'https://assets.example/shared.png?v=123';
  const images = await Promise.all(Array.from({ length: 8 }, () => loadImageElement(url, { refresh: true })));
  assert.equal(env.requests.length, 1);
  assert.equal(images.length, 8);
  assert.ok(images.every(img => img.url === url));
});

test('a same-origin image asks without CORS so the host session cookie survives', async t => {
  withLocation(t, 'https://game.example');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  let seen;
  globalThis.Image = class {
    set src(value) { seen = { url: value, crossOrigin: this.crossOrigin }; queueMicrotask(() => this.onload?.()); }
  };
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'Image', previous); else delete globalThis.Image; });
  await loadImageElement('https://game.example/assets/icon.png');
  assert.equal(seen.crossOrigin, undefined, 'a CORS request to the game host drops the very cookie a challenge needs');
  assert.equal(seen.url, 'https://game.example/assets/icon.png');
});

test('an asset CDN that refuses the page hands the image to the game host copy', async t => {
  withLocation(t, 'https://game.example');
  withCdn(t, 'https://assets.example');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  const requests = [];
  let attempts = 0;
  globalThis.Image = class {
    set src(value) {
      this.url = value;
      const failed = attempts++ === 0;
      queueMicrotask(() => failed ? this.onerror?.() : this.onload?.());
    }
  };
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'Image', previous); else delete globalThis.Image; });
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    return String(url).startsWith('https://assets.example') ? new Response('nope', { status: 403 }) : new Response(new ArrayBuffer(0));
  });
  const img = await loadImageElement('https://assets.example/assets/icon.png?v=0123456789abcdef');
  assert.equal(img.url, '/assets/icon.png', 'the copy drops the per-file cache-buster');
  assert.deepEqual(requests, ['https://assets.example/assets/icon.png?v=0123456789abcdef', '/assets/icon.png']);
  const again = await loadImageElement('https://assets.example/assets/icon.png?v=0123456789abcdef');
  assert.equal(again.url, '/assets/icon.png', 'the working copy is remembered for the session');
});

function withLocation(t, origin) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: { origin, href: origin + '/' }, configurable: true, writable: true });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'location', previous); else delete globalThis.location; });
}

function withCdn(t, base) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, '__spAssetCdn');
  globalThis.__spAssetCdn = { base };
  t.after(() => { if (previous) Object.defineProperty(globalThis, '__spAssetCdn', previous); else delete globalThis.__spAssetCdn; });
}

function domImage(src) {
  return { src, isConnected: true, getAttribute(name) { return name === 'src' ? this.src : null; } };
}
const drain = () => new Promise(resolve => setImmediate(resolve));

test('a stalled image has a deadline and late callbacks cannot complete it', async t => {
  environment(t, 0);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let image;
  globalThis.Image = class {
    constructor() { image = this; }
    set src(value) { this.url = value; }
    removeAttribute(name) { if (name === 'src') this.url = ''; }
  };
  const pending = loadImageElement('/stalled.png', { timeoutMs: 50 });
  const lateLoad = image.onload;
  const rejected = assert.rejects(pending, { name: 'TimeoutError' });
  t.mock.timers.tick(50);
  await rejected;
  assert.equal(image.url, '');
  assert.equal(image.onload, null);
  lateLoad();
});

test('DOM recovery retries the original element once before invoking its fallback', async t => {
  const env = environment(t, 0);
  const img = domImage('https://assets.example/item.png?v=123');
  const event = { currentTarget: img };
  let failed = 0;
  recoverImageError(event, () => failed++);
  recoverImageError(event, () => failed++);
  await drain();
  assert.equal(failed, 0);
  assert.equal(env.requests.length, 1);
  assert.equal(img.src, 'https://assets.example/item.png?v=123');
  recoverImageError(event, () => failed++);
  assert.equal(failed, 1);
  assert.equal(env.requests.length, 1);
});

test('DOM permanent failures preserve the existing fallback', async t => {
  environment(t, 0, { ok: false });
  let failed = 0;
  recoverImageError({ currentTarget: domImage('/missing.png') }, () => failed++);
  await drain();
  assert.equal(failed, 1);
});

for (const change of ['unmount', 'new URL']) {
  test(`a late DOM repair cannot change an image after ${change}`, async t => {
    let complete;
    environment(t, 0, { ok: true, arrayBuffer: () => new Promise(resolve => { complete = resolve; }) });
    const img = domImage('/old.png');
    let assignments = 0, failed = 0;
    Object.defineProperty(img, 'src', { get: () => '/new.png', set: () => { assignments++; } });
    img.getAttribute = () => '/old.png';
    recoverImageError({ currentTarget: img }, () => failed++);
    await drain();
    if (change === 'unmount') img.isConnected = false;
    else img.getAttribute = () => '/new.png';
    complete(new ArrayBuffer(0));
    await drain();
    assert.equal(assignments, 0);
    assert.equal(failed, 0);
  });
}
