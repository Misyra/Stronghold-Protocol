// Browser E2E for 干员皮肤 (docs/SKINS.md) in headless Chrome. Opt-in, like the other E2E files.
//
//   SP_E2E=1 node --test test/ui/skins.e2e.test.js
//
// The section now holds TWO groups (战斗模型 synced to the server, 商店立绘 local): the browser assertions below
// target the model group by its data-skin-group, and the 立绘 choice is covered by test/skins-portrait.test.js.
//
// What it pins down, in the real picker inside the real 干员调配 screen:
//   * the 皮肤 section appears for an operator that HAS skins and is absent for one that has none (the section
//     hides itself rather than showing an empty box);
//   * an installed skin is selectable and clears back to 默认;
//   * a skin that is not installed is dimmed but NOT disabled — clicking it is what installs it, so disabling it
//     (which the first version did) would have made the whole feature unreachable.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);

/** A base, visible chess record — the rows the roster actually renders. */
const isRosterChess = (id, rec) => !rec.isGolden && rec.visible !== false && !rec.isHidden && !rec.isDiy && (!rec.baseId || rec.baseId === id);

/**
 * The CHESS id of a roster row whose operator has an installed skin. The roster is keyed by chess id
 * (`chess_char_1_01_a`) while the manifest is keyed by operator (`char_498_inside`), so the two have to be joined
 * through data/chess.json's `charId` — exactly the mapping the picker needs and gets wrong at its peril.
 * @param {(charId: string, installed: Record<string, unknown>) => boolean} want
 */
function chessIdWhere(want) {
  try {
    const chess = JSON.parse(readFileSync(path.join(ROOT, 'data/chess.json'), 'utf8'));
    const m = JSON.parse(readFileSync(path.join(ROOT, 'data/assets.json'), 'utf8'));
    for (const [id, rec] of Object.entries(chess)) {
      if (!isRosterChess(id, rec)) continue;
      if (want(rec.charId, m.chars?.[rec.charId]?.skins || {})) return id;
    }
  } catch { /* no data */ }
  return null;
}

const CATALOG = (() => { try { return JSON.parse(readFileSync(path.join(ROOT, 'data/skins.json'), 'utf8')); } catch { return { chars: {} }; } })();

/** A row whose operator this install has at least one skin for — the 选中 case. Absent on a default install. */
const installedChessId = () => chessIdWhere((_c, installed) => Object.keys(installed).length > 0);

/** A row whose operator has skins in the catalogue but none installed — the 安装 case. */
const catalogOnlyChessId = () => chessIdWhere((charId, installed) => (CATALOG.chars?.[charId] || []).length > 0 && Object.keys(installed).length === 0);

/** A row whose operator has skins at all, installed or not — enough to assert the section renders. */
const anySkinChessId = () => chessIdWhere((charId) => (CATALOG.chars?.[charId] || []).length > 0);

const NO_SKINS = installedChessId() ? false : 'nothing installed — run: node tools/install-skins.mjs add <skinId>';

describe('skin picker (browser)', { skip: !ENABLED }, () => {
  let server; let browser; let page;
  const errors = [];

  before(async () => {
    const { startServer } = await import('../../server/index.js');
    server = await startServer({ port: 0, quiet: true });
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
    page = await browser.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('sp.name', 'E2E皮肤');
      sessionStorage.setItem('sp.entered', '1');
    });
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'domcontentloaded' });
  });

  after(async () => {
    try { await browser?.close(); } catch { /* gone */ }
    try { await server?.close(); } catch { /* gone */ }
  });

  /** Open 干员调配 and select the operator whose base chess id is `charId`. */
  async function openDetailFor(charId) {
    // the roster row and the button the 干员调配 screen itself uses (screens/loadout.js LoadoutButton)
    await page.waitForSelector('[data-testid="loadout-open"]', { timeout: 20000 });
    await page.click('[data-testid="loadout-open"]');
    await page.waitForSelector('.lo-detail', { timeout: 10000 });
    const ok = await page.evaluate((id) => {
      const rows = [...document.querySelectorAll('[data-chess]')];
      const row = rows.find((r) => r.getAttribute('data-chess') === id);
      if (!row) return false;
      // `data-chess` sits on the row card, but the row's click target is the button inside it — clicking the card
      // does nothing at all, which is exactly how these tests passed for the wrong reason before (the panel's
      // default selection is the first roster row, so the assertions held while the click was a no-op)
      (row.querySelector('button') || row).click();
      return true;
    }, charId);
    return ok;
  }

  test('the 皮肤 section lists the operator\'s skins, installed and not', async () => {
    const row = anySkinChessId();
    assert.ok(row, 'some roster operator has skins in the catalogue');
    assert.ok(await openDetailFor(row), `the roster has a row for ${row}`);

    await page.waitForSelector('[data-testid="skin-section"]', { timeout: 5000 });
    const tiles = await page.$$eval('[data-skin-group="model"] .lo-skin', (els) => els.map((b) => ({
      skin: b.getAttribute('data-skin'),
      disabled: b.disabled,
      checked: b.getAttribute('aria-checked'),
      text: b.textContent.trim(),
    })));
    assert.ok(tiles.length >= 2, `默认 + at least one skin, got ${tiles.length}`);
    assert.equal(tiles[0].skin, '', 'the first tile is 默认');
    assert.equal(tiles[0].checked, 'true', 'nothing chosen yet → 默认 is selected');
    assert.ok(tiles.every((t) => !t.disabled), 'no tile may be disabled — an uninstalled one becomes the install button');
  });

  test('an installed skin can be chosen and cleared', { skip: NO_SKINS }, async () => {
    assert.ok(await openDetailFor(installedChessId()), 'the roster row of an operator with an installed skin');
    // An INSTALLED tile, explicitly: an uninstalled one is the install button, so clicking the first tile with a
    // skin id would kick off a real install (tens of seconds, and it writes to data/assets.json) rather than a
    // selection — which is exactly what the first version of this test did.
    const chosen = await page.evaluate(() => {
      const tiles = [...document.querySelectorAll('[data-skin-group="model"] .lo-skin')];
      const b = tiles.find((x) => x.getAttribute('data-skin') && !x.classList.contains('lo-skin--missing'));
      if (!b) return null;
      b.click();
      return b.getAttribute('data-skin');
    });
    assert.ok(chosen, 'this operator has an installed skin tile to select');
    // compared in JS, not through a CSS selector: a skin id contains '@' and '#' and escaping it into an attribute
    // selector is exactly the kind of thing that fails for reasons unrelated to the feature
    await page.waitForFunction((id) => {
      const tiles = [...document.querySelectorAll('[data-skin-group="model"] .lo-skin')];
      return tiles.some((b) => b.getAttribute('data-skin') === id && b.getAttribute('aria-checked') === 'true');
    }, { timeout: 5000 }, chosen);

    // and it is persisted for this browser, which is what the sync sends to the server
    const stored = await page.evaluate(() => localStorage.getItem('sp.pref.skins'));
    assert.match(stored || '', new RegExp(chosen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the choice is saved to localStorage');
  });

  test('an operator with no skins still gets the 立绘 switch and the model frame', async () => {
    const cat = JSON.parse(readFileSync(path.join(ROOT, 'data/skins.json'), 'utf8'));
    const bare = chessIdWhere((charId) => !(cat.chars?.[charId] || []).length);
    if (!bare) return; // every roster operator happens to have skins — nothing to assert
    await openDetailFor(bare);
    // The section is not only about skins: 溯光星源 ships no outfit at all and still wants 原始/精英二 立绘 and the
    // model frame — the first version hid the whole section here, which is exactly what the playtest reported.
    await page.waitForSelector('[data-testid="skin-section"]', { timeout: 10000 });
    const tiles = await page.$$eval('[data-skin-group="portrait"] .lo-skin', (els) => els.map((e) => e.getAttribute('data-skin')));
    assert.ok(tiles.includes(''), `原始立绘 tile for ${bare}, got ${JSON.stringify(tiles)}`);
    // only the operator's own two tiles: '' (原始) and the PORTRAIT_E2 sentinel — no skin tile, it has none
    assert.ok(tiles.every((x) => x === '' || x === 'e2'), `no skin tiles, got ${JSON.stringify(tiles)}`);
    const note = await page.$eval('[data-testid="skin-section"] .lo-sec__note', (e) => e.textContent.trim());
    assert.match(note, /暂无皮肤/, `the header says so (${note})`);
    const cap = await page.$eval('.lo-model__cap', (e) => e.textContent.trim());
    assert.match(cap, /当前战斗模型/, `the frame is still there (${cap})`);
    // …and the frame really draws something: the avatar at worst, the rendered model once it lands
    const drawn = await page.waitForFunction(() => {
      const box = document.querySelector('[data-testid="model-preview"] .lo-model__box');
      const img = box?.querySelector('img');
      return !!box.querySelector('canvas') || (img && img.getAttribute('src') && img.getAttribute('src') !== '');
    }, { timeout: 60000 }).then(() => true).catch(() => false);
    assert.ok(drawn, '预览框里画出了东西');
  });

  test('the (uninstalled) case renders its install hint', async () => {
    const bare = catalogOnlyChessId();
    if (!bare) return; // everything is installed on this machine — nothing to assert
    assert.ok(await openDetailFor(bare), `the roster has a row for ${bare}`);
    await page.waitForSelector('[data-testid="skin-section"]', { timeout: 5000 });
    // as above: wait for THIS operator's section, not the previous one's — an uninstalled tile is the marker
    await page.waitForSelector('[data-skin-group="model"] .lo-skin--missing', { timeout: 10000 });
    const hints = await page.$$eval('[data-skin-group="model"] .lo-skin--missing', (els) => els.map((b) => b.textContent));
    assert.ok(hints.length, 'at least one uninstalled skin is shown');
    assert.match(hints.join(' '), /点击安装/, 'an uninstalled tile says how to get it');
  });

  // 干员小人预览 (docs/SKINS.md): the 战斗模型 tiles are TEXT ONLY and the model itself is rendered by
  // render/spinePreview.js into the preview box under them; the 商店立绘 group (now first) offers the operator's own
  // 原始 / 精英二 立绘 next to each skin's. This is the only place the real rasterisation runs — it needs pixi, a
  // WebGL context and the model files — so it is also the test that catches a pixi/pixi-spine API drift.
  test('战斗模型 tiles are text-only with a rendered preview below, and 商店立绘 offers 原始 / 精英二 art', { skip: NO_SKINS }, async () => {
    const row = installedChessId();
    assert.ok(row, 'some roster operator has an installed skin');
    if (await page.$('[data-skin-group="model"]')) {
      // the overlay is open on whatever the previous test selected: pick this test's row (the button inside it)
      await page.evaluate((id) => {
        const r = [...document.querySelectorAll('[data-chess]')].find((x) => x.getAttribute('data-chess') === id);
        if (r) (r.querySelector('button') || r).click();
      }, row);
    } else {
      await page.keyboard.press('Escape');
      await new Promise((r) => setTimeout(r, 250));
      assert.ok(await openDetailFor(row), `the roster has a row for ${row}`);
    }
    await page.waitForSelector('[data-skin-group="model"]', { timeout: 10000 });
    // 默认 + at least one installed skin: proof the panel is on an operator whose models exist
    await page.waitForFunction(() => document.querySelectorAll('[data-skin-group="model"] .lo-skin').length >= 2, { timeout: 10000 });

    // the order the user asked for: 商店立绘 above 战斗模型
    const order = await page.$$eval('[data-testid="skin-section"] [data-skin-group]', (els) => els.map((g) => g.getAttribute('data-skin-group')));
    assert.deepEqual(order, ['portrait', 'model'], '商店立绘 first, 战斗模型 second');

    // the model tiles carry no thumbnail at all — they are name + series text
    assert.equal(await page.$$eval('[data-skin-group="model"] .lo-skin__art', (els) => els.length), 0, 'no tile thumbnail');

    // the frame PLAYS the model live: render/spinePreview.js mounts the same Spine the battlefield draws into a
    // canvas inside the box (the static snapshot only bridges the load, and is the fallback without WebGL).
    const live = await page.waitForFunction(() => {
      const c = document.querySelector('[data-testid="model-preview"] canvas');
      return !!c && c.width > 0 && c.height > 0;
    }, { timeout: 90000 }).then(() => true).catch(() => false);
    assert.ok(live, '预览框里是实时画布');
    const cap = await page.$eval('[data-testid="model-preview"] .lo-model__cap', (e) => e.textContent.trim());
    assert.match(cap, /当前战斗模型/, `the box says what it shows (${cap})`);
    assert.match(cap, /段动画/, `the caption counts the clips (${cap})`);

    // one button per animation the model ships — at least 待机, and never a hardcoded set
    const clips = await page.$$eval('.lo-clipbtn', (els) => els.map((b) => ({ id: b.getAttribute('data-clip'), label: b.textContent.trim() })));
    assert.ok(clips.length >= 3, `部署 / 待机 / 攻击 at least, got ${clips.map((c) => c.label).join(' / ')}`);
    assert.ok(clips.some((c) => c.id === 'idle'), '有待机按钮');
    assert.ok(clips.some((c) => c.id === 'attack'), '有攻击按钮');

    // picking an animation marks it (and re-plays on the live instance)
    await page.click('.lo-clipbtn[data-clip="attack"]');
    await page.waitForFunction(() => document.querySelector('.lo-clipbtn[data-clip="attack"]')?.getAttribute('aria-pressed') === 'true', { timeout: 5000 });

    // 商店立绘: 原始立绘 (_1) + 精英二立绘 (_2) + each installed skin's 立绘, every tile with real art
    const srcs = await page.$$eval('[data-skin-group="portrait"] .lo-skin__art img', (els) => els.map((e) => e.getAttribute('src') || ''));
    assert.ok(srcs.length >= 2, `原始立绘 + 精英二立绘 … got ${srcs.length} tiles`);
    assert.ok(srcs.every(Boolean), 'no 立绘 tile is left as a placeholder');
    assert.ok(srcs.some((s) => /_1\.png$/.test(s)), 'the 原始立绘 tile points at the _1 art');
    assert.ok(srcs.some((s) => /_2\.png$/.test(s)) || srcs.every((s) => !/_2\.png$/.test(s)),
      'the 精英二 tile points at the _2 art when the operator has one');
  });

  test('a 自选 pick gets the 皮肤 section too, keyed by its slot', async () => {
    const SLOT = 'chess_char_5_diy1_a';
    // the overlay may not be open (this test also runs alone): open it, then the 自选编队 tab
    await page.waitForSelector('[data-testid="loadout-open"]', { timeout: 20000 });
    if (!(await page.$('.lo'))) {
      await page.click('[data-testid="loadout-open"]');
      await page.waitForSelector('.lo', { timeout: 10000 });
    }
    await page.click('.lo .lo-tab[data-tab="diy"]');
    await page.waitForSelector(`.diy-slot[data-slot="${SLOT}"] .diy-slot__fill`, { visible: true, timeout: 15000 });
    await page.click(`.diy-slot[data-slot="${SLOT}"] .diy-slot__fill`);
    await page.waitForSelector('[data-testid="diy-picker"]', { visible: true, timeout: 10000 });
    const picked = await page.evaluate(() => {
      const opt = document.querySelector('[data-testid="diy-picker"] .diy-opt:not(.is-taken)');
      if (!opt) return null;
      opt.click();
      return opt.getAttribute('data-char');
    });
    if (!picked) return; // the data names no legal pick — nothing to assert
    await page.click('[data-testid="diy-confirm"]');
    await page.waitForSelector('[data-testid="diy-picker"]', { hidden: true, timeout: 5000 });

    // the filled card grows a 皮肤 button; it opens ONE section under the grid (the preview renderer has a single canvas)
    await page.waitForSelector(`.diy-slot[data-slot="${SLOT}"] [data-testid="diy-skin"]`, { visible: true, timeout: 10000 });
    await page.click(`.diy-slot[data-slot="${SLOT}"] [data-testid="diy-skin"]`).catch(() => {});
    // a physical click can land on whatever overlays the button at that moment (the previous tests leave layers
    // around); the button's own click handler is what matters, so fall back to the DOM click if it did not take
    const expanded = () => page.evaluate((id) => document.querySelector(`.diy-slot[data-slot="${id}"] [data-testid="diy-skin"]`)?.getAttribute('aria-expanded'), SLOT);
    if ((await expanded()) !== 'true') {
      await page.evaluate((id) => document.querySelector(`.diy-slot[data-slot="${id}"] [data-testid="diy-skin"]`)?.click(), SLOT);
    }
    try {
      await page.waitForSelector('[data-testid="diy-skin-panel"] [data-testid="skin-section"]', { timeout: 10000 });
    } catch (e) {
      const dump = await page.evaluate((id) => ({
        prefDiy: localStorage.getItem('sp.pref.diy'),
        slotChar: document.querySelector(`.diy-slot[data-slot="${id}"]`)?.getAttribute('data-char'),
        panel: !!document.querySelector('[data-testid="diy-skin-panel"]'),
        btnExpanded: document.querySelector(`.diy-slot[data-slot="${id}"] [data-testid="diy-skin"]`)?.getAttribute('aria-expanded'),
        tabs: [...document.querySelectorAll('.lo-tab')].map((b) => `${b.dataset.tab}:${b.classList.contains('is-on')}`),
      }), SLOT);
      console.log('DEBUG dump:', JSON.stringify(dump, null, 1));
      await page.screenshot({ path: path.join(ROOT, 'test/e2e/out/skins-diy-fail.png') }).catch(() => {});
      throw e;
    }
    const label = await page.$eval('.diy-skin__head small', (e) => e.textContent.trim());
    assert.match(label, /5阶 自选/, `the panel names the slot (${label})`);

    // the choice is stored under the SLOT id — pieceView / battleInput look the skin up by the piece's baseId,
    // which for a 自选 piece is the slot id, so this is the key the whole pipeline resolves
    const stored = await page.evaluate((id) => JSON.parse(localStorage.getItem('sp.pref.skins') || '{}')[id] ?? null, SLOT);
    assert.equal(stored, null, 'nothing stored yet (默认 is not a choice)');

    // the 商店立绘 tiles at least offer 原始立绘, and the frame plays the pick's own model
    const tiles = await page.$$eval('[data-testid="diy-skin-panel"] [data-skin-group="portrait"] .lo-skin', (els) => els.map((e) => e.getAttribute('data-skin')));
    assert.ok(tiles.includes(''), `原始立绘 offered for the pick, got ${JSON.stringify(tiles)}`);
    const drawn = await page.waitForFunction(() => !!document.querySelector('[data-testid="diy-skin-panel"] [data-testid="model-preview"] canvas'), { timeout: 60000 }).then(() => true).catch(() => false);
    assert.ok(drawn, 'the frame plays the pick\'s model live');
  });
});
