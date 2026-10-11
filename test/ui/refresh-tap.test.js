// test/ui/refresh-tap.test.js — GitHub #501 (single-ptilopsis): 高延迟下连按「刷新」会重复扣费. The intent layer now
// single-flights it (ui/gameActions.js): a tap while the previous g.refresh is still on the wire is dropped — the
// button dims through onRefreshBusy (game.js → ui/shopBar.js) and the R hotkey (the same actions.refresh) stays inert
// until the reply lands. The browser run of the same case is test/ui/refresh-tap.e2e.test.js (SP_E2E=1).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

const { net } = await import('../../public/js/net.js');
const { actions, onRefreshBusy } = await import('../../public/js/ui/gameActions.js');

describe('the shop refresh single-flights (GitHub #501)', () => {
  test('a refresh while the previous one is on the wire sends nothing; the busy signal brackets the request; a later one sends again', async () => {
    const sent = [];
    let release;
    const prev = net.request;
    net.request = (t) => { sent.push(t); return new Promise((r) => { release = () => r({ ok: true }); }); };
    const seen = [];
    const off = onRefreshBusy((b) => seen.push(b));
    try {
      assert.deepEqual(seen, [false], 'subscribing fires once with the current (idle) state');
      const first = actions.refresh();
      assert.equal(sent.length, 1);
      assert.equal(seen.at(-1), true, 'busy from the moment of the send');
      assert.equal(await actions.refresh(), false, 'the duplicate resolves false without waiting');
      assert.equal(sent.length, 1, 'and never reaches the socket');
      release();
      assert.equal(await first, true);
      assert.deepEqual(seen, [false, true, false], 'the reply clears the busy state');
      const again = actions.refresh();
      assert.equal(sent.length, 2, 'a refresh after the reply is sent again');
      release();
      assert.equal(await again, true);
      assert.deepEqual(seen, [false, true, false, true, false]);
    } finally {
      off();
      net.request = prev;
    }
  });

  test('an unsubscribe stops the updates', () => {
    const seen = [];
    const off = onRefreshBusy((b) => seen.push(b));
    off();
    assert.deepEqual(seen, [false]);
  });

  test('the wiring: game.js subscribes and hands the state to the bar; the button dims and says what it waits for', () => {
    const game = read('public/js/screens/game.js');
    assert.match(game, /onRefreshBusy\(setRefreshBusy\)/, 'the game screen subscribes');
    assert.match(game, /<\$\{ShopBar\}[\s\S]*?refreshBusy=\$\{refreshBusy\}/, 'and the bar receives it');
    const bar = read('public/js/ui/shopBar.js');
    assert.match(bar, /disabled=\$\{!!refReason \|\| refreshBusy\}/, 'busy disables the 刷新 button');
    assert.match(bar, /t\('正在刷新…'\)/, 'and its tooltip says what it is waiting for');
  });
});
