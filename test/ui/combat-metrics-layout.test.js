import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combatMetricsLayout } from '../../public/js/ui/combatMetricsLayout.js';

test('short landscape with a wrapped corner used to consume the entire rank viewport; now floats inside the screen', () => {
  const height = 270, cornerHeight = 148, safeBottom = 21, rem = 40;
  const cornerBottom = height - safeBottom - .24 * rem;
  const previousBudget = height - cornerHeight - 48 - .34 * rem - safeBottom;
  // Closing button's old coarse-pointer floor alone left no room for the ranking.
  assert.ok(previousBudget < 44 + 8);
  const layout = combatMetricsLayout({
    cornerTop: cornerBottom - cornerHeight, cornerBottom, viewportHeight: height, safeBottom, rem,
  });
  assert.equal(layout.viewportDocked, true);
  assert.equal(layout.viewportSpace, 237);
  assert.ok(layout.viewportPanelTop + layout.viewportSpace <= height - safeBottom);
  assert.ok(layout.viewportSpace - 36 - 3 >= 2 * 64, 'pinned compact head plus two large rank rows fit');
});

for (const height of [240, 270, 320, 360, 390, 412]) {
  for (const cornerHeight of [34, 74, 110, 148]) {
    test(`height ${height}, corner ${cornerHeight}: dock or floating body retains positive rank space`, () => {
      const rem = 40, safeTop = 24, safeBottom = 21;
      const cornerBottom = height - safeBottom - .24 * rem;
      const layout = combatMetricsLayout({
        cornerTop: cornerBottom - cornerHeight, cornerBottom, viewportHeight: height, rem, safeTop, safeBottom,
      });
      const panelHeight = Math.min(10 * rem, layout.viewportDocked ? layout.viewportSpace : layout.availableHeight);
      // Allow a 64px translated / enlarged-text head and border, not just the default 36px head.
      assert.ok(panelHeight - 64 - 3 >= 60, `${panelHeight}px must not leave only a header`);
      if (layout.viewportDocked) {
        assert.ok(layout.viewportPanelTop >= safeTop);
        assert.ok(layout.viewportPanelTop + panelHeight <= height - safeBottom);
      } else assert.ok(layout.availableHeight >= 128);
    });
  }
}

test('normal spacious viewport keeps the existing modeless corner dock', () => {
  const layout = combatMetricsLayout({ cornerTop: 650, cornerBottom: 710, viewportHeight: 768, rem: 64 });
  assert.equal(layout.viewportDocked, false);
  assert.equal(layout.availableHeight, 642);
});

test('visual viewport reduction floats a dock whose corner is behind browser chrome or the keyboard', () => {
  const layout = combatMetricsLayout({
    cornerTop: 650, cornerBottom: 710, viewportHeight: 300, safeTop: 8, safeBottom: 10,
  });
  assert.equal(layout.viewportDocked, true);
  assert.equal(layout.viewportSpace, 270);
  assert.equal(layout.viewportPanelTop, 14);
});

test('visual viewport pan offsets the floating top; a resized/notched viewport stays bounded', () => {
  const layout = combatMetricsLayout({
    cornerTop: 285, cornerBottom: 359, viewportTop: 100, viewportHeight: 260, safeTop: 8, safeBottom: 20,
  });
  assert.equal(layout.viewportDocked, true, 'corner no longer fits above the visible bottom safe area');
  assert.equal(layout.viewportPanelTop, 114);
  assert.ok(layout.viewportPanelTop + layout.viewportSpace <= 360 - 20);
});

test('an occluded corner above the visible viewport cannot generate a negative height', () => {
  const layout = combatMetricsLayout({ cornerTop: 50, cornerBottom: 90, viewportTop: 100, viewportHeight: 240 });
  assert.equal(layout.availableHeight, 0);
  assert.equal(layout.viewportDocked, true);
  assert.ok(layout.viewportSpace > 128);
});
