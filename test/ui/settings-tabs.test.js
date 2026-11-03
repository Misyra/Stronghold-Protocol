// test/ui/settings-tabs.test.js — 设置页签 (public/js/ui/settings.js, 2026-11-03): the settings used to be one long
// list (27 sections in a 7.4rem modal); they now live in six tabs — 音频 / 显示 / 操作 / 画面 / 插件 / 数据. The last
// tab is remembered (`sp.pref.settingsTab`), the bar sticks to the top of the modal body, and a phone scrolls it
// sideways. This file pins the tab order, each panel's id / role / hidden wiring, the rows each tab owns, and the CSS
// the bar needs. The rows' behaviour stays covered by the other settings tests; the browser suites select the tab
// first (settings-storage → 数据, wake-lock → 画面, modal's hotkey test → 操作).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = readFileSync(path.join(ROOT, 'public/js/ui/settings.js'), 'utf8');
const css = readFileSync(path.join(ROOT, 'public/css/screens/game.css'), 'utf8');
const TABS = ['audio', 'display', 'controls', 'visual', 'plugins', 'data'];

/** The source slice of one panel, from its `data-tab-panel="<id>"` to the next panel's marker. */
function panelOf(id) {
  const start = src.indexOf(`data-tab-panel="${id}"`);
  assert.ok(start > 0, `the ${id} panel exists`);
  const nextAt = TABS.slice(TABS.indexOf(id) + 1)
    .map((x) => src.indexOf(`data-tab-panel="${x}"`))
    .filter((x) => x > 0)
    .sort((a, b) => a - b)[0];
  return src.slice(start, nextAt ?? src.length);
}

test('six tabs in order, each with its Latin micro label', () => {
  const block = src.slice(src.indexOf('const SETTINGS_TABS = ['), src.indexOf('];', src.indexOf('const SETTINGS_TABS = [')));
  assert.deepEqual([...block.matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]), TABS);
  for (const id of TABS) assert.ok(block.includes(`micro: '${id.toUpperCase()}'`), `${id}: micro label`);
});

test('the tablist and every tabpanel are wired by id, aria and hidden', () => {
  assert.match(src, /role="tablist"/);
  assert.match(src, /role="tab"/);
  assert.match(src, /aria-selected=\$\{tab === x\.id \? 'true' : 'false'\}/);
  assert.ok(src.includes('aria-controls='), 'tabs point at their panel');
  for (const id of TABS) {
    assert.ok(src.includes(`id="set-panel-${id}"`), `${id}: panel id`);
    assert.ok(src.includes(`aria-labelledby="set-tab-${id}"`), `${id}: aria-labelledby`);
    assert.ok(src.includes(`hidden=\${tab !== '${id}'}`), `${id}: hidden unless active`);
  }
});

test('each tab owns its rows', () => {
  const audio = panelOf('audio');
  for (const s of ["t('背景音乐')", "t('干员语音')", "t('语音语言')", "t('音效')", "t('静音')", '<${MatchMusicSection}']) assert.ok(audio.includes(s), `音频: ${s}`);
  const display = panelOf('display');
  for (const s of ["t('语言')", "t('文字大小')", "t('显示伤害数字')", "t('官方伤害数字')", "t('显示弹药与能量数量')", "t('盟约效果剩余时间')", "t('作战统计')", '<${LangToggle}']) assert.ok(display.includes(s), `显示: ${s}`);
  const controls = panelOf('controls');
  for (const s of ["t('部署时收起商店')", "t('部署时按格子吸附')", '<${HotkeySection}']) assert.ok(controls.includes(s), `操作: ${s}`);
  const visual = panelOf('visual');
  for (const s of ["t('画面质量')", "t('帧率上限')", "t('官方特效')", "t('全屏时保持屏幕常亮')", '<${ResourceRow}', '<${ScreenFitSection}']) assert.ok(visual.includes(s), `画面: ${s}`);
  const plugins = panelOf('plugins');
  for (const s of ['<${CosmeticSection}', '<${UiPluginSection}']) assert.ok(plugins.includes(s), `插件: ${s}`);
  const data = panelOf('data');
  for (const s of ['<${ConfigTransferSection}', '<${StorageSection}', '<${DiagSection}']) assert.ok(data.includes(s), `数据: ${s}`);
});

test('the last tab is remembered in localStorage', () => {
  assert.match(src, /const SETTINGS_TAB_KEY = 'sp\.pref\.settingsTab'/);
  assert.match(src, /function storedSettingsTab\(\)/);
  assert.match(src, /function saveSettingsTab\(id\)/);
  assert.match(src, /setTab\(id\); saveSettingsTab\(id\)/);
});

test('the bar sticks and a phone scrolls it sideways', () => {
  assert.match(css, /\.set-tabs \{[^}]*position: sticky; top: 0;/s);
  assert.match(css, /\.set-tabs \{[^}]*overflow-x: auto;/s);
  assert.match(css, /\.set-tabs::-webkit-scrollbar \{ display: none; \}/);
  assert.match(css, /\.set-panel\[hidden\] \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 767px\) \{ \.set-tab \{/);
});
