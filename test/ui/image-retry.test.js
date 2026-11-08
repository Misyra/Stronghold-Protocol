// The picture-retry hook (public/js/ui/materialImage.js, feedback #44): a failed <img> shows its fallback, rests and is
// asked for again — 10 s, 30 s, 2 min, three tries per URL per page life — then gives up. The hook is rendered for real
// (vendored Preact into the hand-rolled DOM stub, test/ui/announcement.render.test.js's); the rests are read off a fake
// setTimeout, no real waiting. What this cannot see is the browser's re-request itself: the e2e side stays with the
// fork's browser check (SP_E2E=1, not ported).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { h, render, options } from '../../public/vendor/preact.module.js';
import { useImageFailure, IMAGE_RETRY_MS } from '../../public/js/ui/materialImage.js';

// preact/hooks flushes useEffect after "paint"; Node has no requestAnimationFrame, so the fallback is a 35 ms timer.
// The hooks module honours options.requestAnimationFrame — a fast one keeps the tests quick.
options.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const realSetTimeout = globalThis.setTimeout;
const timers = [];
globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms: ms || 0 }); return timers.length; };

test.after(() => { globalThis.setTimeout = realSetTimeout; });

/** The stub DOM surface preact's diff touches (announcement.render.test.js's, trimmed to what the hook's probe needs). */
function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), children: [], attrs: new Map(), _listeners: {},
    className: '', data: '', parentNode: null, nextSibling: null,
    // Real elements own the lowercase handler IDL props; preact only lowercases the event name when the lowercased
    // prop is `in dom` (diff/props.js), so onError arrives as 'error' and not as 'Error'.
    onerror: null, onclick: null,
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
  };
  return el;
}
function relink(el) { for (let i = 0; i < el.children.length; i++) el.children[i].nextSibling = el.children[i + 1] ?? null; }

const docListeners = new Map();
globalThis.document = {
  createElement: (tag) => makeElement(tag), createElementNS: (_ns, tag) => makeElement(tag),
  createTextNode: (text) => { const node = makeElement('#text'); node.data = text; return node; },
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener(type, fn) { (docListeners.get(type) ?? docListeners.set(type, new Set()).get(type)).add(fn); },
  removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
  body: makeElement('body'),
};

/** A component pairing the hook with the <img> a caller draws: the icon, else the letter-on-a-disc fallback. */
function Probe({ src }) {
  const [bad, fail] = useImageFailure(src);
  return h('div', null, bad ? 'fallback' : h('img', { src, onError: fail }));
}

const host = globalThis.document.body;
const mount = (src) => { render(h(Probe, { src }), host); };

const hasImg = () => {
  let img = false;
  (function walk(el) { if (el.tagName === 'IMG') img = true; for (const c of el.children || []) walk(c); })(host);
  return img;
};
const fireError = () => {
  let el = null;
  (function walk(e) { if (e.tagName === 'IMG') el = e; for (const c of e.children || []) walk(c); })(host);
  for (const fn of [...(el?._listeners.error || [])]) fn.call(el, { type: 'error', target: el, currentTarget: el });
};
/** Run the pending renders (microtasks) and effect flushes (the rAF shim's 0 ms timers) until nothing is left. */
const settle = async () => {
  for (let n = 0; n < 10; n++) {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const due = timers.filter((t) => t.ms === 0);
    for (const t of due) { timers.splice(timers.indexOf(t), 1); t.fn(); }
    if (!due.length) break;
  }
};
/** The rests still standing (the retry timers; the 0 ms ones are consumed by settle). */
const rests = () => timers.map((t) => t.ms);
const fireRest = async (ms) => {
  const t = timers.find((x) => x.ms === ms);
  timers.splice(timers.indexOf(t), 1);
  t.fn();
  await settle();
};

describe('useImageFailure (public/js/ui/materialImage.js, feedback #44)', () => {
  test('a failed picture rests, comes back, and gives up after three tries per page life', async () => {
    mount('probe-u1.png');
    await settle();
    assert.ok(hasImg(), 'the picture shows');
    assert.deepEqual(rests(), [], 'no retry scheduled yet');

    fireError(); await settle();
    assert.ok(!hasImg(), 'the fallback shows while it rests');
    assert.deepEqual(rests(), [10000], 'the first rest is 10 s');

    await fireRest(10000);
    assert.ok(hasImg(), 'the picture is asked for again');
    fireError(); await settle();
    assert.deepEqual(rests(), [30000], 'the second rest is 30 s');

    await fireRest(30000);
    assert.ok(hasImg());
    fireError(); await settle();
    assert.deepEqual(rests(), [120000], 'the third rest is 2 min');

    await fireRest(120000);
    assert.ok(hasImg());
    fireError(); await settle();
    assert.ok(!hasImg(), 'the fallback stays');
    assert.deepEqual(rests(), [], 'a URL gets one try per entry in a page\'s life');
  });

  test('the rounds are counted per URL', async () => {
    mount('probe-u2.png');
    await settle();
    fireError(); await settle();
    assert.deepEqual(rests(), [10000], 'a fresh URL starts at its first rest, not the exhausted one\'s');
  });

  test('a src swap does not keep the old picture\'s failure', async () => {
    mount('probe-u3.png');
    await settle();
    fireError(); await settle();
    assert.ok(!hasImg());
    mount('probe-u4.png');
    assert.ok(hasImg(), 'the other URL is judged on its own');
  });

  test('the rests are 10 s, 30 s, 2 min', () => {
    assert.deepEqual(IMAGE_RETRY_MS, [10000, 30000, 120000]);
  });
});
