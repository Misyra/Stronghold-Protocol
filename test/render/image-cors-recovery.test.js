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
  assert.deepEqual(options, { mode: 'cors', credentials: 'omit', cache: 'reload' });
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

function domImage(src) {
  return { src, isConnected: true, getAttribute(name) { return name === 'src' ? this.src : null; } };
}
const drain = () => new Promise(resolve => setImmediate(resolve));

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
