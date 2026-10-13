import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { within } from '../server/pathSafety.js';
import { resourceIdentity } from '../shared/resourcePaths.js';
import { splitClocks, mergeClocks } from '../server/stateClocks.js';
import { markResourceHeaders, cachedResourceHash, readCacheIndex } from '../public/js/resources/cacheMetadata.js';
import { distribution } from '../tools/lib/bench.mjs';

test('private-path checks distinguish roots, siblings, dot-prefixed children and traversal', () => {
  const root = path.resolve('public');
  assert.equal(within(root, root), true);
  assert.equal(within(root, root, { allowRoot: false }), false);
  assert.equal(within(root, path.join(root, '..cache', 'log')), true);
  assert.equal(within(root, root + '-private'), false);
  assert.equal(within(root, path.join(root, '..', 'private')), false);
});

test('resource identities agree across CDN hosts, releases, encoded Unicode and queries', () => {
  assert.equal(resourceIdentity('https://cdn.example/prefix/assets/中文[x].png?v=abc'), '/assets/中文[x].png');
  assert.equal(resourceIdentity('/_v/0123456789abcdef/assets/%E4%B8%AD%E6%96%87%5Bx%5D.png'), '/assets/中文[x].png');
  for (const url of ['/assets/a%2fb', '/assets/a%5cb', '/assets/a%00b', '/assets/%ZZ', '/assets/a%3fb']) assert.equal(resourceIdentity(url), null);
});

test('clock envelopes round-trip and nonfinite clocks cannot poison recovery', () => {
  const doc = { round: 3, deadlineRemainingMs: 12, startedAtAgoMs: 8 };
  const split = splitClocks(doc);
  assert.deepEqual(split.body, { round: 3 });
  assert.deepEqual(mergeClocks(split.body, split.clocks), doc);
  assert.deepEqual(mergeClocks(split.body, { deadlineRemainingMs: NaN }), split.body);
});

test('benchmark percentiles have one definition and leave samples in measurement order', () => {
  const values = [3, 1, 2];
  assert.deepEqual(distribution(values), { count: 3, p50: 2, p95: 3, p99: 3, max: 3 });
  assert.deepEqual(values, [3, 1, 2]);
});

test('root tool and deployment entry points are listed in their README', () => {
  for (const directory of ['tools', 'scripts']) {
    const readme = readFileSync(new URL(`../${directory}/README.md`, import.meta.url), 'utf8');
    for (const entry of readdirSync(new URL(`../${directory}/`, import.meta.url))) {
      if (/\.(?:mjs|ps1)$/.test(entry)) assert.ok(readme.includes('`' + entry + '`'), `${directory}/${entry}`);
    }
  }
});

test('cache receipts remove stale hashes and reject unknown index schemas', () => {
  const headers = markResourceHeaders(new Headers(), '0123456789ab');
  assert.equal(cachedResourceHash(new Response('x', { headers })), '0123456789ab');
  markResourceHeaders(headers, null);
  assert.equal(cachedResourceHash(new Response('x', { headers })), null);
  assert.deepEqual(readCacheIndex({ version: 999, files: { '/a': 'b' } }), { manifest: '', files: {} });
  assert.deepEqual(readCacheIndex({ files: [] }), { manifest: '', files: {} });
});
