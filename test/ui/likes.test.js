// 点赞 on the settlement's 同盟 page, the page side (the owner's request of 2026-11-05; public/js/ui/likes.js,
// screens/settle.js TeamPage): room.likes folded into store.match.likes, the toast of a like I got, and what each card
// shows. The server is test/lobby-likes.test.js; the real browser flow, test/ui/likes.e2e.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyLikes, likerName, likedToast, cardLike } from '../../public/js/ui/likes.js';
import { emptyMatch } from '../../public/js/store.js';

const src = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

test('applyLikes: the counts of the frame; mine from a resync or from my own like', () => {
  const a = applyLikes(null, { t: 'room.likes', match: 1, counts: { b: 1 }, from: 'a', to: 'b' }, 'a');
  assert.deepEqual(a, { match: 1, counts: { b: 1 }, mine: ['b'] });
  const b = applyLikes(a, { t: 'room.likes', match: 1, counts: { b: 1, a: 1 }, from: 'b', to: 'a' }, 'a');
  assert.deepEqual(b, { match: 1, counts: { b: 1, a: 1 }, mine: ['b'] }, 'somebody else\'s like keeps mine');
  const c = applyLikes(b, { t: 'room.likes', match: 2, counts: { c: 1 }, from: 'b', to: 'c' }, 'a');
  assert.deepEqual(c, { match: 2, counts: { c: 1 }, mine: [] }, 'another match starts from none');
  const r = applyLikes(null, { t: 'room.likes', match: 4, counts: { a: 2, b: 1 }, mine: ['b', 7, ''] }, 'a');
  assert.deepEqual(r, { match: 4, counts: { a: 2, b: 1 }, mine: ['b'] }, 'the resync names mine');
  assert.deepEqual(applyLikes(null, { match: 1, counts: { a: 0, b: -1, c: 1.5, d: 'x', e: 3 } }, 'a').counts, { e: 3 });
  for (const bad of [null, {}, { match: 'x', counts: {} }, { match: 1 }, { match: 1, counts: [] }]) {
    assert.equal(applyLikes(a, bad, 'a'), a, JSON.stringify(bad));
  }
  assert.equal(emptyMatch().likes, null, 'a cleared match has none');
});

test('likerName / likedToast: the settlement\'s name, else the room\'s; only a like to me', () => {
  const state = {
    me: { playerId: 'me' },
    match: { result: { players: [{ playerId: 'a', name: '阿米娅' }] } },
    room: { seats: [{ playerId: 'b', name: 'Bob' }, null], spectators: [{ playerId: 's', name: '观战者' }] },
  };
  assert.equal(likerName(state, 'a'), '阿米娅');
  assert.equal(likerName(state, 'b'), 'Bob');
  assert.equal(likerName(state, 's'), '观战者');
  assert.equal(likerName(state, 'zzz'), '博士');
  assert.equal(likedToast(state, { match: 1, counts: {}, from: 'a', to: 'me' }), '阿米娅 赞了你');
  assert.equal(likedToast(state, { match: 1, counts: {}, from: 'a', to: 'b' }), null, 'somebody else');
  assert.equal(likedToast(state, { match: 1, counts: {}, from: 'me', to: 'me' }), null);
  assert.equal(likedToast(state, { match: 1, counts: {}, mine: [] }), null, 'a resync');
  assert.equal(likedToast({ me: { playerId: null } }, { from: 'a', to: null }), null);
});

test('cardLike: a button on another human player\'s card while I am one in the room; the count everywhere', () => {
  const me = { playerId: 'me', isBot: false, left: false };
  const likes = { match: 1, counts: { me: 2, b: 1 }, mine: ['b'] };
  const ctx = { me, inRoom: true, likes };
  assert.deepEqual(cardLike({ playerId: 'me' }, ctx), { count: 2, can: false, liked: false, self: true });
  assert.deepEqual(cardLike({ playerId: 'b' }, ctx), { count: 1, can: true, liked: true, self: false });
  assert.deepEqual(cardLike({ playerId: 'c' }, ctx), { count: 0, can: true, liked: false, self: false });
  assert.equal(cardLike({ playerId: 'ai_1', isBot: true }, ctx), null, 'no chip on an AI seat');
  assert.equal(cardLike({ playerId: 'c', left: true }, ctx).can, false, 'a player who left the match');
  assert.equal(cardLike({ playerId: 'c' }, { ...ctx, inRoom: false }).can, false, 'out of the room');
  assert.equal(cardLike({ playerId: 'c' }, { ...ctx, off: true }).can, false, 'the server took none');
  assert.equal(cardLike({ playerId: 'c' }, { ...ctx, me: null }).can, false, 'a spectator has no row');
  assert.equal(cardLike({ playerId: 'c' }, { ...ctx, me: { ...me, left: true } }).can, false);
  assert.equal(cardLike({ playerId: 'c' }, { ...ctx, extra: new Set(['c']) }).liked, true, 'ALREADY from the server');
  assert.deepEqual(cardLike({ playerId: 'c' }, { me, inRoom: true, likes: null }), { count: 0, can: true, liked: false, self: false });
});

test('wiring: main.js folds room.likes, settle.js sends room.like and shows the chip', () => {
  const main = src('public/js/main.js'), settle = src('public/js/screens/settle.js'), css = src('public/css/screens/settle.css');
  assert.match(main, /net\.on\('room\.likes'/);
  assert.match(main, /store\.patch\('match', \{ result: res, likes: null \}\)/, 'a new settlement starts without likes');
  assert.match(settle, /net\.request\('room\.like', \{ playerId: pid \}\)/);
  assert.match(settle, /cardLike\(p, likeCtx\)/);
  assert.match(css, /\.tchip--like\.is-liked/);
});
