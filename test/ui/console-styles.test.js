// The in-match 开发者控制台 (ui/console.js) shipped with no CSS at all: each grant row is a <button>, so
// without rules the entries flowed inline — the second column started after the first entry's text, the
// ids were clipped and the 发放中 chip overlapped the next entry. This pins every class the component
// renders to at least one rule under public/css, and keeps a stray, never-defined custom property out
// (`--ui`: the 5 `calc(Npx * var(--ui))` floors in this file were invalid at computed-value time and
// silently dropped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

function cssSources(dir = 'public/css') {
  const out = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...cssSources(rel));
    else if (entry.name.endsWith('.css')) out.push(rel);
  }
  return out;
}

test('every class the developer console renders has a rule in public/css', () => {
  const src = read('public/js/ui/console.js');
  // class tokens the component renders: console-ui, console-ui__entry-text, console-bond-modal, …
  const classes = new Set([...src.matchAll(/console-(?:ui(?:__[\w-]+)?|bond-modal)/g)].map((m) => m[0]));
  assert.ok(classes.size >= 10, `expected the console's class set, found ${classes.size}: ${[...classes]}`);
  const css = cssSources().map(read).join('\n');
  for (const cls of [...classes].sort()) {
    assert.match(css, new RegExp(`\\.${cls}(?![\\w-])`), `.${cls} has no CSS rule — an unstyled console entry flows inline`);
  }
});

test('the console CSS uses only custom properties some file defines', () => {
  const css = read('public/css/screens/game-panels.css');
  assert.doesNotMatch(css, /var\(--ui\)/, 'var(--ui) was never defined; its calc() floors were dropped silently');
  const at = css.indexOf('/* ---- developer console');
  assert.ok(at > 0, 'the console block exists');
  const block = css.slice(at);
  const theme = read('public/css/theme.css') + read('public/css/components.css');
  const defined = new Set([...theme.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  for (const m of block.matchAll(/var\((--[\w-]+)\)/g)) {
    assert.ok(defined.has(m[1]), `var(${m[1]}) is not defined in theme.css / components.css`);
  }
});
