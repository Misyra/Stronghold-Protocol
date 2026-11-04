// The ⚙ menu (screens/room.js RoomOptions, ui/console.js ConsoleModal's sibling) unfolds with the
// `rs-opts-in` / `rs-opts-row` animations. Both start at `opacity: 0`, and the rows additionally use
// `backwards` fill with 40–240 ms delays. An element at opacity 0 is still hit-testable, so at the
// moment the menu appears — or while a delayed row waits to start — a click can land on a row the
// player cannot see yet. The invisible first frame must not take hits; `pointer-events` is inherited,
// so a row's none covers its switch until the paint catches up (discrete at 50% of the animation).
// Note: the earlier `elementFromPoint` hit `.ailast__opt` was the 开发者控制台 switch itself — it
// carries that class — not a second overlapping control; the automation timeout that led here came
// from the element not settling while the menu animated, so this guard covers the invisible-hit
// window, not a covering element.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const CSS = 'public/css/screens/room.css';

function keyframes(css, name) {
  const at = css.search(new RegExp(`@keyframes\\s+${name}\\b`));
  assert.ok(at >= 0, `@keyframes ${name} exists`);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  assert.fail(`@keyframes ${name} is not closed`);
}

function frame(block, which) {
  const m = new RegExp(`${which}\\s*\\{([^}]*)\\}`).exec(block);
  assert.ok(m, `the ${which} frame exists`);
  return m[1];
}

test('the room settings menu cannot take a hit before it is painted', () => {
  const css = read(CSS);
  const row = keyframes(css, 'rs-opts-row');
  assert.match(frame(row, 'from'), /pointer-events\s*:\s*none/, 'a row must not take hits while it is still transparent');
  assert.match(frame(row, 'to'), /pointer-events\s*:\s*auto/, 'a row must be interactive once painted');
  // the panel must stay hit-testable while it fades: its surface swallows the early click; if it were none too,
  // the click would reach the page and the menu's outside handler would close the menu under the pointer
  const panel = keyframes(css, 'rs-opts-in');
  assert.doesNotMatch(frame(panel, 'from'), /pointer-events\s*:\s*none/, 'the panel surface must swallow clicks during its fade');
  // the delayed rows rely on `backwards` to be transparent first — the guard above then covers the delay
  assert.match(css, /\.rs-opts\s*>\s*\*\s*\{[^}]*animation:\s*rs-opts-row[^}]*backwards/);
  // reduced motion turns the animation off: the base pointer-events (auto) must be what remains
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.rs-opts[^}]*animation:\s*none/);
});
