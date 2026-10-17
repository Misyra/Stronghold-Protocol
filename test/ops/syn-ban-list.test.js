// test/ops/syn-ban-list.test.js — 内核层名单的生成物与加载器的契约（不需要 root、nft 或 Linux）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { BLOCK_IPS } from '../../server/netBlock.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const entries = (text) => text.split('\n').map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/)[0]);

test('the generated IPv4 list matches server/netBlock.js and has no stale entries', () => {
  const run = spawnSync(process.execPath, ['tools/net-ban.mjs', '--check'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const v4 = entries(read('../../ops/blocked-ipv4.txt'));
  const expected = [...BLOCK_IPS].filter((ip) => !ip.includes(':'));
  assert.equal(v4.length, expected.length);
  assert.deepEqual([...v4].sort(), [...expected].sort());
  for (const ip of v4) assert.match(ip, /^\d{1,3}(?:\.\d{1,3}){3}$/, ip);
});

test('the generated files carry no timestamp, so --check stays meaningful', () => {
  for (const f of ['../../ops/blocked-ipv4.txt', '../../ops/blocked-ipv6.txt']) {
    const head = read(f).split('\n').slice(0, 4).join('\n');
    assert.match(head, /tools\/net-ban\.mjs/, f);
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(head), f + ' must not embed a generation time');
  }
});

test('the loader reads both v4 sources, keeps IPv6 out of perm4, and exempts loopback', () => {
  const script = read('../../ops/sp-syn-ban-load');
  for (const needle of ['banned-ips.txt', 'blocked-ipv4.txt', 'blocked-ipv6.txt',
    'type ipv4_addr', 'type ipv6_addr', 'ip6 saddr @perm6', 'iifname "lo" return',
    'nft -c -f "$CHECK"', 'delete table inet sp_syn_ban']) {
    assert.ok(script.includes(needle), 'missing: ' + needle);
  }
  // 手工名单与生成名单必须在同一个 perm4 里合并，否则两份各建一张表会互相覆盖。
  assert.match(script, /elements "\$LIST" "\$GEN4"/);
});

test('the manual ban list stays parseable, duplicate-free, and may overlap the generated one', () => {
  const manual = entries(read('../../ops/banned-ips.txt'));
  assert.ok(manual.length > 0);
  for (const ip of manual) assert.match(ip, /^(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]+)(\/\d{1,3})?$/i, ip);
  // Overlap with the generated list is fine (the loader runs sort -u), but duplicates inside one file are not.
  assert.equal(new Set(manual).size, manual.length, 'duplicate entry in ops/banned-ips.txt');
});
