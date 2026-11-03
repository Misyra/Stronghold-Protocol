// 作战统计 on short / partly occluded viewports (published issue 「作战统计打不开」): ui/combatMetrics.js measures the
// room actually left above the HUD corner and the visible viewport, and the panel floats inside the viewport when the
// corner no longer fits above it. The layout module alone is not enough — the stylesheet has to consume what the module
// publishes, or a wrapped corner on a short landscape phone squeezes the panel below its own header and the ranking is
// clipped away (the settings switch then looks like it does nothing). These tests pin both halves: the pure layout, and
// the CSS rules that read its variables / flag.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { combatMetricsLayout } from '../../public/js/ui/combatMetricsLayout.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CSS = readFileSync(path.join(ROOT, 'public/css/screens/game.css'), 'utf8');

/** The body of the rule whose selector starts at `at` (the first `{` after it), by brace matching. */
function ruleAt(src, at) {
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces at ${at}`);
}

describe('combatMetricsLayout: dock or float, never squeeze the ranking out', () => {
  test('a wrapped short-screen corner used to leave less room than the header: it now docks', () => {
    const height = 270, cornerHeight = 148, safeBottom = 21, rem = 40;
    const cornerBottom = height - safeBottom - .24 * rem;
    const previousBudget = height - cornerHeight - 48 - .34 * rem - safeBottom;
    assert.ok(previousBudget < 44 + 8, 'the old corner-height subtraction left no room for the ranking');
    const layout = combatMetricsLayout({ cornerTop: cornerBottom - cornerHeight, cornerBottom, viewportHeight: height, safeBottom, rem });
    assert.equal(layout.viewportDocked, true);
    assert.equal(layout.viewportSpace, 237);
    assert.ok(layout.viewportPanelTop + layout.viewportSpace <= height - safeBottom);
    assert.ok(layout.viewportSpace - 36 - 3 >= 2 * 64, 'a compact head plus two large rank rows fit');
  });

  for (const height of [240, 270, 320, 360, 390, 412]) {
    for (const cornerHeight of [34, 74, 110, 148]) {
      test(`height ${height}, corner ${cornerHeight}: dock or docked body retains positive rank space`, () => {
        const rem = 40, safeTop = 24, safeBottom = 21;
        const cornerBottom = height - safeBottom - .24 * rem;
        const layout = combatMetricsLayout({ cornerTop: cornerBottom - cornerHeight, cornerBottom, viewportHeight: height, rem, safeTop, safeBottom });
        const panelHeight = Math.min(10 * rem, layout.viewportDocked ? layout.viewportSpace : layout.availableHeight);
        assert.ok(panelHeight - 64 - 3 >= 60, `${panelHeight}px must not leave only a header`);
        if (layout.viewportDocked) {
          assert.ok(layout.viewportPanelTop >= safeTop);
          assert.ok(layout.viewportPanelTop + panelHeight <= height - safeBottom);
        } else assert.ok(layout.availableHeight >= 128);
      });
    }
  }

  test('a spacious viewport keeps the existing modeless corner dock', () => {
    const layout = combatMetricsLayout({ cornerTop: 650, cornerBottom: 710, viewportHeight: 768, rem: 64 });
    assert.equal(layout.viewportDocked, false);
    assert.equal(layout.availableHeight, 642);
  });

  test('an occluded corner above the visible viewport cannot generate a negative height', () => {
    const layout = combatMetricsLayout({ cornerTop: 50, cornerBottom: 90, viewportTop: 100, viewportHeight: 240 });
    assert.equal(layout.availableHeight, 0);
    assert.equal(layout.viewportDocked, true);
    assert.ok(layout.viewportSpace > 128);
  });
});

describe('the stylesheet consumes the measured layout', () => {
  const baseAt = CSS.indexOf('.combat-metrics {');
  const dockAt = CSS.indexOf('.combat-metrics[data-viewport-docked="true"] {');

  test('the base panel takes ui/combatMetrics.js\'s measured height, with the vh / dvh arithmetic only as fallback', () => {
    assert.ok(baseAt >= 0);
    const base = ruleAt(CSS, baseAt);
    assert.match(base, /var\(--combat-available-height/, 'the panel must read the measured room above the corner');
    assert.match(base, /var\(--combat-available-height, calc\(100dvh/, 'the pre-measure fallback stays');
  });

  test('a docked corner floats the panel inside the visible viewport', () => {
    assert.ok(dockAt > baseAt, 'the docked rule comes after the base rule');
    const dock = ruleAt(CSS, dockAt);
    assert.match(dock, /position:\s*fixed/);
    assert.match(dock, /bottom:\s*auto/);
    assert.match(dock, /(?:top|left):\s*var\(--combat-viewport-(?:top|height)/, 'the visible viewport publishes the top');
    assert.match(dock, /var\(--combat-viewport-height/, 'the panel height follows the visible viewport');
  });

  test('a short touch screen keeps the head on one line, so the measured height reaches the ranking', () => {
    const at = CSS.indexOf('@media (max-height: 600px) and (pointer: coarse)');
    assert.ok(at >= 0);
    const phone = ruleAt(CSS, at);
    const head = phone.match(/\.combat-metrics__head \{[^}]*\}/);
    assert.ok(head, 'the short-screen panel head rule exists');
    assert.match(head[0], /flex-wrap:\s*nowrap/, 'the scope tabs must not take a whole second row');
    assert.match(phone, /\.combat-metrics__close \{ order: 1; \}/, '✕ moves to the end of the single row');
    assert.match(phone, /\.combat-metrics__head > \.combat-metrics__tools \{[^}]*flex:\s*1 1 0/,
      'the scope tabs take the row\'s free space');
  });
});
