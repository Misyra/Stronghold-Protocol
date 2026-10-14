// Browser check of the temporary shop fold while deploying (GitHub #602), on the in-match mock harness:
//   SP_E2E=1 CHROME_PATH=… node --test test/ui/issue602-deploy-fold.e2e.test.js
//
// On the own prep board (DOM fallback field), picking up a hand piece — an operator or equipment — folds the shop bar
// (the 展开商店 tab, the screen's `is-collapsed`) and keeps it folded through the dropped operator's direction wheel;
// cancelling the drag / the wheel, or equipping, gives the player's own 收起/展开 state back — it is never written by
// the drag. The zoomed camera itself is covered by issue602-deploy-fold.test.js's projection measurement.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('the shop folds while deploying a piece and restores afterwards (#602)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv;
  let browser;
  let base;
  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--no-proxy-server'] });
  });
  after(async () => {
    await browser?.close();
    await srv?.close();
  });

  /** Open the mock PREP match with a free deploy slot (one board operator sold, like facing.e2e.test.js). */
  async function openPage(viewport) {
    const page = await browser.newPage();
    if (viewport) await page.setViewport(viewport);
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.goto(`${base}/dev/game-mock.html?shot=1&render=fallback&phase=PREP`, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForSelector('.ff-piece');
    const initial = await page.evaluate(() => JSON.parse(JSON.stringify(globalThis.__MOCK__.S().priv)));
    const sell = initial.board.find((p) => p.kind === 'chess' && !p.golden);
    await page.click(`.ff-piece[data-uid="${sell.uid}"]`);
    await page.waitForSelector('.uframe__btn--sell');
    await page.click('.uframe__btn--sell');
    await page.waitForFunction((uid) => !globalThis.__MOCK__.S().priv.board.some((p) => p.uid === uid), {}, sell.uid);
    const ready = await page.evaluate(() => JSON.parse(JSON.stringify(globalThis.__MOCK__.S().priv)));
    const chess = ready.hand.find((p) => p?.kind === 'chess');
    const item = ready.hand.find((p) => p?.kind === 'item');
    const tile = [[9, 9], [9, 8], [12, 6], [11, 7], [10, 7], [9, 7]].find(([r, c]) => !ready.board.some((p) => p.row === r && p.col === c));
    assert.ok(chess && item && tile, 'a hand operator, a hand item and a free tile exist');
    const center = async (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    const folded = () => page.evaluate(() => ({
      cls: document.querySelector('.gm')?.classList.contains('is-collapsed') ?? null,
      tab: !!document.querySelector('.shopbar-tab'),
    }));
    /** Press the piece and nudge it: the drag starts (facing.e2e.test.js uses the same gesture). */
    const pickup = async (piece) => {
      const from = await center(`.ff-piece[data-uid="${piece.uid}"]`);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 20, from.y, { steps: 4 });
      await sleep(120);
    };
    const cancelDrag = async () => { await page.mouse.up(); await sleep(200); };
    const dropOn = async (row, col) => {
      const to = await center(`.ff-tile[data-row="${row}"][data-col="${col}"]`);
      await page.mouse.move(to.x, to.y, { steps: 12 });
      await sleep(80);
      await page.mouse.up();
    };
    return { page, problems, chess, item, tile, folded, pickup, cancelDrag, dropOn };
  }

  test('picking up an operator folds the shop; cancelling the drag restores it (phone viewport)', async () => {
    const h = await openPage({ width: 390, height: 844 });
    assert.deepEqual(await h.folded(), { cls: false, tab: false }, 'the shop starts open');

    await h.pickup(h.chess);
    assert.deepEqual(await h.folded(), { cls: true, tab: true }, 'the shop folds as the operator is picked up');
    await h.cancelDrag();
    assert.deepEqual(await h.folded(), { cls: false, tab: false }, 'a cancelled drag opens it again');

    // the player folds by hand: the deploy fold must not undo it
    await h.page.click('.funds__collapse');
    await h.page.waitForSelector('.shopbar-tab');
    await h.pickup(h.chess);
    assert.equal((await h.folded()).cls, true, 'folded by hand, then picked up: still folded');
    await h.cancelDrag();
    assert.deepEqual(await h.folded(), { cls: true, tab: true }, 'the hand-made fold survives the cancelled drag');
    await h.page.click('.shopbar-tab__btn');
    await sleep(200);

    assert.deepEqual(h.problems, []);
    await h.page.close();
  });

  test('it stays folded through the direction wheel and unfolds when the wheel is cancelled', async () => {
    const h = await openPage({ width: 1600, height: 900 });
    await h.pickup(h.chess);
    assert.equal((await h.folded()).cls, true, 'folded on pickup');
    await h.dropOn(...h.tile);
    await h.page.waitForSelector('.fwheel__dia', { timeout: 5000 });
    await sleep(200);
    assert.deepEqual(await h.folded(), { cls: true, tab: true }, 'the direction wheel keeps the shop folded');
    await h.page.keyboard.press('Escape');
    await h.page.waitForFunction(() => !document.querySelector('.fwheel'));
    await sleep(200);
    assert.deepEqual(await h.folded(), { cls: false, tab: false }, 'cancelling the wheel restores the open shop');
    assert.deepEqual(h.problems, []);
    await h.page.close();
  });

  test('picking up equipment folds the shop too, and dropping it restores the player\'s state', async () => {
    const h = await openPage({ width: 1600, height: 900 });
    await h.pickup(h.item);
    assert.deepEqual(await h.folded(), { cls: true, tab: true }, 'equipment pickup folds the shop (no direction wheel for items)');
    await h.cancelDrag();
    assert.deepEqual(await h.folded(), { cls: false, tab: false }, 'released without equipping: open again');
    assert.deepEqual(h.problems, []);
    await h.page.close();
  });
});
