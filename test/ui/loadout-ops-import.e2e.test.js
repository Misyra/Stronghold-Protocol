// Real-server imports of files downloaded through the loadout UI. Only backups.json's response is controlled:
// missing data must not turn a valid mixed cultivation preset into a partial replacement. No preference injection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client, OUT, sleep, hasChrome, startRealServer } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome();
const INSIDE = 'chess_char_1_01_a';
const SIEGE = 'char_112_siege';
const SLOT = 'chess_char_5_diy1_a';
const MODAL = '.modal';
const IMPORT = '[data-testid="loadout-import"]';
const APPLY = '[data-testid="loadout-io-apply"]';
const TEXT = '[data-testid="loadout-io-text"]';

const stored = (c) => c.page.evaluate(() => ({
  loadout: localStorage.getItem('sp.pref.loadout'), diy: localStorage.getItem('sp.pref.diy'),
}));
const closeModal = async (c) => {
  await c.click(`${MODAL} button`, '关闭');
  await c.page.waitForSelector(MODAL, { hidden: true });
};
async function openLoadout(c) {
  await c.page.waitForSelector('.lobby-screen');
  await c.click('.lobby-screen [data-testid="loadout-open"]');
  await c.page.waitForSelector(`.lo-card[data-chess="${INSIDE}"]`);
}
async function ordinary(c, potential, cultivate) {
  const row = `.lo-card[data-chess="${INSIDE}"]`;
  await c.page.select(`${row} [data-cult="potential"]`, String(potential));
  await c.page.select(`${row} [data-cult="cultivate"]`, String(cultivate));
}
async function selfSelected(c, potential, cultivate) {
  const row = `.diy-slot[data-slot="${SLOT}"]`;
  await c.page.select(`${row} [data-cult="potential"]`, String(potential));
  await c.page.select(`${row} [data-cult="cultivate"]`, String(cultivate));
}
async function chooseSiege(c) {
  await c.click('.lo-tab[data-tab="diy"]');
  await c.click(`.diy-slot[data-slot="${SLOT}"] .diy-slot__fill`);
  await c.page.waitForSelector('[data-testid="diy-picker"]');
  const operator = `[data-testid="diy-picker"] .diy-opt[data-char="${SIEGE}"]`;
  await c.page.$eval(operator, (e) => e.scrollIntoView({ block: 'nearest' }));
  await c.page.click(operator);
  await c.click('[data-testid="diy-confirm"]');
  await c.page.waitForSelector('[data-testid="diy-picker"]', { hidden: true });
}
async function download(c, dir) {
  await c.click('[data-testid="loadout-export"]');
  await c.page.waitForSelector(TEXT);
  const payload = await c.page.$eval(TEXT, (e) => e.value);
  const session = await c.page.createCDPSession();
  await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
  await c.click('[data-testid="loadout-io-download"]');
  let file;
  for (let i = 0; i < 100; i++) {
    file = readdirSync(dir).find((f) => f.endsWith('.json'));
    if (file) break;
    await sleep(50);
  }
  assert.ok(file, 'the UI downloaded the preset');
  file = path.join(dir, file);
  assert.equal(readFileSync(file, 'utf8'), payload);
  await closeModal(c);
  await session.detach();
  return { file, payload: JSON.parse(payload) };
}
async function upload(c, file) {
  await c.click(IMPORT);
  const chooser = c.page.waitForFileChooser();
  await c.click('[data-testid="loadout-io-pick"]');
  await (await chooser).accept([file]);
  await c.page.waitForFunction((s) => !!document.querySelector(s)?.value.trim(), {}, TEXT);
}
async function fixture(prefix) {
  const srv = await startRealServer();
  const P = (await import('puppeteer-core')).default;
  const c = new Client(P, srv.base, prefix, { prefix, w: 1280, h: 720 });
  mkdirSync(OUT, { recursive: true });
  const dir = mkdtempSync(path.join(OUT, `${prefix}-`));
  try {
    await c.open();
    await c.enter('调配导入回归');
    await openLoadout(c);
    await c.click(`.lo-card[data-chess="${INSIDE}"] [data-skill="0"]`);
    return { c, srv, dir };
  } catch (error) {
    await c.close();
    await srv.stop();
    throw error;
  }
}

test('mixed cultivation file: failed backups preserves existing data; reload and retry imports the whole file',
  { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome)', timeout: 90000 }, async () => {
    const { c, srv, dir } = await fixture('loadout-ops-missing');
    const records = {};
    let failBackups = false;
    try {
      await ordinary(c, 2, 1);
      await chooseSiege(c);
      await selfSelected(c, 3, 0);
      await c.click('.lo-tab[data-tab="loadout"]');
      const { file, payload } = await download(c, dir);
      records.exported = payload;
      await ordinary(c, 4, 2);
      await c.click(`.lo-card[data-chess="${INSIDE}"] [data-module="none"]`);
      await c.click('.lo-tab[data-tab="diy"]');
      await selfSelected(c, 5, 2);
      records.before = await stored(c);
      await c.page.setRequestInterception(true);
      c.page.on('request', (r) => failBackups && new URL(r.url()).pathname === '/data/backups.json'
        ? r.respond({ status: 404, contentType: 'text/plain', body: 'Simulated backups.json failure' }) : r.continue());
      failBackups = true;
      await c.page.reload({ waitUntil: 'domcontentloaded' });
      await openLoadout(c);
      await upload(c, file);
      await c.click(APPLY);
      await sleep(100);
      records.failedImport = await stored(c);
      records.failureUi = await c.page.evaluate(() => ({
        modal: !!document.querySelector('.modal'), text: document.body.innerText,
      }));
      await c.shot('failed-import');
      assert.deepEqual(records.failedImport, records.before, 'failed validation data must not replace saved entries or ops');
      assert.equal(records.failureUi.modal, true, 'the import stays open for retry');
      assert.match(records.failureUi.text, /导入失败：游戏数据没有载入，未做任何改动/);
      failBackups = false;
      await c.page.reload({ waitUntil: 'domcontentloaded' });
      await openLoadout(c);
      assert.deepEqual(await stored(c), records.before, 'the refusal also survives reload');
      await upload(c, file);
      await c.click(APPLY);
      await c.page.waitForSelector(MODAL, { hidden: true });
      records.retried = await stored(c);
      const applied = JSON.parse(records.retried.loadout);
      assert.deepEqual(applied.entries, payload.entries);
      assert.deepEqual(applied.ops, payload.ops, 'both ordinary and self-selected settings survive');
      assert.equal(records.retried.diy, records.before.diy, 'loadout import never replaces DIY picks');
      await c.click('.lo-tab[data-tab="diy"]');
      await c.shot('retried-self-selected');
      assert.deepEqual(c.problems.filter((p) => p.startsWith('pageerror:')), []);
    } finally {
      writeFileSync(path.join(dir, 'observations.json'), JSON.stringify({ ...records, problems: c.problems }, null, 2));
      console.log(JSON.stringify({ evidence: dir, before: records.before, after: records.failedImport, retried: records.retried,
        modal: records.failureUi?.modal, problemCount: c.problems.length,
        pageErrors: c.problems.filter((p) => p.startsWith('pageerror:')) }));
      await c.close();
      await srv.stop();
    }
  });

test('pending backups keeps import disabled until its real response arrives',
  { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome)', timeout: 90000 }, async () => {
    const { c, srv, dir } = await fixture('loadout-ops-loading');
    let held;
    try {
      await ordinary(c, 2, 1);
      await chooseSiege(c);
      await selfSelected(c, 3, 0);
      await c.click('.lo-tab[data-tab="loadout"]');
      const { file, payload } = await download(c, dir);
      const before = await stored(c);
      await c.page.setRequestInterception(true);
      c.page.on('request', (r) => {
        if (new URL(r.url()).pathname === '/data/backups.json') held = r;
        else r.continue();
      });
      await c.page.reload({ waitUntil: 'domcontentloaded' });
      await c.page.waitForSelector('.lobby-screen');
      await c.click('.lobby-screen [data-testid="loadout-open"]');
      await c.page.waitForSelector('.lo-loading');
      assert.equal(await c.page.$eval(IMPORT, (e) => e.disabled), true);
      assert.deepEqual(await stored(c), before);
      for (let i = 0; !held && i < 100; i++) await sleep(50);
      assert.ok(held, 'backups is still in flight');
      await held.continue();
      held = null;
      await c.page.waitForSelector(`.lo-card[data-chess="${INSIDE}"]`);
      assert.equal(await c.page.$eval(IMPORT, (e) => e.disabled), false);
      await upload(c, file);
      await c.click(APPLY);
      await c.page.waitForSelector(MODAL, { hidden: true });
      const after = await stored(c);
      assert.deepEqual(JSON.parse(after.loadout).ops, payload.ops);
      assert.deepEqual(c.problems.filter((p) => p.startsWith('pageerror:')), []);
      writeFileSync(path.join(dir, 'observations.json'), JSON.stringify({ before, after, payload, problems: c.problems }, null, 2));
    } finally {
      if (held) await held.abort().catch(() => {});
      await c.close();
      await srv.stop();
    }
  });

test('an exported empty ops map also needs backups before replacing existing cultivation settings',
  { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome)', timeout: 90000 }, async () => {
    const { c, srv, dir } = await fixture('loadout-ops-empty');
    try {
      const { file, payload } = await download(c, dir);
      assert.deepEqual(payload.ops, {});
      await chooseSiege(c);
      await selfSelected(c, 2, 1);
      const before = await stored(c);
      await c.page.setRequestInterception(true);
      c.page.on('request', (r) => new URL(r.url()).pathname === '/data/backups.json'
        ? r.respond({ status: 404, contentType: 'text/plain', body: 'Simulated backups.json failure' }) : r.continue());
      await c.page.reload({ waitUntil: 'domcontentloaded' });
      await openLoadout(c);
      await upload(c, file);
      await c.click(APPLY);
      await sleep(100);
      const after = await stored(c);
      writeFileSync(path.join(dir, 'observations.json'), JSON.stringify({ before, after, payload, problems: c.problems }, null, 2));
      await c.shot('failed-import');
      assert.deepEqual(after, before);
      assert.ok(await c.page.$(MODAL));
      assert.deepEqual(c.problems.filter((p) => p.startsWith('pageerror:')), []);
    } finally {
      await c.close();
      await srv.stop();
    }
  });
