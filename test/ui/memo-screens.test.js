// test/ui/memo-screens.test.js — the game screen's memoized tail: BondStrip (ui/bondStrip.js), EffectsList
// (ui/effectsList.js) and CombatHud (ui/combatHud.js) wrapped in the memo shim (ui/memo.js) so MatchScreen's push
// and local-interaction re-renders sit them out while their props are unchanged. Really rendered here — vendored
// Preact diffing into the hand-rolled DOM stub of test/ui/memo.test.js (no new dependencies) — and the accepted
// renders are counted by wrapping the memo wrapper's prototype.render, so the assertions see the skip/render
// decisions. The call sites (screens/game.js) keep their props stable: the memoized `strip`, the ‹ › layers and
// the CombatHud's client object are useMemo'd, BondStrip's onOpen is one useCallback per owner.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, options } from '../../public/vendor/preact.module.js';
import { html } from '../../public/js/ui/components.js';
import { BondStrip } from '../../public/js/ui/bondStrip.js';
import { EffectsList } from '../../public/js/ui/effectsList.js';
import { CombatHud } from '../../public/js/ui/combatHud.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// preact/hooks flushes useEffect after "paint"; Node has no requestAnimationFrame, so the fallback is a 35 ms
// timer. The hooks module honours options.requestAnimationFrame — a fast one keeps the tests quick.
options.requestAnimationFrame = (fn) => setTimeout(fn, 0);

// the browser data store reads the real data files from disk (test/ui/watch-bonds.test.js's stub)
globalThis.fetch = async (url) => {
  const name = String(url).split('/').pop();
  try {
    const body = readFileSync(path.join(ROOT, 'data', name), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  } catch {
    return { ok: false, status: 404, json: async () => ({}) };
  }
};
const { data } = await import('../../public/js/data.js');
await data.loadAll('bonds', 'assets');

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
  };
  return el;
}

/** A minimal document surface for preact's diff; restored afterwards so other tests see the real globals. */
function harness() {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const savedRO = globalThis.ResizeObserver;
  const body = makeElement('body');
  globalThis.document = {
    createElement: (tag) => makeElement(tag),
    createElementNS: (_ns, tag) => makeElement(tag),
    createTextNode: (text) => { const n = makeElement('#text'); n.data = text; return n; },
    body,
  };
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; // BondStrip's scroller
  return {
    body,
    restore: () => {
      if (saved) Object.defineProperty(globalThis, 'document', saved); else delete globalThis.document;
      if (savedRO === undefined) delete globalThis.ResizeObserver; else globalThis.ResizeObserver = savedRO;
    },
  };
}

let renders = 0;
let savedRender = null;
/** Count the accepted renders of a memoized component for the duration of `fn`. */
function counting(comp, fn) {
  renders = 0;
  savedRender = comp.prototype.render;
  comp.prototype.render = function () { renders++; return savedRender.call(this); };
  try { return fn(); } finally { comp.prototype.render = savedRender; }
}

const bond = (bondId, count, layers, tier = count >= 2 ? 1 : 0) => ({ bondId, count, active: tier > 0, tier, layers });
const BONDS = [bond('yanShip', 3, 12, 1), bond('kjeragShip', 0, 7, 0)];
const EFFECTS = [{ id: 'band_x', name: '策略', iconKind: 'band', counter: 2 }];
const CLIENT = { observing: null, onBack: null, layers: [], layer: 'ALL', onLayer: () => {} };

describe('the game screen\'s memoized tail', () => {
  test('BondStrip, EffectsList and CombatHud are memoized (the ui/memo.js wrapper)', () => {
    for (const [name, comp] of [['BondStrip', BondStrip], ['EffectsList', EffectsList], ['CombatHud', CombatHud]]) {
      assert.equal(typeof comp.prototype.shouldComponentUpdate, 'function', `${name}: the shim's shallow compare`);
      assert.match(comp.displayName, /^Memo\(/, `${name}: the profiler name`);
    }
  });

  test('a push storm with unchanged props renders each of them once', () => {
    const h = harness();
    try {
      counting(BondStrip, () => {
        const stable = () => {};
        render(html`<${BondStrip} bonds=${BONDS} onOpen=${stable} owner=${null} layersDisabled=${false} openId=${null} />`, h.body);
        for (let push = 0; push < 8; push++) {
          render(html`<${BondStrip} bonds=${BONDS} onOpen=${stable} owner=${null} layersDisabled=${false} openId=${null} />`, h.body);
        }
        assert.equal(renders, 1, 'BondStrip: the memoized strip and the per-owner onOpen keep every push out');
      });
      counting(EffectsList, () => {
        render(html`<${EffectsList} effects=${EFFECTS} />`, h.body);
        for (let push = 0; push < 8; push++) render(html`<${EffectsList} effects=${EFFECTS} />`, h.body);
        assert.equal(renders, 1, 'EffectsList: m.private.effects keeps its reference across the pushes');
      });
      counting(CombatHud, () => {
        const hud = { dp: 10 };
        const onWatch = () => {};
        render(html`<${CombatHud} pub=${null} myId="p1" watching=${null} hud=${hud} myDone=${false}
          spectating=${false} spectator=${false} onWatch=${onWatch} client=${CLIENT} />`, h.body);
        for (let push = 0; push < 8; push++) {
          render(html`<${CombatHud} pub=${null} myId="p1" watching=${null} hud=${hud} myDone=${false}
            spectating=${false} spectator=${false} onWatch=${onWatch} client=${CLIENT} />`, h.body);
        }
        assert.equal(renders, 1, 'CombatHud: the useMemo\'d client object and the hud reference sit the pushes out');
      });
    } finally { h.restore(); }
  });

  test('a real change still renders: new bonds, a hud tick, a fresh effects array', () => {
    const h = harness();
    try {
      counting(BondStrip, () => {
        const stable = () => {};
        render(html`<${BondStrip} bonds=${BONDS} onOpen=${stable} />`, h.body);
        render(html`<${BondStrip} bonds=${[bond('yanShip', 4, 13, 1)]} onOpen=${stable} />`, h.body);
        assert.equal(renders, 2, 'a grown bond re-renders (the memoized strip produced a new list)');
        render(html`<${BondStrip} bonds=${[bond('yanShip', 4, 13, 1)]} onOpen=${() => {}} />`, h.body);
        assert.equal(renders, 3, 'a new onOpen identity (another strip owner) re-renders');
      });
      counting(CombatHud, () => {
        render(html`<${CombatHud} pub=${null} myId="p1" watching=${null} hud=${{ dp: 10 }} myDone=${false}
          spectating=${false} spectator=${false} onWatch=${() => {}} client=${CLIENT} />`, h.body);
        render(html`<${CombatHud} pub=${null} myId="p1" watching=${null} hud=${{ dp: 9 }} myDone=${false}
          spectating=${false} spectator=${false} onWatch=${() => {}} client=${CLIENT} />`, h.body);
        assert.equal(renders, 2, 'a hud tick (new hud object) re-renders: the DP counter follows');
      });
      counting(EffectsList, () => {
        render(html`<${EffectsList} effects=${EFFECTS} />`, h.body);
        render(html`<${EffectsList} effects=${EFFECTS.slice()} />`, h.body);
        assert.equal(renders, 2, 'a fresh array is a change (shallow compare, by reference — never deep)');
      });
    } finally { h.restore(); }
  });

  test('the game screen keeps the memo props stable (the call sites of the three, on the source)', () => {
    const src = readFileSync(path.join(ROOT, 'public/js/screens/game.js'), 'utf8');
    assert.match(src, /const strip = useMemo\(\(\) => screenStrip\(/, 'the strip is memoized');
    assert.match(src, /onOpen=\$\{openStripBond\}/, 'BondStrip gets the per-owner opener, not an inline arrow');
    assert.match(src, /const combatClient = useMemo\(/, 'the CombatHud client object is memoized');
    assert.match(src, /pub=\$\{cc \? null : pub\}/, 'client-side combat passes no pub (the legacy switcher is dead code there)');
    assert.match(src, /client=\$\{combatClient\}/);
  });
});
