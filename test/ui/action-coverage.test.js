// The 开发者控制台 (ui/console.js) clicked through `actions.console`, but ui/gameActions.js never defined
// that action: every grant threw `actions.console is not a function`, the row stayed on 「发放中…」 and no
// `g.console` intent reached the server. A UI module calling an action the object does not define must fail
// CI, so every module that imports `{ actions }` from ui/gameActions.js is scanned for `actions.<name>(`
// and each name is checked against the object's own keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

function jsSources(dir = 'public/js') {
  const out = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...jsSources(rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

const IMPORTS_ACTIONS = /import\s*\{[^}]*\bactions\b[^}]*\}\s*from\s*['"][^'"]*\/gameActions\.js['"]/;

/** The keys of `export const actions = { … }` (entries sit at the object's own two-space indent). */
function actionKeys(src) {
  const start = src.indexOf('export const actions = {');
  assert.ok(start >= 0, 'ui/gameActions.js exports the actions object');
  const body = src.slice(start);
  const end = body.indexOf('\n};');
  assert.ok(end > start, 'the actions object literal closes');
  const keys = new Set([...body.slice(0, end).matchAll(/^ {2}([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]));
  assert.ok(keys.size >= 20, `expected the actions object's entries, found ${keys.size}`);
  return keys;
}

test('every actions.<name>() call in the client names an action gameActions defines', () => {
  const keys = actionKeys(read('public/js/ui/gameActions.js'));
  assert.ok(keys.has('console'), 'the developer console action exists — every grant called it before it was defined');
  const calls = [];
  for (const file of jsSources()) {
    const src = read(file);
    if (!IMPORTS_ACTIONS.test(src)) continue;
    // a bare `actions` identifier (not `foo.actions.bar`) and an optional `?.` call chain
    for (const m of src.matchAll(/(?<![.\w$])actions\??\.([A-Za-z_$][\w$]*)\s*\(/g)) calls.push([file, m[1]]);
  }
  assert.ok(calls.length >= 20, `expected the client's action calls, found ${calls.length}`);
  assert.ok(calls.some(([file, name]) => file.endsWith('ui/console.js') && name === 'console'),
    'the console grant is covered by the scan');
  const missing = calls.filter(([, name]) => !keys.has(name));
  assert.deepEqual(missing, [], `ui/gameActions.js has no such action: ${missing.map(([f, n]) => `${n} (${f})`).join(', ')}`);
});

test('actions.console sends g.console and carries amount only when one is given', async () => {
  const { net } = await import('../../public/js/net.js');
  const { actions } = await import('../../public/js/ui/gameActions.js');
  const request = net.request;
  const sent = [];
  net.request = async (t, fields) => { sent.push([t, fields]); };
  try {
    assert.equal(await actions.console('chess', 'char_002_amiya'), true);
    assert.equal(await actions.console('item', 'item_x', null), true);
    assert.equal(await actions.console('bond', 'bond_x', 10), true);
  } finally {
    net.request = request;
  }
  assert.deepEqual(sent, [
    ['g.console', { kind: 'chess', id: 'char_002_amiya' }],
    ['g.console', { kind: 'item', id: 'item_x' }],
    ['g.console', { kind: 'bond', id: 'bond_x', amount: 10 }],
  ]);
});
