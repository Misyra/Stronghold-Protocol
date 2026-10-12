// Static contract for public/css/utility-mobile.css: the compact density layer for the management
// surfaces. These are numeric CSS budgets and source-text checks — NOT a browser, layout engine or
// touch-target substitute. See docs/MOBILE_UTILITY_UI.md for what still needs a real device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postcss from 'postcss';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');
const source = read('public/css/utility-mobile.css');
const sheet = postcss.parse(source);
// the two neighbouring layers the compact rules lean on (hit areas, the hint button)
const devices = postcss.parse(read('public/css/devices.css'));

const MOBILE = '(max-width: 1000px), (max-height: 600px)';
const NARROW = '(max-width: 560px)';

/** The last declared value of `prop` for `selector` inside `media` ('' = top level) of one sheet. */
function declarationIn(sheetRoot, selector, prop, media = '') {
  let value;
  sheetRoot.walkRules((rule) => {
    if ((rule.parent.type === 'atrule' ? rule.parent.params : '') !== media) return;
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls(prop, (decl) => { value = decl.value; });
  });
  assert.ok(value != null, `${selector} { ${prop} } (${media || 'top level'})`);
  return value;
}

const declaration = (selector, prop, media = '') => declarationIn(sheet, selector, prop, media);

/** `declaration` against public/css/devices.css instead. */
const deviceDeclaration = (selector, prop, media = '') => declarationIn(devices, selector, prop, media);

function hasRule(selector, media = '') {
  let found = false;
  sheet.walkRules((rule) => {
    if ((rule.parent.type === 'atrule' ? rule.parent.params : '') !== media) return;
    if (rule.selectors.includes(selector)) found = true;
  });
  return found;
}

// ---------------------------------------------------------------------------------------------
// 1. the variable contract
// ---------------------------------------------------------------------------------------------

test('--utility-text is a typography-only token: theme.css still owns --t and this layer never redefines it', () => {
  assert.doesNotMatch(source, /(?:^|\n)\s*(?:html|body|:root)\s*\{/, 'no global selector may start this layer');
  assert.doesNotMatch(source, /--t\s*:/, '--t stays defined in theme.css only');
  assert.doesNotMatch(source, /(?:^|[^-])\bzoom\s*:|transform:\s*scale\(/, 'density never comes from scaling');
  sheet.walkDecls((decl) => {
    if (/var\(--utility-text/.test(decl.value)) assert.equal(decl.prop, 'font-size', `${decl.prop} cannot read the text floor`);
  });
});

test('every management root declares its own text scale, because the hosts are siblings of the screens', () => {
  const roots = declaration(':is(.modal--utility, .guide, .lo, .st)', '--utility-text', MOBILE);
  assert.equal(roots, 'max(var(--t), 64px)');
  // The title, the lobby, the room and the resource / settings / about dialogs are game-scale surfaces:
  // they follow the saved text size exactly (xinhai ba744327) — the floor would pin 小 and 中 together
  // on a phone and make the setting do nothing on any of them.
  assert.equal(declaration(':is(.title-screen, .lobby-screen, .room-screen)', '--utility-text', MOBILE), 'var(--t)');
  assert.equal(declaration(':is(.utility-modal.resource-modal, .utility-modal.settings-modal, .utility-modal.about-panel)',
    '--utility-text', MOBILE), 'var(--t)');
  assert.equal(hasRule(':is(.utility-modal, .lobby-screen, .room-screen)', MOBILE), false,
    'the modal host, not the box, must carry the variable: UiHosts is a child of .app-root');
});

test('a soft keyboard shrinks the management budgets through the measured visible viewport', () => {
  for (const sel of ['.modal--utility', '.guide', '.lo', '.st']) {
    assert.equal(declaration(sel, 'height', MOBILE), 'min(100dvh, calc(var(--sp-vh, 1dvh) * 100))', sel);
  }
  assert.equal(declaration('.title-screen', 'height', MOBILE),
    'calc(min(100dvh, calc(var(--sp-vh, 1dvh) * 100)) - var(--sa-t, 0px) - var(--sa-b, 0px))');
  assert.match(read('public/js/ui/device.js'), /visualViewport/, 'device.js still publishes --sp-vh');
});

// ---------------------------------------------------------------------------------------------
// 2. opt-in: management dialogs only
// ---------------------------------------------------------------------------------------------

test('the Modal utility prop moves the requested width to a CSS variable and adds a close button', () => {
  const component = read('public/js/ui/components.js');
  assert.match(component, /utility = false/);
  assert.match(component, /utility \? `--utility-width:\$\{width\}` : `width:\$\{width\}`/,
    'an inline width would beat the media query');
  assert.match(component, /utility && onClose[\s\S]*?utility-modal__close[\s\S]*?aria-label=\$\{t\('关闭'\)\}/);
  assert.match(component, /utility=\$\{utility\}/, 'imperative dialogs opt in per call');
  assert.match(component, /modalStack/, 'the existing focus trap and Escape handling stay');
  assert.equal(declaration('.utility-modal .modal__body', 'overflow-y'), 'auto');
  assert.equal(declaration('.utility-modal .modal__body', 'min-height'), '0');
  assert.equal(declaration('.utility-modal .modal__head', 'flex'), 'none');
});

test('management dialogs opt in; gameplay dialogs (equipment, rewards, spectating, leave, fullscreen prompt) do not', () => {
  for (const file of [
    'public/js/ui/settings.js', 'public/js/ui/resourcePanel.js', 'public/js/ui/about.js',
    'public/js/ui/announcement.js', 'public/js/ui/resumeMatch.js', 'public/js/ui/historyPanel.js',
    'public/js/ui/matchInfo.js', 'public/js/screens/loadout.js', 'public/js/screens/stats.js',
    'public/js/screens/room.js',
  ]) assert.match(read(file), /utility=\$\{true\}|utility: true/, file);
  for (const file of [
    'public/js/ui/equipReplace.js', 'public/js/ui/hud.js', 'public/js/ui/matchChrome.js',
    'public/js/ui/device.js', 'public/js/ui/detailPanel.js',
  ]) assert.doesNotMatch(read(file), /utility=\$\{true\}|utility: true/, file);
});

// ---------------------------------------------------------------------------------------------
// 3. loading order
// ---------------------------------------------------------------------------------------------

test('source pages and the bundle load the density layer right after devices.css', () => {
  const html = read('public/index.html');
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="(\/css\/[^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual(sheets.slice(-2), ['/css/devices.css', '/css/utility-mobile.css']);
  assert.equal((html.match(/href="\/css\/utility-mobile.css"/g) || []).length, 1);
  for (const fixture of ['public/dev/game-mock.html', 'public/dev/uikit.html']) {
    const page = read(fixture);
    assert.ok(page.indexOf('/css/utility-mobile.css') > page.indexOf('/css/devices.css'), fixture);
  }
  assert.match(read('test/client-static.test.js'), /utility-mobile\.css/);
});

// ---------------------------------------------------------------------------------------------
// 4. the battlefield keeps its own geometry
// ---------------------------------------------------------------------------------------------

test('no rule in this layer touches the HUD, the board, the shop, the detail card or the chat', () => {
  // The 作战统计 panel is the one battle-side exception (next test): it is docked *by* the layer, not restyled around.
  const battle = /\.gm__hud|\.gm__field|\.gm\b|\.shopbar|\.scard|\.ewheel|\.readybtn|\.uframe|\.bstrip|\.dpanel|\.dhead|\.chud|\.gtop|\.team\b|\.capsule|\.tooltip/;
  sheet.walkRules((rule) => assert.doesNotMatch(rule.selector, battle, `battle selector ${rule.selector}`));
});

test('the combat statistics panel is the single battle-side surface this layer carries, and keeps its own type floor', () => {
  // Ported from xinhai's combat-metrics panel (the owner's decision): it docks over the corner, so the layer carries its
  // compact chrome and the position it floats to when the corner no longer fits the visible viewport
  // (ui/combatMetricsLayout.js publishes the measured heights, ui/combatMetrics.js the data-viewport-docked flag).
  assert.match(source, /\.combat-metrics \{/);
  assert.match(source, /\.combat-metrics\[data-viewport-docked="true"\]/);
  assert.match(source, /--combat-available-height/);
  assert.match(source, /--combat-viewport-height/);
  // nothing else of the battlefield came in with it
  assert.equal(hasRule('.gm__hud'), false);
  assert.equal(hasRule('.shopbar'), false);
  assert.equal(hasRule('.gm__corner'), false, 'the panel is positioned; the corner itself keeps its geometry');
  // It reads --t with game.css's explicit px floors, NOT the management floor: --utility-text is declared on the
  // management roots only, so a declaration here reading it would silently fall back to --t and drop those floors.
  sheet.walkRules((rule) => {
    if (!/combat-metrics/.test(rule.selector)) return;
    rule.walkDecls((decl) => assert.doesNotMatch(decl.value, /var\(--utility-text/,
      `${rule.selector} ${decl.prop} must not read the management floor`));
  });
  // and the battle stylesheets must not have taken the management token either
  for (const file of ['public/css/screens/game.css', 'public/css/screens/game-shop.css', 'public/css/screens/game-panels.css', 'public/css/emotes.css']) {
    assert.doesNotMatch(read(file), /--utility-text/, file);
  }
});

// ---------------------------------------------------------------------------------------------
// 5. compact controls, real hit boxes
// ---------------------------------------------------------------------------------------------

test('compact controls use their actual box: the 44 px invisible hit area is clipped inside a management surface', () => {
  const selector = '.sp-coarse :is(.utility-modal, .lo, .st, .lobby-screen, .room-screen, .title-screen) :is(.btn, .tabs__tab, .set-toggle, .set-seg button, .fsbtn)::before';
  assert.equal(declaration(selector, 'inset', MOBILE), '0');
  assert.equal(declaration(selector, 'width', MOBILE), '100%');
  assert.equal(declaration(selector, 'height', MOBILE), '100%');
  assert.equal(declaration(selector, 'transform', MOBILE), 'none');
  // and the compact boxes stay above the 24 px WCAG 2.2 minimum (24 px = .6 rem at the 40 px root floor)
  assert.equal(declaration('.resource-choice', 'min-height', MOBILE), '.7rem');
  assert.equal(declaration('.guide__dot', 'min-width', MOBILE), '26px');
  assert.equal(declaration('.room-screen .invite__btns .btn', 'min-width', MOBILE), '.65rem');
  assert.equal(declaration('.utility-modal :is(.btn--square, .utility-modal__close)', 'width', MOBILE), '30px');
});

test('focused fields keep the 16 px floor that stops iOS from zooming into them', () => {
  const rule = declaration('.utility-modal :is(input:not([type="radio"]):not([type="checkbox"]):not([type="range"]), textarea, select)', 'font-size', MOBILE);
  assert.match(rule, /16px/);
  for (const sel of ['.lo .lo-search .field__input', '.lo-select select', '.title-screen .title-login .field__input']) {
    assert.match(declaration(sel, 'font-size', MOBILE), /16px/, sel);
  }
});

// ---------------------------------------------------------------------------------------------
// 6. content survives: nothing is hidden to fit a budget
// ---------------------------------------------------------------------------------------------

test('the lobby keeps its mode points, difficulty effects and tips instead of hiding them', () => {
  assert.equal(declaration('.lobby-screen .mode-card__points', 'display', MOBILE), 'flex');
  assert.equal(hasRule('.lobby-screen .diff-card__effects'), false,
    'the difficulty effects must not be hidden: they were never display:none to begin with');
  assert.equal(declaration('.lobby-screen .tips', 'margin-top', MOBILE), '.2rem');
  assert.equal(hasRule('.title-screen .title-corner--tl', MOBILE), false, 'the corner tools stay reachable');
  assert.equal(declaration('.title-screen .title-corner', 'position', MOBILE), 'relative');
  assert.match(read('public/js/screens/lobby.js'), /diff-card__effects|mode-card__points/, 'both still render');
});

test('the resource manager keeps both tiers, the voice choice and every count', () => {
  assert.equal(declaration('.resource-manager__tiers', 'grid-template-columns', MOBILE), 'repeat(2, minmax(0, 1fr))');
  assert.equal(declaration('.resource-manager__tiers', 'grid-template-columns', NARROW), 'minmax(0, 1fr)');
  assert.equal(declaration('.resource-tier__list li', 'padding', MOBILE), '.1rem 0');
  assert.equal(declaration('.resource-manager__status', 'padding', MOBILE), '.15rem');
  const panel = read('public/js/ui/resourcePanel.js');
  assert.match(panel, /archiveGroup === group\.id|group\.id/, 'the active import category stays visible');
  assert.match(panel, /pauseResources/, 'pause stays available');
});

test('the room keeps its title on one row and every seat visible', () => {
  assert.equal(declaration('.room-screen .topbar', 'height', MOBILE), 'auto');
  assert.equal(declaration('.room-screen .topbar', 'min-height', MOBILE), '0');
  assert.equal(declaration('.room-screen .topbar', 'grid-template-areas', MOBILE), '"controls title invite"');
  assert.equal(declaration('.room-screen .topbar__title', 'white-space', MOBILE), 'nowrap');
  assert.equal(declaration('.room-screen .topbar__title', 'flex-wrap', MOBILE), 'nowrap');
  assert.equal(declaration('.room-screen .room-bar', 'height', MOBILE), 'auto');
  assert.equal(declaration('.room-screen .room-bar', 'grid-template-areas', MOBILE), '"options actions" "status actions"');
  assert.equal(declaration('.room-screen .room-bar', 'grid-template-areas', NARROW), '"options" "status" "actions"');
  assert.equal(declaration('.room-screen .seat', 'min-height', NARROW), '3.5rem');
  assert.equal(declaration('.room-screen--coop .seats', 'grid-auto-rows', NARROW), 'minmax(3.5rem, auto)');
  assert.equal(declaration('.room-screen .invite__code span', 'width', MOBILE), '.72em');
});

test('the loadout and the local-statistics screens keep every column and warning', () => {
  for (const grid of ['.own-grid', '.diy-grid']) {
    assert.equal(declaration(grid, 'grid-template-columns', MOBILE),
      'repeat(auto-fill, minmax(min(100%, 240px), 1fr))', grid);
  }
  assert.equal(declaration('.st-titles', 'grid-template-columns', MOBILE), 'repeat(auto-fill, minmax(104px, 1fr))');
  assert.equal(declaration('.st-sums', 'grid-template-columns', MOBILE), 'repeat(auto-fill, minmax(130px, 1fr))');
  assert.equal(declaration('.st-table td', 'padding', MOBILE), '5px 6px');
  assert.equal(declaration('.st-table th', 'padding', MOBILE), '5px 6px');
  assert.equal(declaration('.st-tablewrap', 'overflow-x', NARROW), 'auto');
  assert.equal(declaration('.lo-list__head', 'column-gap', MOBILE), '6px');
  assert.equal(declaration('.lo .lo-card', 'column-gap', MOBILE), '6px');
  assert.match(declaration('.lo-list', '--cols', MOBILE), /minmax\(148px/);
});

test('the guide keeps 16:9 pages, its chapter list, its dots and the text fallback', () => {
  assert.match(declaration('.guide__page', 'width', MOBILE), /\* 16 \/ 9\)/);
  assert.equal(declaration('.guide__chapters', 'overflow-x', MOBILE), 'auto');
  assert.equal(declaration('.guide__dots', 'overflow-x', MOBILE), 'auto');
  assert.equal(declaration('.guide__stage--text', 'overflow-y', MOBILE), 'auto');
  assert.equal(declaration('.guide__chapter', 'height', MOBILE), '30px');
  assert.equal(declaration('.guide__close', 'width', MOBILE), '30px');
});

// ---------------------------------------------------------------------------------------------
// 7. orientation: the mandatory landscape gate is not bypassed
// ---------------------------------------------------------------------------------------------

test('the compact layer never overrides the rotate hint or the landscape gate', () => {
  sheet.walkRules((rule) => assert.doesNotMatch(rule.selector, /rotate-hint|sp-rotatable/,
    'the orientation gate belongs to theme.css'));
  const theme = read('public/css/theme.css');
  assert.match(theme, /\.sp-rotatable \.rotate-hint \{ display: grid; \}/);
  assert.match(theme, /@media \(orientation: portrait\) and \(max-width: 1024px\)/);
  assert.ok(hasRule('.modal--utility', MOBILE) && hasRule('.guide', MOBILE) && hasRule('.lo', MOBILE),
    'every management surface still receives the compact rules under the portrait gate');
});

test('the rotate hint offers fullscreen on browsers that support it, and hides the button otherwise', () => {
  const html = read('public/index.html');
  assert.match(html, /class="btn btn--primary btn--sm rotate-hint__fullscreen" id="rotate-hint-fullscreen"/);
  const device = read('public/js/ui/device.js');
  assert.match(device, /rotate-hint-fullscreen/);
  assert.match(device, /\.hidden = !fullscreen\.supported\(win\)/);
  assert.match(device, /fullscreen\.enter\(win\)/);
  assert.equal(deviceDeclaration('.rotate-hint__fullscreen[hidden]', 'display'), 'none');
  assert.match(read('public/css/devices.css'), /\.rotate-hint__fullscreen \{ pointer-events: auto/);
  assert.match(read('public/css/theme.css'), /\.rotate-hint__fullscreen \{ min-height: 44px/);
});

// ---------------------------------------------------------------------------------------------
// 8. numeric width / height budgets at real viewport sizes
// ---------------------------------------------------------------------------------------------

/** Small evaluator for the length expressions this layer uses. It models px/rem/vw/vh/dvh and
 *  CSS min()/max()/calc() only — not fonts, intrinsic sizes, flex/grid or selector matching. */
function length(expr, vars, viewport, percentBase = viewport.width) {
  const tokens = expr.match(/--[\w-]+|\d*\.?\d+(?:dvh|svh|vh|vw|rem|px|%)?|[a-z]+|[()+*/,-]/g) || [];
  let at = 0;
  const unit = (n, u) => n * ({ px: 1, rem: vars.rem, vw: viewport.width / 100, vh: viewport.height / 100,
    dvh: viewport.height / 100, svh: viewport.height / 100, '%': percentBase / 100, '': 1 }[u] ?? 1);
  function primary() {
    const token = tokens[at++];
    if (/^[\d.]/.test(token)) return unit(parseFloat(token), token.replace(/^[\d.]+/, ''));
    if (token === '(') { const value = sum(); at++; return value; }
    at++; // the function name
    if (token === 'var') {
      const name = tokens[at++];
      let fallback = 0;
      if (tokens[at] === ',') { at++; fallback = sum(); }
      at++;
      return vars[name] ?? fallback;
    }
    const values = [sum()];
    while (tokens[at] === ',') { at++; values.push(sum()); }
    at++;
    if (token === 'min') return Math.min(...values);
    if (token === 'max') return Math.max(...values);
    return values[0]; // calc
  }
  function product() {
    let value = primary();
    while (tokens[at] === '*' || tokens[at] === '/') {
      const op = tokens[at++];
      const right = primary();
      value = op === '*' ? value * right : value / right;
    }
    return value;
  }
  function sum() {
    let value = product();
    while (tokens[at] === '+' || tokens[at] === '-') {
      const op = tokens[at++];
      const right = product();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  }
  const value = sum();
  assert.equal(at, tokens.length, `unparsed expression: ${expr}`);
  assert.ok(Number.isFinite(value), expr);
  return value;
}

for (const [width, height] of [[320, 568], [390, 844], [640, 360], [844, 390], [915, 412], [1000, 600]]) {
  test(`${width}x${height}: management dialogs, the guide and the title fit the safe-area bounds`, () => {
    const viewport = { width, height };
    const vars = { rem: Math.max(40, Math.min(width / 19.2, height / 10.8)),
      '--sa-l': 20, '--sa-r': 12, '--sa-t': 8, '--sa-b': 10, '--sp-vh': height / 100 };
    const safe = width - vars['--sa-l'] - vars['--sa-r'];
    for (const selector of ['.modal--utility .utility-modal', '.modal--utility .resource-modal',
      '.modal--utility .settings-modal', '.modal--utility .minfo-dlg']) {
      const w = length(declaration(selector, 'width', MOBILE), vars, viewport, safe);
      assert.ok(w <= safe && w > 200, `${selector}: ${Math.round(w)} of ${safe}`);
    }
    // the visible-viewport height budget, and never a taller box than the padding leaves
    const boxHeight = length(declaration('.modal--utility .utility-modal', 'max-height', MOBILE), vars, viewport);
    assert.ok(boxHeight <= height - vars['--sa-t'] - vars['--sa-b'], `${boxHeight}`);
    assert.ok(length(declaration('.modal--utility', 'height', MOBILE), vars, viewport) <= height);
    assert.ok(length(declaration('.title-screen', 'height', MOBILE), vars, viewport) <= height - vars['--sa-t'] - vars['--sa-b'] + .01);
    // a 16:9 guide page fits between the head and the footer
    const pageWidth = length(declaration('.guide__page', 'width', MOBILE), vars, viewport);
    assert.ok(pageWidth <= safe - 28, `${pageWidth}`);
    assert.ok(pageWidth * 9 / 16 <= height - vars['--sa-t'] - vars['--sa-b'] - 90 + .01);
  });
}
