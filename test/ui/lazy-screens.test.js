// test/ui/lazy-screens.test.js — the cold-start entry split (perf2/entry-split).
// The title screen stays in the entry; lobby/room/game load on demand, and a set of boot-time
// helpers was pulled out of the screen modules so importing them no longer drags a whole screen
// into the first chunk. These unit checks pin the shape and the helper behaviour; the LCP A/B and
// the build-page probe are separate (tools/perf2-lcp.mjs, test/vite.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOM_CODE_LEN } from '../../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const main = readFileSync(path.join(ROOT, 'public/js/main.js'), 'utf8');
const helpers = readFileSync(path.join(ROOT, 'public/js/screens/helpers.js'), 'utf8');
const mod = (rel) => import(pathToFileURL(path.join(ROOT, 'public/js', rel)).href);

test('main.js loads only the title screen statically; lobby/room/game are dynamic imports', () => {
  // first static import stays the polyfill (client-static.test.js pins this too)
  const first = main.match(/^import\s+['"]([^'"]+)['"]/m);
  assert.equal(first?.[1], './ui/compat.js');
  // the title is the first paint: it must be in the entry, not a lazy round trip before the LCP element
  assert.match(main, /import \{ TitleScreen \} from '\.\/screens\/title\.js'/);
  for (const screen of ['lobby', 'room', 'game']) {
    assert.match(main, new RegExp(`${screen}: \\(\\) => import\\('\\./screens/${screen}\\.js'\\)`), `${screen} is a lazy chunk`);
    // and no static import of that screen component remains
    assert.doesNotMatch(main, new RegExp(`import \\{[^}]*\\b(LobbyScreen|RoomScreen|GameScreen)\\b[^}]*\\} from '\\./screens/${screen}\\.js'`));
  }
  assert.doesNotMatch(main, /import\('.\/screens\/title\.js'\)/, 'the title screen is never a dynamic import');
});

test('the lazy renderer, the fallback and the idle/hover preload triggers are wired', () => {
  for (const marker of ['SCREEN_LOADERS', 'SCREEN_EXPORTS', 'screenResolved', 'function loadScreen(',
    'function preloadScreen(', 'function whenScreensReady(', 'function ScreenFallback(',
    'function LazyScreen(', 'function installScreenPreload(', 'installScreenPreload();']) {
    assert.ok(main.includes(marker), `main.js has ${marker}`);
  }
  assert.match(main, /requestIdleCallback/, 'idle preload uses requestIdleCallback');
  assert.match(main, /data-preload-screen/, 'hover/focus/pointerdown preload reads the data attribute');
  for (const ev of ['pointerover', 'focusin', 'pointerdown']) assert.ok(main.includes(`'${ev}'`), `${ev} preload trigger`);
  assert.match(main, /__SP__ = \{[^}]*preloadScreen, whenScreensReady, screensWarm/, 'test hooks are exposed');
  assert.ok(main.includes('<${LazyScreen} key=${route} route=${route} />'), 'App renders the lazy screen by route');
});

test('boot-time helpers live in a light module that imports no screen component', () => {
  assert.doesNotMatch(helpers, /from '\.\/(?:title|lobby|room|game)\.js'/, 'helpers never import a screen');
  for (const name of ['normalizeCode', 'codeArg', 'parseRoomParam', 'recentRooms', 'rememberRoom',
    'joinKnown', 'TrustedNotice', 'CODE_RE']) {
    assert.match(helpers, new RegExp(`export (?:const|function|async function|\\{[^}]*\\b${name}\\b)`), `helpers exports ${name}`);
  }
  assert.match(helpers, /export \{ stripLoneSurrogates, sanitizeName, isValidName \} from '\.\.\/ui\/playerName\.js'/);
});

test('the screen modules keep re-exporting the moved helpers (callers/tests resolve them)', async () => {
  const lobby = readFileSync(path.join(ROOT, 'public/js/screens/lobby.js'), 'utf8');
  const room = readFileSync(path.join(ROOT, 'public/js/screens/room.js'), 'utf8');
  assert.match(lobby, /export \{[^}]*parseRoomParam[^}]*\} from '\.\/helpers\.js'/);
  assert.match(room, /export \{ TrustedNotice \} from '\.\/helpers\.js'/);
  // and the exports actually resolve through the original modules
  const l = await mod('screens/lobby.js');
  for (const name of ['parseRoomParam', 'rememberRoom', 'joinKnown', 'normalizeCode', 'codeArg', 'recentRooms', 'CODE_RE']) {
    assert.equal(typeof l[name] === 'function' || l[name] instanceof RegExp, true, `lobby re-exports ${name}`);
  }
  const r = await mod('screens/room.js');
  assert.equal(typeof r.TrustedNotice, 'function', 'room re-exports TrustedNotice');
});

test('helpers.js keeps the room-code helper behaviour (pure functions)', async () => {
  const h = await mod('screens/helpers.js');
  const code = 'A'.repeat(ROOM_CODE_LEN);
  assert.equal(h.parseRoomParam(`?room=${code}`), code);
  assert.equal(h.parseRoomParam('?room=x'), null, 'too short');
  assert.equal(h.parseRoomParam('?room=BAD!CODE'), null, 'bad characters');
  assert.equal(h.parseRoomParam(''), null);
  // a pasted invite link normalises to the code; a Preact click EVENT falls back to the field
  assert.equal(h.normalizeCode(`https://host/?room=${code.toLowerCase()}`), code);
  assert.equal(h.codeArg({ type: 'click' }, code), code);
  assert.equal(h.codeArg(undefined, '!!!'), null, 'an invalid field yields no code');
  assert.equal(h.CODE_RE.test(code), true);
  assert.equal(h.sanitizeName('  YG  '), 'YG');
});
