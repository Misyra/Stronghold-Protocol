// Real-server browser E2E — the plugin studio (DESIGN §32.9; opt-in, ~30 s):
//   SP_E2E=1 node --test test/ui/studio.e2e.test.js
//
// A server with a plugins folder of its own: the studio's page at /studio/ (headless Chrome) → 新建插件 → the template
// 换头像 / 立绘 / 图标 → the operator found by its official name (德克萨斯) → its plugin is made (loaded at once) → a PNG made
// on the spot (180 × 180, no file of the game) is dropped on the avatar slot → the preview draws it in the game's own card
// component (ui/gameComponents.js UnitThumb, the plugin side; the original beside it) → 打包并下载 writes the lock and
// downloads the zip, which holds the manifest, the lock and the picture. The same page through a public address — a
// tunnel or proxy on this machine forwarding a visitor — and through a foreign Host name is the 404 page. No console or
// page error.
//
// Screenshots: test/e2e/out/studio-*.png (and SP_STUDIO_SHOTS=<dir> copies them there for a report).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHROME, OUT, hasChrome, sleep } from '../e2e/client.mjs';
import { png } from '../helpers/pluginFixtures.js';
import { unzipFiles } from '../../server/plugins/zip.js';

const ENABLED = process.env.SP_E2E === '1' && hasChrome();

describe('the plugin studio in the browser', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome)' }, () => {
  test('new plugin from a template → an operator by its official name → a PNG dropped on its slot → previewed → packed into a zip; a public address is refused', { timeout: 3 * 60 * 1000 }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-studio-e2e-'));
    const plugins = path.join(tmp, 'plugins');
    const downloads = path.join(tmp, 'downloads');
    fs.mkdirSync(downloads);
    const { startServer } = await import('../../server/index.js');
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, pluginsDir: plugins, assetIndex: false });
    const P = (await import('puppeteer-core')).default;
    const browser = await P.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--no-first-run', '--force-device-scale-factor=1', '--mute-audio'] });
    const problems = [];
    const shots = [];
    fs.mkdirSync(OUT, { recursive: true });
    const shot = async (page, name) => {
      const file = path.join(OUT, `studio-${name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      shots.push(file);
    };
    try {
      // a public visitor (a tunnel or proxy on this machine forwards it) and a foreign Host name get the 404 page
      const pub = await fetch(`${srv.url}/studio/`, { headers: { 'x-forwarded-for': '203.0.113.50' } });
      assert.equal(pub.status, 404);
      assert.match(await pub.text(), /页面不存在 · Not found/);
      assert.equal((await fetch(`${srv.url}/studio/api/plugins`, { headers: { 'cf-connecting-ip': '198.51.100.7' } })).status, 404);

      const page = await browser.newPage();
      await page.setViewport({ width: 1600, height: 1000 });
      page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      page.on('requestfailed', (r) => { if (!/\/assets\/|\/fonts\//.test(r.url())) problems.push(`failed: ${r.url()} ${r.failure()?.errorText}`); });
      const cdp = await page.createCDPSession();
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

      await page.goto(`${srv.url}/studio/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => globalThis.__studio?.ready === true, { timeout: 30000 });
      await shot(page, 'start');
      // 新建插件 → the template → the operator by its official name → name and id → create
      await page.click('[data-testid="new-plugin"]');
      await page.waitForSelector('[data-template="art"]');
      await shot(page, 'templates');
      await page.click('[data-template="art"]');
      await page.waitForSelector('[data-testid="target-search"]');
      await page.type('[data-testid="target-search"]', '德克萨斯');
      await page.waitForSelector('[data-target="operator:char_102_texas"]', { timeout: 15000 });
      await shot(page, 'picker');
      await page.click('[data-target="operator:char_102_texas"]');
      await page.waitForSelector('[data-testid="create-id"]');
      await page.waitForFunction(() => /^[a-z0-9][a-z0-9-]{1,31}$/.test(document.querySelector('[data-testid="create-id"]')?.value || ''), { timeout: 10000 });
      const id = await page.$eval('[data-testid="create-id"]', (e) => e.value);
      assert.equal(id, 'texas-art', 'an id made from the operator and the template');
      await page.click('[data-testid="create-confirm"]');
      await page.waitForSelector(`.st-plugin[data-plugin="${id}"]`, { timeout: 15000 });
      await page.waitForFunction(() => /已载入/.test(document.querySelector('[data-testid="plugin-status"]')?.textContent || ''), { timeout: 15000 });
      assert.ok(fs.existsSync(path.join(plugins, id, 'plugin.json')));
      // a PNG made on the spot, dropped on the avatar slot (the slot's file input)
      const pic = path.join(tmp, 'red-avatar.png');
      fs.writeFileSync(pic, png(180, 180, [220, 30, 30, 255]));
      const input = await page.$('[data-slot="chars.char_102_texas.avatar"] [data-testid="slot-input"]');
      await input.uploadFile(pic);
      // the preview: the plugin side of the game's card component draws it (its pixels arrived: naturalWidth 180)
      await page.waitForFunction((pid) => {
        const img = document.querySelector('[data-testid="pair-thumb"] .st-pair__col.is-plugin img');
        return !!img && img.src.includes(`/studio/api/plugins/${pid}/f/`) && img.complete && img.naturalWidth === 180;
      }, { timeout: 20000 }, id);
      const orig = await page.$eval('[data-testid="pair-thumb"] .st-pair__col:not(.is-plugin) img', (e) => e.getAttribute('src'));
      assert.doesNotMatch(orig, /\/studio\//, 'the original beside it is the installation\'s');
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(plugins, id, 'plugin.json'), 'utf8')).assets, { chars: { char_102_texas: { avatar: 'art/char_102_texas/avatar.png' } } });
      await sleep(600);
      await shot(page, 'preview');
      // 打包并下载: the lock written, the zip downloaded
      await page.click('[data-testid="pack"]');
      await page.waitForSelector('[data-testid="pack-result"].is-ok', { timeout: 20000 });
      let zipFile = null;
      for (let i = 0; i < 100 && !zipFile; i++) {
        const f = fs.readdirSync(downloads).find((n) => n.endsWith('.zip'));
        if (f) zipFile = path.join(downloads, f);
        else await sleep(150);
      }
      assert.ok(zipFile, 'a zip was downloaded');
      assert.equal(path.basename(zipFile), `${id}-1.0.0.zip`);
      const names = unzipFiles(fs.readFileSync(zipFile)).map((e) => e.name);
      assert.deepEqual(names, [`${id}/README.md`, `${id}/art/char_102_texas/avatar.png`, `${id}/plugin.json`, `${id}/plugin.lock.json`]);
      await shot(page, 'packed');
      assert.deepEqual(problems, []);
      if (process.env.SP_STUDIO_SHOTS) {
        fs.mkdirSync(process.env.SP_STUDIO_SHOTS, { recursive: true });
        for (const f of shots) fs.copyFileSync(f, path.join(process.env.SP_STUDIO_SHOTS, path.basename(f)));
      }
    } finally {
      await browser.close().catch(() => {});
      await srv.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
