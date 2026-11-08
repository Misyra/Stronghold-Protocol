// public/js/boot.js: a game script that fails to load in a capable browser is tried again by itself before the page gives up
// (a release in progress, a network blip); an old browser is told so at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../public/js/boot.js', import.meta.url), 'utf8');

function page({ store = new Map(), now = 1_000_000, importmap = true } = {}) {
  const err = { textContent: '', attrs: {}, getAttribute(k) { return this.attrs[k] ?? null; }, setAttribute(k, v) { this.attrs[k] = v; } };
  const timers = [];
  const location = { reloads: 0, reload() { this.reloads++; } };
  const HTMLScriptElement = { supports: () => importmap };
  const window = { addEventListener() {}, HTMLScriptElement };
  const context = { window, location, HTMLScriptElement, JSON,
    Date: { now: () => now },
    document: { getElementById: (id) => (id === 'boot-err' ? err : null), addEventListener() {} },
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } };
  vm.runInNewContext(SOURCE, context);
  return { fail: (why) => window.__spBootFail(why), err, timers, location, store };
}

const fired = (p, ms) => p.timers.filter((x) => x.ms === ms).forEach((x) => x.fn());

test('a load failure reloads the page after a pause and does not show the final error', () => {
  const p = page();
  p.fail('load');
  assert.match(p.err.textContent, /重新加载/);
  assert.equal(p.err.getAttribute('data-final'), null);
  assert.equal(p.location.reloads, 0, 'not at once: a release in progress needs the pause');
  fired(p, 5000);
  assert.equal(p.location.reloads, 1);
});

test('two reports of one failure make one retry', () => {
  const p = page();
  p.fail('load'); p.fail('load');
  assert.equal(p.timers.filter((x) => x.ms === 5000).length, 1);
  assert.equal(JSON.parse(p.store.get('sp.bootRetry')).n, 1);
});

test('after four retries in a row the page stops and says what happened', () => {
  const store = new Map();
  for (let i = 0; i < 4; i++) { const p = page({ store }); p.fail('load'); assert.equal(p.err.getAttribute('data-final'), null, `retry ${i + 1}`); }
  const last = page({ store });
  last.fail('load');
  assert.match(last.err.textContent, /游戏脚本加载失败/);
  assert.equal(last.err.getAttribute('data-final'), '1');
  assert.equal(last.timers.filter((x) => x.ms === 5000).length, 0);
});

test('the count forgets itself after two minutes', () => {
  const store = new Map();
  for (let i = 0; i < 4; i++) page({ store }).fail('load');
  const later = page({ store, now: 1_000_000 + 120_001 });
  later.fail('load');
  assert.equal(later.err.getAttribute('data-final'), null);
  assert.equal(JSON.parse(store.get('sp.bootRetry')).n, 1);
});

test('a browser too old for the game never retries', () => {
  for (const p of [page({ importmap: false }), page()]) {
    p.fail('old');
    assert.match(p.err.textContent, /版本过旧/);
    assert.equal(p.timers.filter((x) => x.ms === 5000).length, 0);
  }
});
