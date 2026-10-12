// Room chrome at compact widths: component props and a real cascade check over the three stylesheets
// that own these rules (components.css → screens/room.css → utility-mobile.css). Not a substitute for
// a browser or a physical phone: see docs/MOBILE_UTILITY_UI.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { RoomTools } from '../../public/js/screens/room.js';
import { SettingsButton } from '../../public/js/ui/settings.js';
import { GuideButton } from '../../public/js/ui/guide.js';

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const layers = ['public/css/components.css', 'public/css/screens/room.css', 'public/css/utility-mobile.css']
  .map((file) => postcss.parse(read(file)));

function mediaMatches(params, width, height) {
  return params.split(',').some((part) => {
    const conditions = [...part.matchAll(/\(max-(width|height):\s*(\d+)px\)/g)];
    return conditions.length > 0 && conditions.every(([, axis, max]) => (axis === 'width' ? width : height) <= Number(max));
  });
}

/**
 * Last winning value for `prop` among the exact simple selectors listed, over the three real layers.
 * Class counts are the specificity proxy and source order breaks ties — deliberately NOT a model of
 * intrinsic text size, grid placement, flex wrapping or touch hit testing.
 */
function property(selectors, name, width, height) {
  let chosen, weight = -1;
  for (const layer of layers) layer.walkRules((rule) => {
    if (rule.parent.type === 'atrule' && rule.parent.name === 'media' && !mediaMatches(rule.parent.params, width, height)) return;
    for (const selector of rule.selector.split(',').map((s) => s.trim())) {
      if (!selectors.includes(selector)) continue;
      const specificity = (selector.match(/\.[\w-]+/g) || []).length;
      rule.walkDecls(name, (decl) => {
        if (specificity >= weight) { chosen = decl.value; weight = specificity; }
      });
    }
  });
  assert.notEqual(chosen, undefined, `${selectors.join(' / ')} { ${name} }`);
  return chosen;
}

/** `true` when no matching rule declares `name` at this viewport (the property is left to the UA). */
function propertyMissing(selectors, name, width, height) {
  let found = false;
  for (const layer of layers) layer.walkRules((rule) => {
    if (rule.parent.type === 'atrule' && rule.parent.name === 'media' && !mediaMatches(rule.parent.params, width, height)) return;
    for (const selector of rule.selector.split(',').map((s) => s.trim())) {
      if (!selectors.includes(selector)) continue;
      rule.walkDecls(name, () => { found = true; });
    }
  });
  return !found;
}

const both = (selector) => [selector, `.room-screen ${selector}`];

// ---------------------------------------------------------------------------------------------
// components
// ---------------------------------------------------------------------------------------------

test('a co-op room shows four icon-only square buttons with the original actions and accessible names', () => {
  const tools = RoomTools({ coop: true });
  assert.equal(tools.props.class, 'room-topbar__tools');
  const buttons = tools.props.children.filter((node) => node && typeof node === 'object');
  assert.equal(buttons.length, 4);
  const [stats, settings, announcement, guide] = buttons;
  assert.equal(stats.props.square, true);
  assert.equal(stats.props.icon, 'chart');
  assert.equal(stats.props.children, null, 'there is no visible label left to hide with CSS');
  assert.equal(typeof stats.props.onClick, 'function', 'the statistics action is unchanged');
  assert.ok(stats.props.title && stats.props['aria-label']);
  for (const node of [settings, announcement, guide]) assert.equal(node.props.square, true);
  assert.equal(settings.type, SettingsButton);
  assert.equal(guide.type, GuideButton);
  assert.match(read('public/js/ui/settings.js'), /title=\$\{t\('设置'\)\} aria-label=\$\{t\('设置'\)\}/);
  assert.match(read('public/js/ui/guide.js'), /title=\$\{t\('玩法说明'\)\} aria-label=\$\{t\('玩法说明'\)\}/);
  assert.match(read('public/js/ui/announcement.js'), /title=\$\{t\('服务器公告'\)\} aria-label=\$\{t\('服务器公告'\)\}/);
  assert.match(read('public/js/ui/settings.js'), /\$\{square \? null : label\}/, 'square mode drops the text, not the nested glyph');
  assert.match(read('public/js/ui/announcement.js'), /\$\{square \? null : t\('公告'\)\}/);
});

test('a solo simulation keeps its labels, and the order statistics → settings → announcement → guide', () => {
  const buttons = RoomTools({ coop: false }).props.children.filter((node) => node && typeof node === 'object');
  assert.equal(buttons.length, 4);
  assert.equal(buttons[0].props.square, false);
  assert.equal(typeof buttons[0].props.children, 'string');
  for (const node of buttons.slice(1)) assert.equal(node.props.square, false);
  assert.equal(buttons[1].type, SettingsButton);
  assert.equal(buttons[3].type, GuideButton);
  assert.match(read('public/js/screens/room.js'), /<\$\{RoomTools\} coop=\$\{coop\}/);
});

test('the room says which mode it is in with a class, not with a different component tree', () => {
  assert.match(read('public/js/screens/room.js'), /room-screen\$\{coop \? ' room-screen--coop' : ''\}/);
});

// ---------------------------------------------------------------------------------------------
// cascade: every compact width, including the 761–1000 px landscape phones
// ---------------------------------------------------------------------------------------------

for (const [width, height] of [[320, 568], [390, 844], [560, 320], [640, 360], [760, 390], [761, 390], [844, 390], [915, 412], [1000, 600], [1200, 500]]) {
  test(`room ${width}x${height}: named areas override the shared grid rules and the fixed bar heights`, () => {
    assert.equal(property(both('.topbar'), 'height', width, height), 'auto');
    assert.equal(property(both('.topbar'), 'min-height', width, height), '0');
    assert.equal(property(both('.topbar'), 'grid-template-areas', width, height), '"controls title invite"');
    assert.equal(property(both('.topbar'), 'grid-template-columns', width, height),
      width <= 560 ? 'minmax(0, .85fr) minmax(0, 1.3fr) minmax(0, .85fr)' : 'minmax(0, 1fr) minmax(0, 1.15fr) minmax(0, 1fr)');
    assert.equal(property(both('.topbar__left'), 'grid-area', width, height), 'controls');
    assert.equal(property(both('.topbar__center'), 'grid-area', width, height), 'title');
    assert.equal(property(both('.topbar__right'), 'grid-area', width, height), 'invite');
    assert.equal(property(both('.topbar__right'), 'max-width', width, height), '100%', 'the invite stays inside its track');
    // the title never wraps onto a line of its own
    assert.equal(property(both('.topbar__title'), 'white-space', width, height), 'nowrap');
    assert.equal(property(both('.topbar__title'), 'flex-wrap', width, height), 'nowrap');
    // the footer grows instead of keeping the desktop height
    assert.equal(property(both('.room-bar'), 'height', width, height), 'auto', 'a growing footer must not spill over the seats');
    assert.equal(property(both('.room-bar'), 'grid-template-areas', width, height),
      width <= 560 ? '"options" "status" "actions"' : '"options actions" "status actions"');
    assert.equal(property(['.room-screen .room-bar__left', '.room-screen .room-bar__left'], 'grid-area', width, height), 'options');
    assert.equal(property(['.room-screen .room-bar__center', '.room-screen .room-bar__center'], 'grid-area', width, height), 'status');
    assert.equal(property(['.room-screen .room-bar__right', '.room-screen .room-bar__right'], 'grid-area', width, height), 'actions');
    // the four room tools are square at every compact width
    assert.equal(property(['.room-screen .room-topbar__tools'], 'display', width, height), 'flex');
    assert.equal(property(['.room-screen .room-tools'], 'min-width', width, height), '30px');
    assert.equal(property(['.room-screen .room-tools'], 'height', width, height), '30px');
  });
}

test('normal desktop room chrome keeps its three-column layout and its fixed bar heights', () => {
  assert.equal(property(both('.topbar'), 'height', 1920, 1080), '1.36rem');
  assert.equal(property(both('.topbar'), 'grid-template-columns', 1920, 1080), 'minmax(0, 1fr) auto minmax(0, 1fr)');
  assert.equal(property(both('.room-bar'), 'height', 1920, 1080), '1.5rem');
  // The single-row title is a compact-only rule: on the desktop the base layer declares no
  // white-space at all, so the title keeps the browser default and may wrap in a translated locale.
  assert.equal(propertyMissing(both('.topbar__title'), 'white-space', 1920, 1080), true);
  assert.equal(property(both('.topbar__title'), 'white-space', 844, 390), 'nowrap');
  // the wrapper only exists for the compact layer: on the desktop its children stay direct flex items
  // of .topbar__left (display: contents), so the top bar's own gap and wrapping are unchanged
  assert.equal(property(['.room-topbar__tools'], 'display', 1920, 1080), 'contents');
  assert.equal(property(['.room-screen .room-topbar__tools'], 'display', 844, 390), 'flex');
  assert.equal(propertyMissing(both('.room-tools'), 'min-width', 1920, 1080), true);
  assert.equal(property(both('.room-tools'), 'min-width', 844, 390), '30px');
});

// ---------------------------------------------------------------------------------------------
// seats
// ---------------------------------------------------------------------------------------------

test('the room title stays on the controls/invite row at phone widths', () => {
  for (const width of [320, 360, 390, 560, 640, 844]) {
    assert.equal(property(both('.topbar'), 'grid-template-areas', width, 390), '"controls title invite"');
    assert.equal(property(both('.topbar__title'), 'white-space', width, 390), 'nowrap');
  }
});

test('invite key boxes scale with their own glyphs instead of a tiny rem box around enlarged text', () => {
  assert.equal(property(both('.invite__code span'), 'width', 844, 390), '.72em');
  assert.equal(property(both('.invite__code span'), 'height', 844, 390), '1em');
  assert.equal(property(both('.invite__code span'), 'flex', 844, 390), 'none');
});

test('a short co-op room still shows a seat region and scrolls as a whole', () => {
  assert.equal(property(['.room-screen--coop'], 'overflow-y', 640, 270), 'auto');
  assert.equal(property(['.room-screen--coop .seats'], 'min-height', 640, 270), '144px');
  assert.equal(property(['.room-screen--coop .seats'], 'flex', 640, 270), '1 0 144px');
  // portrait: the explicit first row is released so 140 px cards cannot overrun it
  assert.equal(property(['.room-screen .seats', '.room-screen .seats'], 'grid-template-rows', 390, 844), 'none');
  assert.equal(property(['.room-screen--coop .seats'], 'grid-auto-rows', 390, 844), 'minmax(140px, auto)');
  assert.equal(property(['.room-screen .seat'], 'min-height', 390, 844), '140px');
});
