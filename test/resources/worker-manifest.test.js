import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerManifestLoader } from '../../public/js/resources/workerManifest.js';
import { resourceWorkerUrl, isResourceWorker } from '../../public/js/resources/common.js';
import { fetchResource } from '../../public/js/resources/network.js';

const origin = 'https://game.example';
const tag = '0123456789abcdef';
const manifest = { format: 1, version: 'test', files: [{ url: '/assets/a.png', tier: 1, hash: 'aaaaaaaaaaaa', size: 1 }] };
const body = () => new Response(JSON.stringify(manifest));

test('worker URLs carry validated versions and ownership includes legacy and waiting workers only on this origin', () => {
  assert.equal(resourceWorkerUrl(tag), '/resource-sw.js?v=' + tag);
  for (const value of ['', 'bad', '../escape']) assert.equal(resourceWorkerUrl(value), '/resource-sw.js');
  for (const suffix of ['', '?v=' + tag]) assert.equal(isResourceWorker(origin + '/resource-sw.js' + suffix, origin), true);
  for (const url of [undefined, 'https://other.example/resource-sw.js', origin + '/other/resource-sw.js', origin + '/resource-sw.js.bak']) {
    assert.equal(isResourceWorker(url, origin), false);
  }
});

test('a restarted versioned worker revalidates the manifest and concurrent consumers share one read', async () => {
  const calls = [];
  const create = () => createWorkerManifestLoader({ scriptUrl: origin + resourceWorkerUrl(tag), fetcher: async (url, options) => {
    calls.push([url, options.cache]); return body();
  } });
  const load = create();
  const results = await Promise.all([load(), load(), load()]);
  assert.ok(results.every(result => result === results[0])); await load();
  assert.deepEqual(calls, [[origin + '/data/resource-manifest.json?v=' + tag, 'no-cache']]);
  await create()(); assert.equal(calls.length, 2, 'worker restart permits HTTP revalidation, not no-store');
});

test('only a retired version 404 falls back to the plain manifest; legacy workers also revalidate', async () => {
  const calls = [];
  const load = createWorkerManifestLoader({ scriptUrl: origin + resourceWorkerUrl(tag), fetcher: async url => {
    calls.push(url); return url.includes('?v=') ? new Response('retired', { status: 404 }) : body();
  } });
  assert.deepEqual(await load(), manifest); await load();
  assert.deepEqual(calls, [origin + '/data/resource-manifest.json?v=' + tag, origin + '/data/resource-manifest.json']);
  const legacy = createWorkerManifestLoader({ scriptUrl: origin + '/resource-sw.js', fetcher: async (url, options) => {
    assert.equal(url, origin + '/data/resource-manifest.json'); assert.equal(options.cache, 'no-cache'); return body();
  } });
  assert.deepEqual(await legacy(), manifest);
});

test('transient and malformed manifests cool down, then recover without permanent rejected promises', async () => {
  let at = 0, calls = 0;
  const load = createWorkerManifestLoader({ scriptUrl: origin + resourceWorkerUrl(tag), now: () => at, retryDelayMs: 10,
    fetcher: async url => { assert.ok(url.includes('?v=')); calls++; return calls === 1 ? new Response('busy', { status: 503 })
      : calls === 2 ? new Response('{}') : body(); } });
  await assert.rejects(load(), /503/); assert.equal(await load(), null); assert.equal(calls, 1);
  at = 10; await assert.rejects(load()); assert.equal(await load(), null);
  at = 20; assert.deepEqual(await load(), manifest); assert.equal(calls, 3);
});

test('ordinary asset downloads retain no-store while manifest fetch explicitly opts into revalidation', async () => {
  const policies = [];
  const fetcher = async (url, options) => { policies.push(options.cache); return new Response('a'); };
  await fetchResource(origin + '/assets/a.png', { fetcher });
  await fetchResource(origin + '/data/resource-manifest.json', { fetcher, cache: 'no-cache' });
  assert.deepEqual(policies, ['no-store', 'no-cache']);
});
