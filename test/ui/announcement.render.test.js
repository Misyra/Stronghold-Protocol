// Offline rendering of the announcement banner. AnnouncementBanner is really rendered — vendored Preact diffing into
// the hand-rolled DOM stub below (same fake style as test/ui/devices.test.js, no new dependencies) — so the
// assertions see the rendered tree, not the source text. What these tests cannot see is CSS layout: strip overflow
// scrolling, the compact row height and visual truncation stay with the browser coverage in
// test/ui/announcement.e2e.test.js (SP_E2E=1, real Chrome).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { render, options } from '../../public/vendor/preact.module.js';
import { html } from '../../public/js/ui/components.js';
import { AnnouncementBanner, AnnouncementButton, AnnouncementCard } from '../../public/js/ui/announcement.js';
import { ANNOUNCEMENT_CACHE_MS } from '../../public/js/ui/announcementClient.js';
import { t } from '../../shared/i18n.js';

// preact/hooks flushes useEffect after "paint"; Node has no requestAnimationFrame, so the fallback is a 35 ms
// timer. The hooks module honours options.requestAnimationFrame — a fast one keeps the tests quick.
options.requestAnimationFrame = (fn) => setTimeout(fn, 0);

function relink(el) { for (let i = 0; i < el.children.length; i++) el.children[i].nextSibling = el.children[i + 1] ?? null; }

function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), children: [], attrs: new Map(), _listeners: {},
    className: '', data: '', parentNode: null, nextSibling: null,
    // Real elements own the lowercase handler IDL props; preact only lowercases the event name when the
    // lowercased prop is `in dom` (diff/props.js), so the stub needs them or onClick arrives as 'Click'.
    onclick: null, ondblclick: null, onkeydown: null, onkeyup: null, onmousedown: null, onmouseup: null,
    onmousemove: null, onpointerdown: null, onpointerup: null, onpointermove: null, onfocus: null,
    onblur: null, oninput: null, onchange: null, onsubmit: null, onwheel: null, ontouchstart: null,
    style: { cssText: '', setProperty() {}, removeProperty() {} },
    appendChild(c) { c.parentNode = el; el.children.push(c); relink(el); return c; },
    insertBefore(c, ref) {
      const i = el.children.indexOf(ref);
      if (i < 0) return el.appendChild(c);
      el.children.splice(i, 0, c); c.parentNode = el; relink(el); return c;
    },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); c.parentNode = null; relink(el); return c; },
    addEventListener(type, fn) { (el._listeners[type] ??= new Set()).add(fn); },
    removeEventListener(type, fn) { el._listeners[type]?.delete(fn); },
    setAttribute(k, v) { el.attrs.set(k, String(v)); if (k === 'class') el.className = String(v); },
    removeAttribute(k) { el.attrs.delete(k); if (k === 'class') el.className = ''; },
    getAttribute(k) { return el.attrs.get(k) ?? null; },
    focus() {}, querySelectorAll() { return []; }, querySelector() { return null; },
    matches() { return false; }, closest() { return null; }, contains() { return false; },
    getClientRects() { return [{}]; },
  };
  return el;
}

/**
 * Install the global DOM surface the banner touches (document for polling + Modal focus, window for the Modal's
 * key/focus handlers, ResizeObserver for the strip measurement) and return a restore() for the test's finally.
 */
function installDom() {
  const docListeners = new Map();
  const saved = ['document', 'window', 'ResizeObserver'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const body = makeElement('body');
  globalThis.document = {
    createElement: (tag) => makeElement(tag), createElementNS: (_ns, tag) => makeElement(tag),
    createTextNode: (text) => { const node = makeElement('#text'); node.data = text; return node; },
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener(type, fn) { (docListeners.get(type) ?? docListeners.set(type, new Set()).get(type)).add(fn); },
    removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
    fire(type) { for (const fn of [...(docListeners.get(type) || [])]) fn(); },
    activeElement: null, hidden: false, body,
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  // The announcement poll measures its cache window on `performance.now()`: the test owns that clock, so "a minute
  // later" is a call rather than a sleep.
  const perf = globalThis.performance, ownNow = Object.getOwnPropertyDescriptor(perf, 'now');
  let clock = 0;
  Object.defineProperty(perf, 'now', { configurable: true, value: () => clock });
  return {
    advance: (ms) => { clock += ms; },
    restore: () => {
      if (ownNow) Object.defineProperty(perf, 'now', ownNow); else delete perf.now;
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

/**
 * Render the banner (plus the settings-entry button) against a stubbed /api/announcement and return query helpers.
 * The poll publishes `announcementSnapshot(body)`, so an invalid/expired/withdrawn body arrives as null, exactly
 * like production.
 */
function mount(initialBody) {
  const { restore, advance } = installDom();
  const doc = globalThis.document;
  let response = initialBody;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, cache: init.cache });
    return { ok: true, json: async () => response };
  };
  const host = doc.body;
  render(html`<div><${AnnouncementBanner} /><${AnnouncementCard} /><${AnnouncementButton} class="gm__announcement" /></div>`, host);
  const flush = () => new Promise((resolve) => setTimeout(resolve, 8));
  const queryAll = (cls) => {
    const out = [];
    (function walk(el) { for (const child of el.children || []) { if (String(child.className).split(/\s+/).includes(cls)) out.push(child); walk(child); } })(host);
    return out;
  };
  const textOf = (el) => {
    let text = '';
    (function walk(node) { for (const child of node.children || []) { if (/^#text$/i.test(child.tagName)) text += child.data; else walk(child); } })(el);
    return text;
  };
  const click = (el) => {
    const hits = Object.entries(el?._listeners || {}).filter(([key]) => key.toLowerCase() === 'click');
    for (const [, set] of hits) for (const fn of [...set]) {
      fn.call(el, { type: 'click', target: el, currentTarget: el, stopPropagation() {}, preventDefault() {} });
    }
  };
  return {
    doc, calls, flush, queryAll, textOf, click, restore, advance,
    openDetail: async (cls) => { click(queryAll(cls)[0]); await flush(); },
    /** A tab that came back well after the poll's cache window: the next check has to ask the server. */
    resumeAfterWindow() { advance(ANNOUNCEMENT_CACHE_MS + 1); doc.fire('visibilitychange'); },
    setResponse(value) { response = value; },
    unmount() { render(null, host); },
  };
}

const notice = { id: 'r1', title: '维护公告', text: '第一行正文\n第二行正文', expiresAt: Date.now() + 60_000 };
const activeBody = { serverTime: Date.now(), announcement: notice };

/** Unmount (stops the poll's interval) and put the globals back, even when an assertion threw. */
async function withBanner(initialBody, run) {
  const ui = mount(initialBody);
  try { await run(ui); }
  finally {
    // The open/closed state of the detail lives in a module-level store: close it the way the UI does,
    // so one test's open detail cannot leak into the next render.
    const close = ui.queryAll('utility-modal__close')[0];
    if (close) { ui.click(close); await ui.flush(); }
    ui.unmount();
    ui.restore();
  }
}

describe('AnnouncementBanner rendering (offline, real Preact into a DOM stub)', () => {
  test('the lobby card shares one poll, opens full text and survives strip dismissal until withdrawal', async () => {
    await withBanner(activeBody, async (ui) => {
      await ui.flush();
      assert.equal(ui.calls.length, 1, 'the card does not start a second polling loop');
      assert.equal(ui.textOf(ui.queryAll('hub-notice__title')[0]), notice.title);
      assert.equal(ui.textOf(ui.queryAll('hub-notice__text')[0]), notice.text);
      const strip = ui.queryAll('announcement')[0];
      ui.click(strip.children.find((el) => String(el.className).split(/\s+/).includes('btn')));
      await ui.flush();
      assert.equal(ui.queryAll('announcement').length, 0);
      assert.equal(ui.textOf(ui.queryAll('hub-notice__text')[0]), notice.text);
      await ui.openDetail('hub-notice');
      assert.equal(ui.textOf(ui.queryAll('announcement-detail__text')[0]), notice.text);
      ui.setResponse({ announcement: null });
      ui.resumeAfterWindow();
      await ui.flush();
      assert.equal(ui.queryAll('hub-notice__title').length, 0);
      assert.equal(ui.textOf(ui.queryAll('hub-notice__text')[0]), t('当前暂无公告'));
    });
  });

  test('an active notice renders the body text once; the detail shows text without a repeated title', async () => {
    await withBanner(activeBody, async (ui) => {
      await ui.flush();
      assert.equal(ui.queryAll('announcement__text').length, 1, 'the strip shows the text once');
      assert.equal(ui.queryAll('announcement__title').length, 0, 'the strip has no title element');
      assert.equal(ui.textOf(ui.queryAll('announcement__text')[0]), notice.text);
      assert.equal(ui.queryAll('modal__box').length, 0, 'the detail starts closed');

      await ui.openDetail('announcement__content');
      const box = ui.queryAll('modal__box')[0];
      assert.ok(box, 'the strip content opens the shared detail');
      const detailText = ui.queryAll('announcement-detail__text')[0];
      assert.ok(detailText, 'the detail body is the text paragraph');
      assert.equal(ui.textOf(detailText), notice.text, 'multi-line text is complete, not truncated');
      assert.equal(ui.queryAll('announcement-detail__title').length, 0, 'no announcement-detail__title element (the removed duplicate heading)');
      assert.equal(ui.textOf(box).includes(notice.title), false, 'the notice title appears nowhere in the detail');
      assert.ok(ui.textOf(box).includes(t('服务器公告')), 'the modal header keeps its own title');
    });
  });

  test('a withdrawal updates the open detail to the empty state and removes the strip', async () => {
    await withBanner(activeBody, async (ui) => {
      await ui.flush();
      await ui.openDetail('announcement__content');
      assert.ok(ui.queryAll('modal__box')[0], 'detail open before the withdrawal');

      ui.setResponse({ announcement: null });
      ui.resumeAfterWindow();           // the poll re-checks once the tab has been away past the cache window
      await ui.flush();
      assert.equal(ui.queryAll('announcement__text').length, 0, 'the withdrawn notice leaves the strip');
      const box = ui.queryAll('modal__box')[0];
      assert.ok(box, 'the detail stays open for the player');
      const empty = ui.textOf(box).includes(t('当前暂无公告'));
      assert.ok(empty, 'the detail shows the empty state');
      assert.equal(ui.textOf(box).includes(notice.text), false, 'no withdrawn text remains');
      assert.equal(ui.queryAll('announcement-detail__text').length, 0, 'the empty state is not the text paragraph');
    });
  });

  test('an expired notice never activates and the manually opened detail shows the empty state', async () => {
    await withBanner({ serverTime: Date.now(), announcement: { ...notice, expiresAt: Date.now() - 1000 } }, async (ui) => {
      await ui.flush();
      assert.equal(ui.queryAll('announcement__text').length, 0, 'no strip for an expired notice');
      assert.equal(ui.queryAll('modal__box').length, 0);

      await ui.openDetail('gm__announcement'); // the settings entry works without an active strip
      const box = ui.queryAll('modal__box')[0];
      assert.ok(box, 'the settings entry opens the detail');
      assert.ok(ui.textOf(box).includes(t('当前暂无公告')), 'the empty state');
      assert.equal(ui.textOf(box).includes(notice.text), false, 'expired text is not rendered');
    });
  });

  test('the detail close button closes only the detail and the entry can reopen it', async () => {
    await withBanner(activeBody, async (ui) => {
      await ui.flush();
      await ui.openDetail('announcement__content');
      assert.ok(ui.queryAll('modal__box')[0]);

      ui.click(ui.queryAll('utility-modal__close')[0]);
      await ui.flush();
      assert.equal(ui.queryAll('modal__box').length, 0, 'the close button closes the detail');
      assert.equal(ui.queryAll('announcement__text').length, 1, 'closing the detail does not dismiss the strip');

      await ui.openDetail('gm__announcement');
      assert.ok(ui.queryAll('modal__box')[0], 'the detail can be reopened');
    });
  });

  test('long multi-line text stays complete in the rendered detail text node', async () => {
    const long = { ...notice, text: '很长的公告内容。'.repeat(300) + '\n最后一行结尾' };
    await withBanner({ serverTime: Date.now(), announcement: long }, async (ui) => {
      await ui.flush();
      await ui.openDetail('announcement__content');
      const detailText = ui.queryAll('announcement-detail__text')[0];
      assert.ok(detailText, 'the long notice still renders the text paragraph');
      assert.equal(ui.textOf(detailText), long.text, 'every byte survives rendering (content, not CSS)');
      assert.equal(ui.textOf(detailText).includes('\n最后一行结尾'), true);
    });
  });
});
