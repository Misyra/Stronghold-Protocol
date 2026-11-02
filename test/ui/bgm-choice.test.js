// 对局音乐 (js/bgmChoice.js, ported from the Stardust fork): which BGM key follows which pick, which picks a manifest can
// offer, and the fallbacks — a missing track, 自选曲 without a file, a pick that failed this page: the official one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BGM_CHOICES, sanitizeBgmChoice, bgmChoiceKind, bgmOptions, trackOf, pickedBgm } from '../../public/js/bgmChoice.js';

const MANIFEST = {
  audio: {
    bgm: {
      lobby: { loop: '/l.mp3', intro: '/li.mp3' },
      prep: { loop: '/p.mp3' },
      combatAlts: [{ loop: '/k.mp3' }, { loop: '/f.mp3', intro: '/fi.mp3' }],
      unite: { loop: '/u.mp3' },
    },
  },
};

test('a pick is one of the known ids, anything else is 官方', () => {
  for (const id of BGM_CHOICES) assert.equal(sanitizeBgmChoice(id), id);
  for (const junk of [null, undefined, 'nope', 7, {}]) assert.equal(sanitizeBgmChoice(junk), 'official');
  assert.deepEqual(BGM_CHOICES.slice(0, 2), ['official', 'prep']);
  assert.ok(BGM_CHOICES.includes('custom'));
});

test('only 休整期 and 作战 follow a pick; 联防, the boss rounds and the lobby keep theirs', () => {
  assert.equal(bgmChoiceKind('prep'), 'prep');
  assert.equal(bgmChoiceKind('combat'), 'combat');
  assert.equal(bgmChoiceKind('combat:1'), 'combat');
  for (const key of ['lobby', 'unite', 'boss', 'boss:xyz', null]) assert.equal(bgmChoiceKind(key), null);
});

test('trackOf answers the manifest track or null', () => {
  assert.deepEqual(trackOf(MANIFEST, 'knight'), { intro: null, loop: '/k.mp3' });
  assert.deepEqual(trackOf(MANIFEST, 'fearless'), { intro: '/fi.mp3', loop: '/f.mp3' });
  assert.equal(trackOf(MANIFEST, 'nope'), null);
  assert.equal(trackOf({ audio: { bgm: { prep: { intro: '/i.mp3' } } } }, 'prep'), null, 'a track without a loop is none');
});

test('bgmOptions offers what this manifest has; 休整期 leaves its own official track out', () => {
  assert.deepEqual(bgmOptions('prep', MANIFEST), ['official', 'fearless', 'knight', 'unite', 'lobby', 'custom']);
  assert.deepEqual(bgmOptions('combat', MANIFEST), ['official', 'prep', 'fearless', 'knight', 'unite', 'lobby', 'custom']);
  assert.deepEqual(bgmOptions('prep', {}), ['official', 'custom'], 'a manifest without tracks still offers 官方 and 自选曲');
});

test('pickedBgm: 官方 is null, a track is its URLs, 自选曲 is the player file', () => {
  assert.equal(pickedBgm(MANIFEST, 'prep', { prep: 'official' }), null);
  assert.equal(pickedBgm(MANIFEST, 'unite', { prep: 'knight' }), null, 'a key no pick follows stays official');
  assert.deepEqual(pickedBgm(MANIFEST, 'combat:0', { combat: 'fearless' }), { intro: '/fi.mp3', loop: '/f.mp3', choice: 'fearless' });
  assert.equal(pickedBgm(MANIFEST, 'prep', { prep: 'nope' }), null, 'an unknown pick is 官方');
  assert.equal(pickedBgm({}, 'prep', { prep: 'prep' }), null, 'a track this manifest lacks is 官方');
});

test('pickedBgm: 自选曲 needs a file, and a failed pick falls back', () => {
  const own = { id: 'abc', read: async () => new ArrayBuffer(0) };
  assert.equal(pickedBgm(MANIFEST, 'prep', { prep: 'custom' }), null, 'no file, no track');
  assert.deepEqual(pickedBgm(MANIFEST, 'prep', { prep: 'custom' }, { local: { prep: own } }),
    { intro: null, loop: 'local-bgm:abc', choice: 'abc' });
  assert.deepEqual(pickedBgm(MANIFEST, 'prep', { prep: 'custom' }, { local: { prep: own }, localPrefix: 'x:' }),
    { intro: null, loop: 'x:abc', choice: 'abc' });
  assert.equal(pickedBgm(MANIFEST, 'prep', { prep: 'custom' }, { local: { prep: own }, failed: new Set(['local-bgm:abc']) }), null,
    'a file that failed this page plays the official track');
  assert.equal(pickedBgm(MANIFEST, 'combat', { combat: 'knight' }, { failed: new Set(['knight']) }), null,
    'a track that failed this page too');
});
