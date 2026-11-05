// test/resources/pack-gap.test.js — the append-only "gap" build contract of
// tools/build-resource-packs.mjs (tools/assets/gapPacks.mjs).
//
// A gap build packages only the manifest files the current index does not name
// yet, then APPENDS the new packs. It must never rewrite, renumber or drop an
// existing pack: AGENTS.md "ModelScope is append-only and incomplete".
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { coveredUrls, gapFilesOf, gapGroups, gapGroupOf, mergeAppendOnly } from '../../tools/assets/gapPacks.mjs';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const file = (url, tier = 1, extra = {}) => ({ url, tier, hash: sha1(url).slice(0, 12), size: 32, ...extra });
const pack = (id, urls, sha = sha1(id)) => ({
  id, url: `/resource-packs/${id}-${sha.slice(0, 12)}.zip`, group: id.replace(/-\d+$/, ''),
  tier: 1, count: urls.length, bytes: urls.length * 32, size: 1024, sha1: sha,
  files: urls.map((u) => ({ url: u, size: 32, hash: sha1(u).slice(0, 12) })),
});

/** A plausible previous index with two packs. */
function previousIndex() {
  return {
    format: 'stronghold-resource-pack-index', version: 1,
    resourceVersion: 'old-version-00', maxBytes: 16_000_000,
    packs: [
      pack('fx-01', ['/assets/local/fx/a.json', '/assets/local/fx/b.json']),
      pack('skin-01', ['/assets/spine/op/a/skin/front/a.skel']),
    ],
  };
}

describe('gap builds: uncovered files only', () => {
  test('coveredUrls normalizes encoded brackets/spaces to the same identity as the manifest', () => {
    const idx = previousIndex();
    idx.packs.push(pack('ui-01', ['/assets/ui/%5Buc%5Dx/a%20b.png']));
    const covered = coveredUrls(idx);
    assert.ok(covered.has('/assets/local/fx/a.json'));
    assert.ok(covered.has('/assets/spine/op/a/skin/front/a.skel'));
    // resourceIdentity decodes [uc]/%20, so the index row and a literal manifest URL match.
    assert.ok(covered.has('/assets/ui/[uc]x/a b.png'));
    assert.equal(covered.size, 4);
  });

  test('gapFilesOf returns exactly the manifest files no pack names', () => {
    const idx = previousIndex();
    const manifest = { files: [
      file('/assets/local/fx/a.json', 2, { fx: true }),       // covered
      file('/assets/spine/op/a/skin/front/a.skel', 2, { skin: 'a/s' }), // covered
      file('/assets/ui/a.png'),                              // gap
      file('/assets/audio/voice/cn/v.mp3', 2),                // gap
      file('/assets/char/avatar/x.png'),                     // gap
    ] };
    const gap = gapFilesOf(manifest, idx).map((f) => f.url);
    assert.deepEqual(gap.sort(), [
      '/assets/audio/voice/cn/v.mp3', '/assets/char/avatar/x.png', '/assets/ui/a.png',
    ].sort());
  });

  test('a missing/broken index means the whole manifest is the gap', () => {
    const manifest = { files: [file('/assets/ui/a.png'), file('/assets/audio/bgm/b.mp3', 2)] };
    assert.equal(gapFilesOf(manifest, null).length, 2);
    assert.equal(gapFilesOf(manifest, { format: 'wrong', packs: [] }).length, 2);
  });

  test('an encoded traversal is normalized by resourceIdentity, so it matches a literal index row', () => {
    // resourceIdentity decodes %2e%2e and strips the traversal: both spellings
    // collapse to /secret.png, so a covered entry cannot be smuggled in as "new".
    const idx = previousIndex();
    idx.packs.push(pack('ui-02', ['/secret.png']));
    const manifest = { files: [file('/assets/%2e%2e/secret.png'), file('/assets/ui/a.png')] };
    const gap = gapFilesOf(manifest, idx);
    assert.deepEqual(gap.map((f) => f.url), ['/assets/ui/a.png']);
  });

  test('gapGroups mirrors resource_packs.py group names for the plan line', () => {
    assert.equal(gapGroupOf(file('/assets/spine/op/x/front/x.skel')), 'spine');
    assert.equal(gapGroupOf(file('/assets/local/fx/a.json', 2, { fx: true })), 'fx');
    assert.equal(gapGroupOf(file('/assets/audio/voice/cn/v.mp3', 2)), 'voice_cn');
    assert.equal(gapGroupOf(file('/assets/audio/sfx/s.mp3', 2)), 'sfx');
    assert.equal(gapGroupOf(file('/assets/audio/bgm/b.mp3', 2)), 'bgm');
    assert.equal(gapGroupOf(file('/assets/char/avatar/x.png')), 'character');
    assert.equal(gapGroupOf(file('/assets/ui/a.png')), 'ui');
    assert.equal(gapGroupOf(file('/assets/local/map/t.json')), 'map');
    assert.equal(gapGroupOf(file('/assets/x.bin', 2)), 'other');
    assert.equal(gapGroupOf(file('/assets/skin/a.png', 2, { skin: 'a/s' })), 'skin');
    const groups = gapGroups([
      file('/assets/ui/a.png'), file('/assets/ui/b.png'), file('/assets/audio/voice/cn/v.mp3', 2),
    ]);
    assert.deepEqual(groups, { ui: 2, voice_cn: 1 });
  });
});

describe('gap builds: append-only merge', () => {
  test('every previous pack is kept verbatim, new packs get a gap- id', () => {
    const idx = previousIndex();
    const before = JSON.parse(JSON.stringify(idx.packs));
    const generated = {
      format: 'stronghold-resource-pack-index', version: 1, resourceVersion: 'generated', maxBytes: 16_000_000,
      packs: [pack('ui-01', ['/assets/ui/a.png']), pack('voice_cn-01', ['/assets/audio/voice/cn/v.mp3'])],
    };
    const merged = mergeAppendOnly(idx, generated);
    assert.deepEqual(merged.packs.slice(0, 2), before, 'old entries unchanged');
    assert.deepEqual(merged.packs.slice(2).map((p) => p.id), ['gap-ui-01', 'gap-voice_cn-01']);
    assert.equal(merged.packs.length, 4);
  });

  test('new ids never collide with an existing same-group id', () => {
    const idx = previousIndex();
    idx.packs.push(pack('ui-01', ['/assets/ui/old.png']));
    const merged = mergeAppendOnly(idx, { packs: [pack('ui-01', ['/assets/ui/new.png'])] });
    const ids = merged.packs.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
    assert.ok(ids.includes('gap-ui-01'));
  });

  test('resourceVersion is recomputed from the full pack list', () => {
    const idx = previousIndex();
    const generated = { packs: [pack('ui-01', ['/assets/ui/a.png'])] };
    const merged = mergeAppendOnly(idx, generated);
    const expected = sha1(JSON.stringify(merged.packs.map((p) => p.sha1))).slice(0, 12);
    assert.equal(merged.resourceVersion, expected);
    assert.notEqual(merged.resourceVersion, idx.resourceVersion);
    assert.equal(merged.format, 'stronghold-resource-pack-index');
    assert.equal(merged.version, 1);
    assert.equal(merged.maxBytes, 16_000_000);
  });

  test('merge is idempotent in shape: a second gap build still keeps all earlier entries', () => {
    const first = mergeAppendOnly(previousIndex(), { packs: [pack('ui-01', ['/assets/ui/a.png'])] });
    const second = mergeAppendOnly(first, { packs: [pack('spine-01', ['/assets/spine/x.skel'])] });
    assert.equal(second.packs.length, 4);
    assert.deepEqual(second.packs.slice(0, 2), previousIndex().packs);
    assert.equal(second.packs[2].id, 'gap-ui-01');
    assert.equal(second.packs[3].id, 'gap-spine-01');
  });

  test('a broken previous index degrades to just the generated packs', () => {
    const merged = mergeAppendOnly({ format: 'wrong' }, { packs: [pack('ui-01', ['/assets/ui/a.png'])] });
    assert.equal(merged.packs.length, 1);
    assert.equal(merged.packs[0].id, 'gap-ui-01');
  });
});
