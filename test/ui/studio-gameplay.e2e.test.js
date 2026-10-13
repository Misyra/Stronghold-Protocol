// SP_E2E=1, run this file alone. Requires a listening socket and headless Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHROME, OUT, hasChrome } from '../e2e/client.mjs';
const enabled = process.env.SP_E2E === '1' && hasChrome();

test('operator wizard -> borrowed official kit -> saved attributes -> trial -> game-renderer replay and comparison', { skip: !enabled, timeout: 180000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-gameplay-e2e-'));
  const { startServer } = await import('../../server/index.js');
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, pluginsDir: path.join(tmp, 'plugins'), assetIndex: false });
  const P = (await import('puppeteer-core')).default;
  const browser = await P.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--mute-audio'] });
  const errors = [];
  try {
    const page = await browser.newPage(); await page.setViewport({ width: 1600, height: 1000 });
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(srv.studio.pageUrl(srv.url), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__studio?.ready);
    await page.click('[data-testid="new-plugin"]'); await page.click('[data-template="operator"]');
    await page.type('[data-testid="target-search"]', '德克萨斯');
    await page.waitForSelector('[data-target="operator:char_102_texas"]'); await page.click('[data-target="operator:char_102_texas"]');
    await page.waitForFunction(() => /^[a-z0-9][a-z0-9-]{1,31}$/.test(document.querySelector('[data-testid="create-id"]')?.value || ''));
    await page.click('[data-testid="create-confirm"]');
    await page.waitForSelector('[data-testid="operator-wizard"]');
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="operator-wizard"] details[open] .st-stat-grid label:nth-child(2) input')?.value) > 0);
    const made = await page.evaluate(() => globalThis.__studio.state);
    assert.equal(made.check.ok, true);
    const record = JSON.parse(fs.readFileSync(path.join(tmp, 'plugins', made.id, 'data/operator.json')));
    assert.equal(record.kit.ref, 'chess_char_1_08_a');
    assert.match(record.charId, /^char_x_/);
    const atk = '[data-testid="operator-wizard"] details[open] .st-stat-grid label:nth-child(2) input';
    await page.waitForSelector(atk); await page.click(atk, { clickCount: 3 }); await page.type(atk, '900');
    await page.click('[data-testid="save-wizard"]');
    await page.waitForFunction(() => globalThis.__studio?.state?.authoring?.options?.normal?.atk === 900);
    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, 'studio-gameplay-operator.png'), fullPage: true });
    await page.click('[data-tab="trial"]'); await page.click('[data-testid="run-trial"]');
    await page.waitForSelector('[data-testid="trial-comparison"]', { timeout: 45000 });
    const result = await page.evaluate(() => globalThis.__studio.trial);
    assert.equal(result.ok, true); assert.ok(result.plugin.damage > result.vanilla.damage);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="trial-replay"]')].filter(e => e.dataset.ready === 'true').length === 2, { timeout: 45000 });
    assert.equal(await page.$$eval('[data-testid="trial-replay"] canvas', nodes => nodes.length), 2);
    await page.screenshot({ path: path.join(OUT, 'studio-gameplay-trial.png'), fullPage: true });
    // The UI wizard also uses the real game's frame host with fake data and opaque origin.
    const ui = await page.evaluate(async () => {
      const api = await import('/studio/js/api.js');
      return api.post('plugins', { template: 'ui', id: 'preview-widget', name: 'Preview', options: { slot: 'room.panel', title: 'Preview' } });
    });
    assert.equal(ui.check.ok, true);
    await page.goto(srv.studio.pageUrl(srv.url).replace('/studio/#', '/studio/?plugin=preview-widget#'), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="ui-sandbox-preview"] iframe');
    assert.equal(await page.$eval('[data-testid="ui-sandbox-preview"] iframe', e => e.getAttribute('sandbox')), 'allow-scripts');
    await page.waitForFunction(() => globalThis.__SP_UI_PLUGINS__?.last?.t === 'battle', { timeout: 10000 });
    await page.screenshot({ path: path.join(OUT, 'studio-gameplay-widget.png'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await srv.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
});
