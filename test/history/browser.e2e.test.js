// HISTORY_E2E=1 CHROME_PATH=... node --test test/history/browser.e2e.test.js
// Uses real IndexedDB and the actual app/WebSocket settlement handler; no production match needs to be played.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer } from '../../server/index.js';
import { Match } from '../../server/match/Match.js';

const chrome = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const enabled = process.env.HISTORY_E2E === '1' && fs.existsSync(chrome);
class SettlementFixture extends Match {
  start() {
    super.start();
    const player = this.players.values().next().value;
    player.stats.dmgDealt = 321;
    player.board.set('3,2', { uid: 'history-fixture', kind: 'chess', id: 'char_008_amiya',
      items: [{ id: 'equip_iron' }] });
    this.later(100, () => this.finish({ victory: true }));
  }
}
describe('local match history in Chrome', { skip: enabled ? false : 'set HISTORY_E2E=1 (needs Chrome/Edge)' }, () => {
  let srv, browser, page, base;
  const errors = [];
  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, store: null,
      MatchClass: SettlementFixture, log: { info() {}, warn() {}, error() {}, debug() {} } });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await (await import('puppeteer-core')).default.launch({ executablePath: chrome, headless: true, args: ['--no-first-run'] });
    page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on('request', (r) => r.url().startsWith(base) || r.url().startsWith('data:') ? r.continue() : r.abort());
    await page.setViewport({ width: 1366, height: 768 });
    await page.goto(base);
    await page.waitForFunction('!!window.__SP__');
    await page.type('.title-login input', '战绩测试');
    await page.evaluate(() => [...document.querySelectorAll('.title-login button')].find((b) => b.textContent.trim() === '开始').click());
    await page.waitForFunction('window.__SP__.net.status === "online"');
  });
  after(async () => { await browser?.close(); await srv?.close(); });
  const list = () => page.evaluate(async () => (await import('/js/history/index.js')).historyStorage.list());

  test('a real WebSocket result automatically saves the participant report and the UI shows its details', async () => {
    await page.evaluate(async () => {
      const { net, store } = window.__SP__;
      store.patch('session', { entered: true });
      await net.request('room.create', { mode: 'solo', difficulty: 'NORMAL' });
      await net.request('room.start');
    });
    await page.waitForFunction(async () => (await import('/js/history/index.js')).historyStore.get().saveState === 'saved');
    const records = await list();
    assert.equal(records.length, 1);
    assert.equal(records[0].result.players[0].stats.dmgDealt, 321);
    assert.deepEqual(records[0].result.players[0].lineup[0].items, ['equip_iron']);
    assert.equal(records[0].result.players[0].lineup[0].row, 3);
    assert.ok(records[0].result.matchId);
    assert.equal(records[0].appVersion, '0.1.3');
    await page.waitForSelector('.result .history-btn');
    assert.match(await page.$eval('.history-save', (el) => el.textContent), /已保存/);
    await page.click('.result .history-btn');
    await page.waitForSelector('.history-entry');
    await page.click('.history-entry');
    await page.waitForSelector('.history-detail .rcard');
    assert.match(await page.$eval('.history-detail', (el) => el.textContent), /321/);
    assert.deepEqual(errors, []);
    await page.evaluate(() => Promise.all(document.querySelector('.history-panel').getAnimations({ subtree: true })
      .filter((a) => a.effect.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
    await page.screenshot({ path: '.cache/perf/history-detail.png' });
    // Small landscape devices: no card or action should escape the dialog horizontally.
    await page.setViewport({ width: 844, height: 390 });
    const layout = await page.evaluate(() => {
      const box = document.querySelector('.history-panel');
      const body = box.querySelector('.modal__body');
      return { width: body.clientWidth, scroll: body.scrollWidth, right: box.getBoundingClientRect().right, viewport: innerWidth };
    });
    assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout));
    assert.ok(layout.right <= layout.viewport, JSON.stringify(layout));
    await page.setViewport({ width: 1366, height: 768 });
  });
  test('reload preserves the record and reconnect replay does not duplicate it', async () => {
    await page.reload();
    await page.waitForFunction('!!window.__SP__ && window.__SP__.net.status === "online"');
    const before = await list();
    assert.equal(before.length, 1);
    await page.evaluate(async (r) => {
      const { recordMatchResult } = await import('/js/history/index.js');
      await recordMatchResult(r.result, r.playerId, { origin: location.origin, appVersion: r.appVersion });
    }, before[0]);
    assert.equal((await list()).length, 1);
    assert.equal((await list())[0].recordedAt, before[0].recordedAt);
  });
  test('concurrent writers retain only the newest 100 records and a duplicate is a single durable row', async () => {
    const count = await page.evaluate(async () => {
      const { createHistoryStorage } = await import('/js/history/storage.js');
      const a = createHistoryStorage({ name: 'history-concurrency-test' });
      const b = createHistoryStorage({ name: 'history-concurrency-test' });
      const rows = Array.from({ length: 110 }, (_, i) => ({ id: `r${i}`, endedAt: i, recordedAt: i, result: {} }));
      await Promise.all(rows.map((r, i) => (i % 2 ? a : b).add(r)));
      await Promise.all([a.add(rows[109]), b.add(rows[109])]);
      return (await a.list()).map((r) => r.id);
    });
    assert.equal(count.length, 100);
    assert.equal(count[0], 'r109');
    assert.equal(count.at(-1), 'r10');
  });
  test('other tabs are notified, deletion survives replay, and clear keeps records empty on replay', async () => {
    await page.evaluate(async () => (await import('/js/history/index.js')).openHistory());
    await page.waitForSelector('.history-entry');
    const second = await browser.newPage();
    try {
      await second.goto(base);
      await second.waitForFunction('!!window.__SP__');
      await second.evaluate(async () => {
        const { recordMatchResult } = await import('/js/history/index.js');
        const { historyStorage } = await import('/js/history/index.js');
        const r = (await historyStorage.list())[0];
        await recordMatchResult({ ...r.result, matchId: 'cross-tab', finishedAt: Date.now() }, r.playerId,
          { origin: location.origin, appVersion: r.appVersion });
      });
      await page.waitForFunction('document.querySelectorAll(".history-entry").length === 2');
      const rows = await list();
      await page.evaluate(async (r) => {
        const h = await import('/js/history/index.js');
        await h.removeHistory(r.id);
        await h.recordMatchResult(r.result, r.playerId, { origin: location.origin, appVersion: r.appVersion });
      }, rows[0]);
      assert.equal((await list()).length, 1);
      await page.evaluate(async (r) => {
        const h = await import('/js/history/index.js');
        await h.clearHistory();
        await h.recordMatchResult(r.result, r.playerId, { origin: location.origin, appVersion: r.appVersion });
      }, rows[1]);
      assert.equal((await list()).length, 0);
    } finally { await second.close(); }
    assert.deepEqual(errors, []);
  });
  test('storage failure leaves the match result available and keeps a visible reason after history refresh', async () => {
    const state = await page.evaluate(async () => {
      const h = await import('/js/history/index.js');
      const { store } = window.__SP__;
      const result = { ...store.get().match.result, matchId: 'quota-failure' };
      const original = h.historyStorage.add;
      h.historyStorage.add = async () => { throw new DOMException('测试：存储空间不足', 'QuotaExceededError'); };
      try {
        await h.recordMatchResult(result, store.get().me.playerId, { origin: location.origin });
        await h.refreshHistory();
        return { saved: h.historyStore.get().saveState, reason: h.historyStore.get().saveError,
          resultStillPresent: !!store.get().match.result };
      } finally { h.historyStorage.add = original; }
    });
    assert.equal(state.saved, 'error');
    assert.match(state.reason, /空间不足/);
    assert.equal(state.resultStillPresent, true);
    await page.waitForSelector('.history-error');
    assert.match(await page.$eval('.history-error', (e) => e.textContent), /空间不足/);
    assert.deepEqual(errors, []);
  });
});
