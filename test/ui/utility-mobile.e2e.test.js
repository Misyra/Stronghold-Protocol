// Browser check of the management density layer (css/utility-mobile.css): a real Chrome at real phone
// viewports, measuring boxes, fonts and tap targets. Opt-in, needs Chrome, ~40 s:
//   SP_E2E=1 CHROME_PATH="…/Google Chrome" node --test test/ui/utility-mobile.e2e.test.js
//
// The page is served from the SOURCE client (clientBuild: false), so this test needs no build step; the
// bundled copy and its cascade order are covered by test/vite.test.js and test/ui/utility-mobile.test.js.
// What is checked: every management dialog fits the visible viewport, every control inside it is really
// tappable at its centre (a 44 px invisible hit area must not cover its neighbour), nothing falls below the
// 24 px WCAG minimum, text inputs keep the 16 px focus-zoom floor, the dialog body scrolls when the content
// is taller, the room's four tools stay on the title's row, and the portrait gate covers every screen.
//
// Real-device leftovers (still manual): virtual keyboards, real notches, momentum scrolling, iOS Safari.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'test/e2e/out');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);

/** A name the local lexicon accepts (the fork's moderation rejects 「测试」). */
const NAME = '阿米娅';

describe('management density on a real phone viewport', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv;
  let browser;
  let base;

  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    // clientBuild: false — test the source stylesheets, not a stale public/build bundle
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, clientBuild: false });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
    mkdirSync(OUT, { recursive: true });
  });

  after(async () => {
    await browser?.close();
    await srv?.close();
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** A phone-sized page watching for console / page errors, with an optional saved text size. */
  async function open(viewport, textSize = null) {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    if (textSize) {
      await page.evaluateOnNewDocument((size) => {
        localStorage.setItem('sp.pref.settings', JSON.stringify({ textSize: size }));
      }, textSize);
    }
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!textSize) {
      await page.evaluate(() => { try { localStorage.clear(); } catch { /* ignore */ } });
      await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    await page.waitForSelector('.title-screen input', { timeout: 20000 });
    // the touch fullscreen prompt sits over the title screen
    await page.evaluate(() => {
      [...document.querySelectorAll('.modal button')].find((b) => /暂不/.test(b.textContent))?.click();
    });
    await sleep(200);
    await page.type('.title-screen input', NAME);
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /^开始$/.test(b.textContent.trim()))?.click());
    await page.waitForSelector('.lobby-screen', { timeout: 20000 });
    await sleep(500);
    return { page, problems };
  }

  /** Every control of `root` whose centre is inside its own scroll port, measured. */
  const audit = (page, root) => page.evaluate((sel) => {
    const host = document.querySelector(sel);
    if (!host) return { missing: sel };
    const rect = (el) => el.getBoundingClientRect();
    const probe = document.createElement('span');
    probe.style.fontSize = 'var(--utility-text)';
    host.append(probe);
    const textBase = parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    const out = { textBase, box: null, viewport: [window.innerWidth, window.innerHeight], overflowX: host.scrollWidth - host.clientWidth, controls: [] };
    const hb = rect(host);
    out.box = [Math.round(hb.x), Math.round(hb.y), Math.round(hb.width), Math.round(hb.height)];
    for (const el of host.querySelectorAll('button, input, select, textarea')) {
      const b = rect(el);
      if (b.width < 1 || b.height < 1) continue;
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      const port = rect(el.closest('.modal__body') || host);
      if (cx < port.left || cx > port.right || cy < port.top || cy > port.bottom) continue; // scrolled out of its port
      if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) continue;
      const hit = document.elementFromPoint(cx, cy);
      out.controls.push({
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute('type') || '').toLowerCase(),
        cls: el.className.toString().slice(0, 48),
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 18),
        w: Math.round(b.width), h: Math.round(b.height),
        font: parseFloat(getComputedStyle(el).fontSize),
        hitsSelf: !!hit && (hit === el || el.contains(hit)),
      });
    }
    return out;
  }, root);

  /** The same, but after scrolling each painted control into its own port: covers the whole form.
   *  A collapsed <details> keeps stale rects in Chrome, so those are opened first and unpainted nodes skipped. */
  const auditAll = (page, root) => page.evaluate(async (sel) => {
    const host = document.querySelector(sel);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const d of host.querySelectorAll('details:not([open])')) d.open = true;
    await wait(120);
    const painted = (el) => el.getClientRects().length > 0 && (!el.checkVisibility || el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }));
    const bad = [];
    let count = 0;
    for (const el of host.querySelectorAll('button, input:not([type="range"]):not([type="checkbox"]):not([type="radio"]), select')) {
      if (!painted(el)) continue;
      const scroller = el.closest('.modal__body') || host;
      const before = el.getBoundingClientRect();
      const port = scroller.getBoundingClientRect();
      scroller.scrollTop += (before.y + before.height / 2) - (port.y + port.height / 2);
      await wait(60);
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) continue;
      count += 1;
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      if (!hit || !(hit === el || el.contains(hit))) {
        bad.push(`${el.className.toString().slice(0, 40)} ${Math.round(b.width)}x${Math.round(b.height)} at ${Math.round(b.x)},${Math.round(b.y)} → ${hit ? hit.className.toString().slice(0, 30) : 'nothing'}`);
      }
    }
    return { count, bad };
  }, root);

  /** Asserts the compact rules every management dialog must satisfy. */
  function expectDialogFits(a, label) {
    assert.equal(a.missing, undefined, `${label}: the dialog is on screen`);
    assert.ok(a.overflowX <= 1, `${label}: no horizontal overflow (${a.overflowX}px)`);
    const [x, y, w, h] = a.box;
    const [vw, vh] = a.viewport;
    assert.ok(x >= -1 && x + w <= vw + 1, `${label}: inside the viewport width (${a.box} of ${a.viewport})`);
    assert.ok(y >= -1 && y + h <= vh + 1, `${label}: inside the viewport height (${a.box} of ${a.viewport})`);
    assert.ok(a.controls.length >= 8, `${label}: controls measured (${a.controls.length})`);
    for (const c of a.controls) {
      assert.ok(c.hitsSelf, `${label}: a tap at the centre reaches it → ${JSON.stringify(c)}`);
      if (c.tag === 'button') assert.ok(c.h >= 24, `${label}: button at least 24 px high → ${JSON.stringify(c)}`);
      // Resource/settings/about deliberately follow --t, including the user's 小 setting (AGENTS.md).
      if (!['input', 'select', 'textarea'].includes(c.tag)) assert.ok(c.font >= Math.min(11, a.textBase * .1), `${label}: text follows the local scale → ${JSON.stringify(c)}`);
      if ((c.tag === 'input' && c.type !== 'range') || c.tag === 'select') {
        assert.ok(c.font >= 16, `${label}: input keeps the 16 px iOS focus-zoom floor → ${JSON.stringify(c)}`);
      }
    }
  }

  const PHONE = { width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true };
  const SMALL = { width: 568, height: 320, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true };

  for (const [label, viewport, textSize] of [
    ['844x390 landscape', PHONE, null],
    ['568x320 small landscape', SMALL, null],
    ['844x390 at 中', PHONE, 'md'],
    ['844x390 at 特大', PHONE, 'xl'],
  ]) {
    describe(label, () => {
      let page;
      let problems;
      before(async () => { ({ page, problems } = await open(viewport, textSize)); });
      after(async () => { await page.close(); });

      it('the settings dialog fits, scrolls when it must, and every control is really tappable', async () => {
        await page.click('.lobby-screen [data-testid="settings-btn"]');
        await page.waitForSelector('.modal .set-list', { timeout: 10000 });
        await sleep(300);
        expectDialogFits(await audit(page, '.utility-modal'), label);
        const deep = await auditAll(page, '.utility-modal');
        assert.ok(deep.count >= 25, `${label}: the whole form was probed (${deep.count})`);
        assert.deepEqual(deep.bad, [], `${label}: nothing is covered after scrolling it into view`);
        // the dialog body must be a real scroll container: the 快捷键 / 问题反馈 sections sit below the fold
        const scroll = await page.evaluate(async () => {
          const body = document.querySelector('.utility-modal .modal__body');
          body.scrollTop = 99999;
          await new Promise((r) => setTimeout(r, 60));
          const reached = body.scrollTop;
          body.scrollTop = 0;
          return { scrollHeight: body.scrollHeight, clientHeight: body.clientHeight, reached };
        });
        assert.ok(scroll.scrollHeight > scroll.clientHeight, `${label}: content is taller than the port`);
        assert.ok(scroll.reached > 0, `${label}: the body scrolls`);
        // and the height budget must come from the visible viewport, not a fixed number
        const budgets = await page.evaluate(() => {
          const box = document.querySelector('.utility-modal');
          const cfg = getComputedStyle(box);
          const probe = document.createElement('span');
          probe.style.fontSize = 'calc(.16 * var(--t))'; box.append(probe);
          const expectedFont = parseFloat(getComputedStyle(probe).fontSize); probe.remove();
          return { maxHeight: cfg.maxHeight, font: parseFloat(cfg.fontSize), expectedFont };
        });
        assert.ok(Math.abs(budgets.font - budgets.expectedFont) < .1, `${label}: the dialog body follows the selected text scale (${budgets.font})`);
        assert.match(budgets.maxHeight, /px$/, `${label}: a definite height budget (${budgets.maxHeight})`);
        assert.deepEqual(problems, [], `${label}: no console or page errors`);
        await page.screenshot({ path: path.join(OUT, `utility-mobile-${label.replace(/[^\w]+/g, '-')}.png`) });
      });
    });
  }

  describe('844x390 landscape chrome', () => {
    let page;
    let problems;
    before(async () => { ({ page, problems } = await open(PHONE)); });
    after(async () => { await page.close(); });

    it('the lobby and the local statistics screen stay inside the viewport', async () => {
      const lobby = await audit(page, '.lobby-screen');
      assert.equal(lobby.missing, undefined, 'the lobby is on screen');
      assert.ok(lobby.overflowX <= 1, `the lobby does not scroll sideways (${lobby.overflowX}px)`);
      await page.click('.lobby-screen .stats-entry');
      await page.waitForSelector('.st .st-tab', { timeout: 10000 });
      await sleep(400);
      const stats = await page.evaluate(() => {
        const host = document.querySelector('.st');
        const r = host.getBoundingClientRect();
        return { box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          overflowX: host.scrollWidth - host.clientWidth, viewport: [window.innerWidth, window.innerHeight] };
      });
      assert.ok(stats.overflowX <= 1, `statistics do not scroll sideways (${stats.overflowX}px)`);
      assert.ok(stats.box[1] + stats.box[3] <= stats.viewport[1] + 1, `statistics inside the viewport (${stats.box})`);
      await page.screenshot({ path: path.join(OUT, 'utility-mobile-stats.png') });
      await page.evaluate(() => document.querySelector('.st-back')?.click());
      await sleep(400);
      assert.deepEqual(problems, []);
    });

    it('a co-op room keeps the title, the four tools and the invitation on one row, all tappable', async () => {
      await page.evaluate(() => [...document.querySelectorAll('.lobby-screen button')].find((b) => /创建/.test(b.textContent))?.click());
      await page.waitForSelector('.room-screen', { timeout: 20000 });
      await sleep(700);
      const room = await page.evaluate(() => {
        const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
        const tools = [...document.querySelectorAll('.room-screen .room-tools')].map((el) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return { w: Math.round(r.width), h: Math.round(r.height), label: el.getAttribute('aria-label'), hit: !!hit && (hit === el || el.contains(hit)) };
        });
        return { tools, title: box('.room-screen .topbar__title'), left: box('.room-screen .topbar__left'), invite: box('.invite'),
          bar: box('.room-screen .topbar'), scrollX: document.documentElement.scrollWidth - window.innerWidth };
      });
      assert.equal(room.tools.length, 4, 'four room tools (统计 / 设置 / 公告 / 玩法说明)');
      for (const t of room.tools) {
        assert.ok(t.w <= 32 && t.h <= 32 && t.h >= 24, `a compact square tool, not a hidden-label button: ${JSON.stringify(t)}`);
        assert.ok(t.hit, `the tool is tappable at its centre: ${JSON.stringify(t)}`);
        assert.ok(t.label, `the tool keeps its accessible name: ${JSON.stringify(t)}`);
      }
      // one row: every centre sits within the tallest of the three boxes
      const heights = [room.title, room.left, room.invite].map((b) => b[3]);
      const centres = [room.title, room.left, room.invite].map((b) => b[1] + b[3] / 2);
      assert.ok(Math.max(...centres) - Math.min(...centres) <= Math.max(...heights) + 6,
        `the title, the controls and the invitation share a row: ${JSON.stringify({ title: room.title, left: room.left, invite: room.invite })}`);
      assert.ok(room.scrollX <= 1, `the room does not overflow the page (${room.scrollX}px)`);
      await page.screenshot({ path: path.join(OUT, 'utility-mobile-room.png') });
    });
  });

  describe('portrait', () => {
    it('the mandatory rotate hint covers every management surface and hides the fullscreen entry where unsupported', async () => {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: false });
      await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(800);
      assert.equal(await page.$eval('.rotate-hint', (el) => getComputedStyle(el).display), 'grid', 'portrait shows the hint');
      for (const cls of ['sp-in-match', 'sp-loadout-open', 'sp-stats-open']) {
        await page.evaluate((n) => document.documentElement.classList.add(n), cls);
        assert.equal(await page.$eval('.rotate-hint', (el) => getComputedStyle(el).display), 'grid', `${cls} cannot bypass the gate`);
        await page.evaluate((n) => document.documentElement.classList.remove(n), cls);
      }
      // the hint's 点击进入横屏 button only exists where the browser has element fullscreen
      const hint = await page.evaluate(() => {
        const btn = document.getElementById('rotate-hint-fullscreen');
        return btn ? { text: btn.textContent, supported: document.documentElement.classList.contains('sp-fs'), hidden: btn.hidden } : null;
      });
      if (hint) {
        assert.equal(hint.hidden, !hint.supported, 'the fullscreen entry follows the feature detection');
        if (!hint.hidden) assert.ok(hint.text.length > 0, 'it carries a label');
      }
      await page.screenshot({ path: path.join(OUT, 'utility-mobile-portrait.png') });
      await page.close();
    });
  });
});
