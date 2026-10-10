import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { startServer } from '../server/index.js';
import { selectTracked } from '../tools/package.mjs';

async function boot(t) {
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  t.after(() => server.close());
  return server;
}
const post = (server, name) => fetch(server.url + '/api/nickname/validate', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
});

test('HTTP preflight only returns approval or a generic code; never creates a session', async t => {
  const server = await boot(t);
  for (const name of ['正常博士', '阿米娅', 'Scunthorpe']) {
    const response = await post(server, name);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  for (const name of ['习·近平', 'F.u.c.k', '法輪功', '傻逼博士']) {
    const response = await post(server, name);
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { ok: false, code: 'NICKNAME_SENSITIVE' });
  }
  assert.equal(server.registry.size, 0);
});

test('HTTP validation rejects methods, cross-site requests, malformed and oversized inputs', async t => {
  const server = await boot(t), url = server.url + '/api/nickname/validate';
  const cases = [
    [{ method: 'GET' }, 405],
    [{ method: 'OPTIONS' }, 405],
    [{ method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }, 415],
    [{ method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }, body: '{}' }, 403],
    [{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' }, 400],
    [{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'a'.repeat(13) }) }, 400],
    [{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(1025) }, 413],
  ];
  for (const [options, status] of cases) {
    const response = await fetch(url, options);
    assert.equal(response.status, status);
    const value = await response.json();
    assert.deepEqual(Object.keys(value).sort(), ['code', 'ok']);
    assert.equal(value.ok, false);
  }
});

function chunked(server, chunks, end = true) {
  return new Promise((resolve, reject) => {
    const req = http.request(server.url + '/api/nickname/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    }, res => {
      res.resume(); res.on('end', () => { req.destroy(); resolve(res.statusCode); });
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    if (end) req.end();
  });
}

test('chunked input is bounded and unfinished bodies time out', { timeout: 10000 }, async t => {
  const server = await boot(t);
  assert.equal(await chunked(server, ['x'.repeat(600), 'x'.repeat(600)]), 413);
  assert.equal(await chunked(server, ['{"name":'], false), 408);
});

test('preflight has a separate per-network rate budget', async t => {
  const server = await boot(t);
  for (let i = 0; i < 10; i++) assert.equal((await post(server, '正常博士')).status, 200);
  const limited = await post(server, '正常博士');
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '1');
  assert.deepEqual(await limited.json(), { ok: false, code: 'RATE_LIMITED' });
  assert.equal((await fetch(server.url + '/api/rooms/ABCD/status')).status, 404);
});

test('server dictionary cannot be downloaded through static or versioned mounts', async t => {
  const server = await boot(t);
  const { build } = await (await fetch(server.url + '/healthz')).json();
  const paths = ['/shared/nicknamePolicy.js', '/server/moderation/nickname.js',
    '/moderation/site-policy.js', '/server/moderation/lexicon/SOURCE.json',
    '/server/moderation/lexicon/words.txt', '/server/moderation/lexicon/words.b64', '/shared/words.b64', '/data/words.b64', '/shared/words.txt', '/data/words.txt', '/data/nicknamePolicy.js', '/sim/../moderation/nickname.js',
    '/sim/%2e%2e%2fmoderation/lexicon/SOURCE.json',
    '/shared/../server/moderation/site-policy.js',
    '/_v/' + build + '/shared/nicknamePolicy.js',
    '/_v/' + build + '/server/moderation/lexicon/SOURCE.json',
    '/_v/' + build + '/server/moderation/lexicon/words.txt',
    '/_v/' + build + '/server/moderation/lexicon/words.b64'];
  for (const path of paths) {
    const response = await fetch(server.url + path);
    assert.ok(response.status === 404 || response.status === 403, path + ': ' + response.status);
    assert.doesNotMatch(await response.text(), /NICKNAME_BLOCKED|d967c30b|Konsheng/);
  }
  assert.equal(existsSync(new URL('../shared/nicknamePolicy.js', import.meta.url)), false);
});

test('single merged dictionary retains pinned provenance, checksum, license and server package selection', () => {
  const root = new URL('../server/moderation/lexicon/', import.meta.url);
  const source = JSON.parse(readFileSync(new URL('SOURCE.json', root), 'utf8'));
  assert.equal(source.repository, 'https://github.com/konsheng/Sensitive-lexicon');
  assert.match(source.commit, /^[a-f0-9]{40}$/);
  assert.equal(source.upstreamFiles.filter(file => file.path.startsWith('Vocabulary/')).length, 17);
  assert.equal(source.merge.file, 'words.b64');
  assert.equal(source.merge.encoding, 'base64');
  assert.equal(source.merge.charset, 'utf-8');
  assert.equal(existsSync(new URL('words.txt', root)), false, 'no plaintext dictionary on disk');
  const bytes = readFileSync(new URL(source.merge.file, root));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), source.merge.sha256);
  const decoded = Buffer.from(bytes.toString('ascii').trim(), 'base64');
  assert.equal(decoded.toString('base64'), bytes.toString('ascii').trim(), 'canonical Base64');
  assert.equal(createHash('sha256').update(decoded).digest('hex'), source.merge.decodedSha256);
  const words = decoded.toString('utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#'));
  assert.equal(words.length, source.merge.terms);
  assert.equal(new Set(words).size, words.length);
  for (const word of words) {
    assert.ok(word.length <= 12 && [...word].length >= 2, word);
    assert.equal(word, word.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''), word);
    assert.ok(!source.filtering.upstreamExcludedTerms.includes(word), word);
  }
  const license = readFileSync(new URL('LICENSE', root));
  assert.match(license.toString('utf8'), /MIT License/);
  assert.equal(createHash('sha256').update(license).digest('hex'), source.upstreamFiles.find(file => file.path === 'LICENSE').sha256);
  assert.equal(existsSync(new URL('Vocabulary/', root)), false, 'no scattered runtime dictionaries');
  assert.equal(existsSync(new URL('../site-policy.js', root)), false, 'site additions are in the same word list');
  const paths = ['server/moderation/nickname.js', 'server/moderation/lexicon/words.b64',
    'server/moderation/lexicon/SOURCE.json', 'server/moderation/lexicon/LICENSE'];
  assert.deepEqual(selectTracked(paths).keep, paths.sort());
});
