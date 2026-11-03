// test/ui/memo.test.js — the memo shim (ui/memo.js): the vendored Preact exports no memo, so ui/memo.js wraps a
// component in a class whose shouldComponentUpdate shallow-compares the props (store.js shallowEqual) and skips
// the render — and with it the whole subtree — while every prop is Object.is-equal. Really rendered here —
// vendored Preact diffing into the hand-rolled DOM stub below (the harness of test/ui/announcement.render.test.js,
// trimmed, no new dependencies) — so the assertions see the skip/render decisions, not the source text.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { render, options } from '../../public/vendor/preact.module.js';
import { useState } from '../../public/vendor/hooks.module.js';
import { html } from '../../public/js/ui/components.js';
import { memo } from '../../public/js/ui/memo.js';

// preact/hooks flushes useEffect after "paint"; Node has no requestAnimationFrame, so the fallback is a 35 ms
// timer. The hooks module honours options.requestAnimationFrame — a fast one keeps the tests quick.
options.requestAnimationFrame = (fn) => setTimeout(fn, 0);

function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(), children: [], attrs: new Map(), _listeners: {},
    className: '', data: '', parentNode: null, nextSibling: null,
    style: { cssText: '', setProperty() {}, removeProperty() {} },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    insertBefore(c, ref) {
      const i = el.children.indexOf(ref);
      if (i < 0) return el.appendChild(c);
      el.children.splice(i, 0, c); c.parentNode = el; return c;
    },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); c.parentNode = null; return c; },
    addEventListener(type, fn) { (el._listeners[type] ??= new Set()).add(fn); },
    removeEventListener(type, fn) { el._listeners[type]?.delete(fn); },
    setAttribute(k, v) { el.attrs.set(k, String(v)); if (k === 'class') el.className = String(v); },
    removeAttribute(k) { el.attrs.delete(k); if (k === 'class') el.className = ''; },
    getAttribute(k) { return el.attrs.get(k) ?? null; },
  };
  return el;
}

/** A minimal document surface for preact's diff; restored afterwards so other tests see the real globals. */
function harness() {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const body = makeElement('body');
  globalThis.document = {
    createElement: (tag) => makeElement(tag),
    createElementNS: (_ns, tag) => makeElement(tag),
    createTextNode: (text) => { const n = makeElement('#text'); n.data = text; return n; },
    body,
  };
  return {
    body,
    textOf: (el) => {
      let text = '';
      (function walk(node) { for (const c of node.children || []) { if (c.tagName === '#TEXT') text += c.data; else walk(c); } })(el);
      return text;
    },
    restore: () => {
      if (saved) Object.defineProperty(globalThis, 'document', saved); else delete globalThis.document;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 4));

/** Mount a fresh counter component per test: `renders` counts the wrapped component's runs. */
function mountCounter(h, extra = {}) {
  let renders = 0;
  const Inner = (props) => {
    renders++;
    return html`<div class=${props.cls}>${String(props.n)}</div>`;
  };
  const Memoed = memo(Inner, extra.compare);
  return {
    renders: () => renders,
    show: (props) => render(html`<${Memoed} ...${props} />`, h.body),
    Inner,
  };
}

describe('memo: the shallow prop compare', () => {
  test('skips while every prop is Object.is-equal — scalars, the same object and the same function', () => {
    const h = harness();
    try {
      const m = mountCounter(h);
      const obj = { a: 1 };
      const fn = () => {};
      m.show({ n: 1, cls: 'x', obj, fn });
      assert.equal(m.renders(), 1);
      m.show({ n: 1, cls: 'x', obj, fn });
      assert.equal(m.renders(), 1, 'equal props: no re-render, the subtree stays as it was');
      assert.equal(h.textOf(h.body), '1', 'the skipped render left the old output up');
      m.show({ n: 2, cls: 'x', obj, fn });
      assert.equal(m.renders(), 2, 'a changed scalar re-renders');
      assert.equal(h.textOf(h.body), '2');
    } finally { h.restore(); }
  });

  test('nested objects compare by reference, never deep', () => {
    const h = harness();
    try {
      const m = mountCounter(h);
      const obj = { a: 1 };
      m.show({ n: 1, obj });
      m.show({ n: 1, obj: { a: 1 } });
      assert.equal(m.renders(), 2, 'equal contents, new reference: re-render (shallow, no deep compare)');
      const same = { a: 1 };
      m.show({ n: 1, obj: same });
      assert.equal(m.renders(), 3);
      m.show({ n: 1, obj: same });
      assert.equal(m.renders(), 3, 'the same reference: skip');
    } finally { h.restore(); }
  });

  test('function props compare by reference too', () => {
    const h = harness();
    try {
      const m = mountCounter(h);
      const fn = () => {};
      m.show({ n: 1, fn });
      m.show({ n: 1, fn });
      assert.equal(m.renders(), 1, 'the same function: skip');
      m.show({ n: 1, fn: () => {} });
      assert.equal(m.renders(), 2, 'a new closure over equal values is a change: re-render');
    } finally { h.restore(); }
  });

  test('undefined, null and a missing prop are distinct values', () => {
    const h = harness();
    try {
      const m = mountCounter(h);
      m.show({ n: 1, v: undefined });
      m.show({ n: 1, v: undefined });
      assert.equal(m.renders(), 1, 'undefined to undefined: skip');
      m.show({ n: 1, v: null });
      assert.equal(m.renders(), 2, 'undefined to null: re-render');
      m.show({ n: 1, v: null });
      assert.equal(m.renders(), 2, 'null to null: skip');
      m.show({ n: 1 });
      assert.equal(m.renders(), 3, 'null to missing: re-render (the key sets differ)');
    } finally { h.restore(); }
  });

  test('a custom propsAreEqual decides (true = skip) and its skipped render still adopts the new props', () => {
    const h = harness();
    try {
      const m = mountCounter(h, { compare: (a, b) => a.n === b.n }); // ignores cls on purpose
      m.show({ n: 1, cls: 'a' });
      assert.equal(m.renders(), 1);
      m.show({ n: 1, cls: 'b' });
      assert.equal(m.renders(), 1, 'the comparator says equal: skip');
      assert.equal(h.body.getAttribute('class') ?? '', '', 'nothing re-rendered');
      m.show({ n: 2, cls: 'b' });
      assert.equal(m.renders(), 2, 'a comparator change re-renders with the latest props');
    } finally { h.restore(); }
  });
});

describe('memo: the wrapped component keeps working', () => {
  test('its own setState re-renders it although the props did not change', async () => {
    const h = harness();
    try {
      let renders = 0;
      let bump = null;
      const Inner = (props) => {
        renders++;
        const [n, setN] = useState(0);
        bump = () => setN((c) => c + 1);
        return html`<div class=${props.cls} data-n=${n} />`;
      };
      const Memoed = memo(Inner);
      render(html`<${Memoed} cls="x" />`, h.body);
      assert.equal(renders, 1);
      bump();
      await tick();
      assert.equal(renders, 2, 'a state update inside re-renders through the wrapper');
      assert.equal(h.body.children[0].attrs.get('data-n'), '1');
      render(html`<${Memoed} cls="x" />`, h.body);
      assert.equal(renders, 2, 'and the parent re-render with equal props still skips');
    } finally { h.restore(); }
  });

  test('a skipped render with the default compare keeps the output exactly as it was', () => {
    const h = harness();
    try {
      let renders = 0;
      let latest = null;
      const Inner = (props) => { renders++; latest = props.n; return html`<div>${String(props.n)}</div>`; };
      const Memoed = memo(Inner);
      render(html`<${Memoed} n=${1} />`, h.body);
      render(html`<${Memoed} n=${1} />`, h.body); // skipped
      render(html`<${Memoed} n=${2} />`, h.body);
      render(html`<${Memoed} n=${2} />`, h.body); // skipped
      assert.equal(renders, 2, 'two skips, two renders');
      assert.equal(latest, 2);
      assert.equal(h.textOf(h.body), '2');
    } finally { h.restore(); }
  });

  test('the wrapper is named after the wrapped component (profiler / devtools)', () => {
    const h = harness();
    try {
      function Named() { return html`<div />`; }
      assert.equal(memo(Named).displayName, 'Memo(Named)');
      assert.equal(memo(() => html`<div />`).displayName, 'Memo(Anonymous)');
    } finally { h.restore(); }
  });
});
