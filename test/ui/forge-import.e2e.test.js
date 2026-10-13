// Browser check for 从 Forge 包导入 (DESIGN §32.12). Opt-in:
//   SP_E2E=1 node --test test/ui/forge-import.e2e.test.js
// The sandbox this work package ran in could not open a browser, so this file was not executed (未运行).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, hasChrome } from '../e2e/client.mjs';
import { zipFiles } from '../../server/plugins/zip.js';

const ENABLED = process.env.SP_E2E === '1' && hasChrome();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIN = path.join(ROOT, 'test', 'fixtures', 'forge', 'skin-pack');

describe('Forge import in the studio page', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome); 未运行 in the WP-H sandbox' }, () => {
  test('open the dialog, preview a zip, confirm, and see the plugin in the list', { timeout: 120000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-forge-e2e-'));
    const plugins = path.join(tmp, 'plugins');
    fs.mkdirSync(plugins);
    const { startServer } = await import('../../server/index.js');
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, pluginsDir: plugins, assetIndex: false });
    const P = (await import('puppeteer-core')).default;
    const browser = await P.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--no-first-run'] });
    try {
      const files = [];
      const walk = (abs, rel) => {
        for (const name of fs.readdirSync(abs)) {
          const p = path.join(abs, name);
          const next = rel ? `${rel}/${name}` : name;
          if (fs.statSync(p).isDirectory()) walk(p, next);
          else files.push({ name: next, data: fs.readFileSync(p) });
        }
      };
      walk(SKIN, '');
      const zipPath = path.join(tmp, 'rose-skin.zip');
      fs.writeFileSync(zipPath, zipFiles(files));
      const page = await browser.newPage();
      await page.goto(`${srv.url}/studio/#key=${srv.studio.key}`, { waitUntil: 'networkidle0' });
      await page.waitForSelector('[data-testid="forge-import"]');
      await page.click('[data-testid="forge-import"]');
      await page.waitForSelector('[data-testid="forge-zip"]');
      const input = await page.$('[data-testid="forge-zip"]');
      await input.uploadFile(zipPath);
      await page.click('[data-testid="forge-preview"]');
      await page.waitForSelector('[data-testid="forge-report"]');
      const report = await page.$eval('[data-testid="forge-report"]', (el) => el.textContent);
      assert.match(report, /rose-skin/);
      await page.click('[data-testid="forge-confirm"]');
      await page.waitForSelector('[data-plugin="rose-skin"]');
      assert.ok(fs.existsSync(path.join(plugins, 'rose-skin', 'IMPORT-REPORT.md')));
    } finally {
      await browser.close();
      await srv.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
