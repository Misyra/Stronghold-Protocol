// Incident defaults: preserve player/static budgets and avoid classifying a CDN by untrusted headers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (name) => fs.readFileSync(new URL('../../scripts/' + name, import.meta.url), 'utf8');
const business = read('hardening/sp-business-limit-map.conf');
const api = read('hardening/sp-public-api-map.conf');

// Evaluate the exact-before-regex map semantics for these simple, flat configuration tables.
function mapped(source, name, key) {
  const body = source.match(new RegExp(`map [^\\n]+ \\$${name} \\{([\\s\\S]*?)\\n\\}`))?.[1];
  assert.ok(body, `map ${name} exists`);
  const rows = body.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    .map(line => line.match(/^("[^"]*"|\S+)\s+("[^"]*"|\S+);$/)).filter(Boolean)
    .map(([, k, value]) => [k.replace(/^"|"$/g, ''), value.replace(/^"|"$/g, '')]);
  const exact = rows.find(([k]) => k === key && k !== 'default');
  if (exact) return exact[1];
  for (const [k, value] of rows) if (k.startsWith('~') && new RegExp(k.slice(1)).test(key)) return value;
  return rows.find(([k]) => k === 'default')?.[1];
}

test('origin static routes and aliases never consume the permanent business budget', () => {
  for (const uri of ['/build/assets/index-abcdefgh.js', '/sim/spec.js', '/shared/protocol.js', '/data/chess.json',
    '/media/bgm/act1', '/assets/a.png', '/fonts/fonts.css', '/cs/0123456789abcdef/index.json',
    '/vs/0123456789abcdef/overlay.json', '/p/test/01234567/a.png', '/packs/index.json',
    '/manifest.json', '/resource-sw.js', '/_gate/assets/entry.js', '/data.js',
    '/_v/0123456789abcdef/build/assets/index-abcdefgh.js', '/_v/0123456789abcdef/media/bgm/act1']) {
    const candidate = mapped(business, 'sp_static_candidate', uri);
    assert.equal(candidate, '1', uri);
    assert.equal(mapped(business, 'sp_business_key', candidate + ':' + uri), '', uri);
    assert.equal(mapped(business, 'sp_log_business', candidate + ':' + uri), '0', uri);
    const cosmetic = mapped(business, 'sp_cosmetic_asset', uri);
    assert.equal(mapped(business, 'sp_static_key', candidate + ':' + cosmetic),
      cosmetic === '1' ? '' : '$binary_remote_addr', uri);
  }
  // A forged CDN-related header cannot turn an origin business request into a free static request.
  for (const uri of ['/api/rooms/AAAA/status', '/api/announcement', '/ws', '/unknown']) {
    assert.equal(mapped(business, 'sp_static_candidate', uri), '0', uri);
    assert.equal(mapped(business, 'sp_business_key', '0:' + uri), '$binary_remote_addr', uri);
  }
  assert.equal(mapped(business, 'sp_business_key', '0:/api/ping'), '');
  assert.equal(mapped(business, 'sp_log_business', '0:/api/ping'), '0');
  for (const uri of ['/_sp/ip-check', '/_sp/gate-check', '/_sp/http-drop'])
    assert.equal(mapped(business, 'sp_business_key', '0:' + uri), '');
});

test('portal budgets share room-code counters, exempt loopback and distinguish unrelated prefixes', () => {
  assert.equal(mapped(api, 'sp_ping_key', '0:/api/ping'), '$binary_remote_addr');
  assert.equal(mapped(api, 'sp_ping_key', '1:/api/ping'), '');
  for (const uri of ['/api/rooms', '/api/rooms/AAAA/status', '/api/rooms/BBBB/status']) {
    assert.equal(mapped(api, 'sp_rooms_key', '0:' + uri), '$binary_remote_addr');
    assert.equal(mapped(api, 'sp_rooms_key', '1:' + uri), '');
  }
  assert.equal(mapped(api, 'sp_rooms_key', '0:/api/roomsmith'), '');
});

test('public resource manifest has one location in each alternative template and preserves isolation', () => {
  const cache = read('nginx-game-cache.conf.example');
  const gate = read('hardening/sp-browser-gate.conf');
  for (const source of [cache, gate]) {
    for (const uri of ['/data/resource-manifest.json', '/assets-manifest.json']) {
      assert.equal(source.split(`location = ${uri} {`).length - 1, 1, uri);
      const block = source.split(`location = ${uri} {`)[1].split('\n}')[0];
      assert.match(block, /auth_request off;/);
    }
  }
  const location = cache.match(/location = \/data\/resource-manifest\.json \{([\s\S]*?)\n\}/)[1];
  assert.match(location, /proxy_cache_key .*\$host.*\$proxy_host.*\$request_uri/);
  assert.match(location, /auth_request off;/);
  assert.match(location, /proxy_cache_use_stale off;/);
  const source = cache.match(/location ~ \^\/\(\?:build\/assets\/[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(source, /proxy_ignore_headers/,
    'upstream no-cache for bare simulation and private/error responses must remain authoritative');
  assert.match(source, /proxy_cache_lock on;/);
});

test('icons and fonts skip per-IP static budgets while modules and APIs retain theirs', () => {
  for (const uri of ['/favicon.ico', '/apple-touch-icon.png', '/icons/app.png', '/fonts/fonts.css',
    '/build/assets/favicon-abcd.png', '/build/assets/app-abcd.svg', '/build/assets/font-abcd.woff2',
    '/_v/0123456789abcdef/fonts/fonts.css', '/_v/0123456789abcdef/icons/app.png']) {
    assert.equal(mapped(business, 'sp_static_candidate', uri), '1', uri);
    assert.equal(mapped(business, 'sp_cosmetic_asset', uri), '1', uri);
    assert.equal(mapped(business, 'sp_static_key', '1:1'), '', uri);
    assert.equal(mapped(business, 'sp_business_key', '1:' + uri), '', uri);
    assert.equal(mapped(business, 'sp_business_conn_key', '1:' + uri), '', uri);
  }
  for (const uri of ['/api/announcement', '/ws', '/build/assets/app.js', '/assets/art.png', '/fonts-api'])
    assert.equal(mapped(business, 'sp_cosmetic_asset', uri), '0', uri);
  assert.equal(mapped(business, 'sp_static_key', '1:0'), '$binary_remote_addr');
  assert.match(read('nginx.conf.example'), /limit_conn sp_conn_all 4500;/);
});

test('alternate SYN templates agree with the normative ops policy without changing burst/global limits', () => {
  const policy = fs.readFileSync(new URL('../../ops/sp-web-syn-guard.nft', import.meta.url), 'utf8');
  const limits = source => source.split('\n').filter(line => !line.trim().startsWith('#'))
    .map(line => line.match(/limit rate over (\d+\/\w+) burst (\d+) packets/))
    .filter(Boolean).map(([, rate, burst]) => [rate, Number(burst)]);
  const expected = [['120/minute', 40], ['120/minute', 40], ['50/second', 100]];
  assert.deepEqual(limits(policy), expected);
  assert.deepEqual(limits(read('hardening/sp-web-syn-guard.nft.example')), expected);
});
