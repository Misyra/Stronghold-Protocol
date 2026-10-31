// Unit tests (Node) for the local account (本机账号, public/js/ui/accounts.js, ported from the user's fork):
//   the profile is one per browser under `sp.pref.localAccount` (a 4-digit #tag minted once and kept),
//   the name follows the game's player name (store.me) with 博士 as the fallback,
//   only this browser's own player has an account (accountOf: teammates and bots get none, so no #tag),
//   a corrupt stored profile is ignored (a fresh tag is minted), and onAccountChange unsubscribes.
// localStorage is faked per test (Node has none). The module memoises the profile in its closure and
// invalidates it through the browser's storage event only, so each test imports a fresh copy of it
// (a query-string cache buster) instead of sharing one.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { store } from '../../public/js/store.js';

const KEY = 'sp.pref.localAccount';
const SRC = pathToFileURL(fileURLToPath(new URL('../../public/js/ui/accounts.js', import.meta.url))).href;
let fresh = 0;

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}
/** A fresh module + clean storage + a reset store: the module reads the profile once per instance. */
async function withStorage(fn) {
  const ls = fakeStorage();
  globalThis.localStorage = ls;
  store.reset();
  const mod = await import(`${SRC}?test=${++fresh}`);
  try { return await fn(mod, ls); } finally { delete globalThis.localStorage; store.reset(); }
}

describe('local account', () => {
  test('a tag is minted once (4 digits) and kept in localStorage; the id carries it', async () => {
    await withStorage(async ({ currentAccount }, ls) => {
      const a = currentAccount();
      assert.match(a.tag, /^\d{4}$/);
      assert.equal(a.id, `local-${a.tag}`);
      assert.equal(a.local, true);
      assert.equal(a.card, null);
      assert.equal(JSON.parse(ls.map.get(KEY)).tag, a.tag, 'the profile is written back');
      const b = currentAccount();
      assert.equal(b.tag, a.tag, 'the same tag next call');
    });
  });

  test('the name follows the game player name (store.me), else the stored one, else 博士', async () => {
    await withStorage(async ({ currentAccount }) => {
      assert.equal(currentAccount().name, '博士');
      store.set({ me: { playerId: 'p1', name: '凯尔希', token: 't' } });
      assert.equal(currentAccount().name, '凯尔希');
    });
    await withStorage(async ({ currentAccount }, ls) => {
      ls.map.set(KEY, JSON.stringify({ tag: '2345', name: '留存名' }));
      assert.equal(currentAccount().name, '留存名', 'no session name: the stored one');
    });
  });

  test('only this browser own player has an account (bots and teammates: null)', async () => {
    await withStorage(async ({ LOCAL_ACCOUNT: local, currentAccount, accountOf }) => {
      store.set({ me: { playerId: 'p1', name: '凯尔希', token: 't' } });
      assert.equal(accountOf('p1')?.tag, currentAccount().tag);
      assert.equal(accountOf('p2'), null, 'a teammate');
      assert.equal(accountOf(null), null);
      assert.equal(accountOf(''), null);
      assert.equal(local, true);
    });
  });

  test('a corrupt stored profile is ignored (a fresh tag is minted and written)', async () => {
    await withStorage(async ({ currentAccount }, ls) => {
      ls.map.set(KEY, '{not json');
      const a = currentAccount();
      assert.match(a.tag, /^\d{4}$/);
      assert.equal(JSON.parse(ls.map.get(KEY)).tag, a.tag);
    });
    await withStorage(async ({ currentAccount }, ls) => {
      ls.map.set(KEY, JSON.stringify({ tag: '12', avatar: 42 }));
      const a = currentAccount();
      assert.match(a.tag, /^\d{4}$/);
      assert.equal(a.avatar, null, 'a non-string avatar is dropped');
    });
  });

  test('onAccountChange unsubscribes; timeoutSignal aborts after its budget', async () => {
    await withStorage(async ({ onAccountChange, timeoutSignal }) => {
      let n = 0;
      const off = onAccountChange(() => n++);
      off();
      off();
      assert.equal(n, 0);
      const signal = timeoutSignal(10);
      assert.equal(signal.aborted, false);
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(signal.aborted, true);
    });
  });
});
