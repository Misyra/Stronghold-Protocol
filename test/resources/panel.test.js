// test/resources/panel.test.js — the two faces of the preload UI (public/js/ui/resourcePanel.js, docs/development/ASSETS.md
// 「Preload」): the numbers both render, and the wiring that puts the launcher in the title screen's bottom-right corner
// (the settings modal is only reachable inside a match, so the home screen needs its own entry).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { byteText, detailText, percent } from '../../public/js/ui/resourcePanel.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The state public/js/resources/index.js publishes, with the counters its store filled in. */
const state = (over = {}) => ({
  enabled: true, phase: 'download', supported: true, reason: '', done: 0, total: 0, wanted: 0,
  tier1Done: 0, tier1Total: 0, tier2Done: 0, tier2Total: 0, bytes: 0, totalBytes: null, sized: 0, sizedTotal: 0,
  skipped: 0, failed: 0, complete: false, message: '', error: false, worker: '', version: '', ...over,
});

describe('preload numbers', () => {
  test('byteText: only when the server could size the files', () => {
    assert.equal(byteText(state()), '', 'nothing known yet');
    assert.equal(byteText(state({ totalBytes: null })), '');
    assert.equal(byteText(state({ totalBytes: 0 })), '');
    assert.equal(byteText(state({ totalBytes: 2 * 1024 * 1024, sizedTotal: 0 })), '2.0 MiB', 'sizes unknown ⇒ the total only');
    assert.equal(byteText(state({ totalBytes: 2 * 1024 * 1024, sizedTotal: 3, bytes: 1024 * 1024 })), '1.0 MiB / 2.0 MiB');
  });

  test('detailText: the two tiers, the file count and the bytes', () => {
    assert.equal(detailText(state()), '', 'no manifest yet');
    assert.equal(detailText(state({ total: 3966, wanted: 3960, done: 812, tier1Total: 456, tier1Done: 456, tier2Total: 3510, tier2Done: 356 })), '必需 456/456 · 全部 812/3966');
    const withBytes = state({ total: 3966, wanted: 3966, done: 812, tier1Total: 456, tier1Done: 456, totalBytes: 259726913, sizedTotal: 3966, bytes: 50000000 });
    assert.equal(detailText(withBytes), '必需 456/456 · 全部 812/3966 · 47.7 MiB / 248 MiB');
    assert.equal(detailText(state({ total: 10, done: 1, tier1Total: 0 })), '全部 1/10', 'no essential tier ⇒ no 必需 line');
  });

  test('percent: by bytes when every file is sized, by file count otherwise, clamped', () => {
    assert.equal(percent(state()), 0);
    assert.equal(percent(state({ total: 100, wanted: 100, done: 25 })), 25);
    assert.equal(percent(state({ total: 100, wanted: 80, done: 40 })), 50, 'skipped files do not count as missing');
    assert.equal(percent(state({ total: 100, wanted: 100, done: 100 })), 100);
    assert.equal(percent(state({ total: 100, wanted: 100, done: 0, totalBytes: 200, sizedTotal: 100, bytes: 50 })), 25);
    assert.equal(percent(state({ total: 100, wanted: 100, done: 0, totalBytes: 200, sizedTotal: 50, bytes: 50 })), 0, 'a partly sized manifest falls back to files');
    assert.equal(percent(state({ total: 4, wanted: 4, done: 9 })), 100, 'clamped');
    assert.equal(percent(state({ total: 10, wanted: 9, done: 9, complete: true, totalBytes: 1000, bytes: 100, sizedTotal: 10 })), 100,
      'an intentionally skipped oversized file does not prevent completion');
  });
});

describe('where the preload is reachable', () => {
  test('the settings modal still has its row (in-match management)', () => {
    const settings = read('public/js/ui/settings.js');
    assert.match(settings, /import \{ ResourceRow \} from '\.\/resourcePanel\.js';/);
    assert.match(settings, /<\$\{ResourceRow\} enabled=\$\{s\.preload\} onChange=\$\{\(v\) => updateSettings\(\{ preload: v \}\)\} \/>/);
  });

  test('the title screen mounts the launcher in its bottom-right corner', () => {
    const title = read('public/js/screens/title.js');
    assert.match(title, /import \{ ResourceLauncher \} from '\.\.\/ui\/resourcePanel\.js';/);
    assert.match(title, /import \{ useSettings, updateSettings \} from '\.\.\/ui\/settings\.js';/);
    assert.match(title, /const settings = useSettings\(\);/);
    assert.match(title, /<div class="title-preload"><\$\{ResourceLauncher\} enabled=\$\{settings\.preload\} onChange=\$\{\(v\) => updateSettings\(\{ preload: v \}\)\} \/><\/div>/);
    const css = read('public/css/screens/title.css');
    assert.match(css, /\.title-preload \{[^}]*position: absolute;[^}]*right: \.44rem;[^}]*bottom: \.86rem;/, 'bottom-right, above the footer');
    assert.match(css, /\.res-pill \{/, 'the pill has its own styling');
  });

  test('both entry points open the shared manager with resource tiers and ZIP actions', () => {
    const panel = read('public/js/ui/resourcePanel.js');
    assert.equal((panel.match(/onClick=\$\{openResources\}/g) || []).length, 2);
    const main = read('public/js/main.js');
    assert.match(main, /<\$\{ResourceManagerHost\} \/>/);
    assert.match(panel, /title=\$\{t\('预载资源管理'\)\}/);
    assert.match(panel, /tier=\$\{1\}/);
    assert.match(panel, /tier=\$\{2\}/);
    assert.match(panel, /导入 ZIP/);
    assert.match(panel, /导出 ZIP/);
    assert.match(panel, /importResources\(file, \{ onImported: \(\) => onChange\(true\) \}\)/,
      'successful imports persist the preload switch through the application settings callback');
    assert.match(panel, /st\.worker/);
    assert.match(panel, /onChange\(false\)/);
    assert.equal(/可离线进入对局|断网[^。]*可用/.test(panel), false);
  });
});

/**
 * 干员皮肤 in the manager (docs/SKINS.md): a master switch plus an explicit 全部皮肤 one next to the required/optional
 * tiers — the outfit choice itself lives in 干员调配, and equipping one there is what starts its download.
 */
describe('the 干员皮肤 scope', () => {
  const panel = read('public/js/ui/resourcePanel.js');

  test('two switches, no list', () => {
    assert.ok(panel.includes("g.tier === tier && g.id !== 'skin'"), 'the 可选资源 list skips the skin group');
    assert.match(panel, /<\$\{ResourceSkins\} st=\$\{st\}/, 'the section is rendered by the manager');
    assert.match(panel, /if \(!skins\.length\) return null;/, 'a deployment without skins installed shows nothing');
    assert.ok(panel.includes('data-testid="skin-preload"'));
    assert.ok(panel.includes("t('预载干员皮肤')"));
    assert.ok(panel.includes('data-testid="skin-preload-all"'));
    assert.ok(panel.includes("t('全部皮肤（{total} 套）', { total: skins.length })"), '全部皮肤 names how many outfits it means');
    assert.ok(panel.includes('本机已选 {n} 套 · 已缓存 {done} 套'));
    assert.ok(panel.includes('全部 {n} 套 · 已缓存 {done} 套'));
    assert.ok(panel.includes("t('还没选过皮肤：在干员调配里挑一套，这里会跟着缓存。')"));
    assert.ok(panel.includes("t('全部皮肤：{total} 套都会缓存，不再跟随干员调配里的选择。', { total: skins.length })"));
    assert.ok(panel.includes('const everyOutfit = !!(on && all);'), 'both switches decide the scope');
    assert.equal(/resource-skins__rows|SkinList|跟随我的皮肤选择|全选/.test(panel), false, 'no per-outfit list here');
  });

  test('the switches are settings flags, and the keys come from the equipped outfits', () => {
    const main = read('public/js/main.js');
    assert.match(main, /skinPreload=\$\{settings\.preloadSkins\}/);
    assert.match(main, /onSkinPreload=\$\{\(v\) => updateSettings\(\{ preloadSkins: v \}\)\}/);
    assert.match(main, /skinPreloadAll=\$\{settings\.preloadSkinsAll\}/);
    assert.match(main, /onSkinPreloadAll=\$\{\(v\) => updateSettings\(\{ preloadSkinsAll: v \}\)\}/);
    // Equipping a skin in 干员调配 must re-apply the scope: nothing else announces that change.
    assert.match(main, /const keys = s\.preloadSkins \? equippedSkinKeys\(\) : \[\];/);
    assert.match(main, /const all = !!\(s\.preloadSkins && s\.preloadSkinsAll\);/);
    assert.match(main, /r\.syncResources\(s\.preload, s\.preloadOptional, s\.voiceLang, s\.preloadAllVoices, \{ keys, all \}\)/);
    assert.match(main, /skinsStore\.subscribe\(\(\) => apply\(settingsStore\.get\(\)\)\)/);
    const skins = read('public/js/ui/skins.js');
    assert.match(skins, /export function equippedSkinKeys\(\)/);
    assert.match(skins, /charId = data\.lookup\('chess', chessId\)\?\.charId/);
    const settings = read('public/js/ui/gameLogic/settings.js');
    assert.ok(settings.includes('preloadSkins: false, preloadSkinsAll: false,'));
    assert.equal(/preloadSkinIds/.test(settings), false, 'a boolean switch needs no id list');
  });
});
