import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../server/index.js';
import { StubMatch } from '../../server/match/StubMatch.js';
import { Client, hasChrome } from '../e2e/client.mjs';

test('real browser: hidden when disabled, Unicode limit, IME Enter, masked send, mute countdown and reconnect', {
  skip: process.env.SP_E2E !== '1' || !hasChrome(), timeout: 60000,
}, async t => {
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, chatEnabled: true, workers: 0, MatchClass: StubMatch });
  t.after(() => server.close());
  const puppeteer = (await import('puppeteer-core')).default;
  const c = new Client(puppeteer, server.url, 'chat-ui', { prefix: 'chat-ui' });
  t.after(() => c.close()); await c.open();
  const errors = []; c.page.on('pageerror', e => errors.push(e.message));
  await c.page.$eval('.title-login input', el => { el.value = '博士甲'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await c.click('.title-login button', '开始');
  await c.page.waitForFunction(() => globalThis.__SP__.store.get().connection.status === 'online');
  await c.page.evaluate(async () => {
    const { net } = globalThis.__SP__;
    await net.request('room.create', { mode: 'solo', difficulty: 'NORMAL' });
    await net.request('room.start', {});
    const { render } = await import('/vendor/preact.module.js');
    const { html } = await import('/js/ui/components.js');
    const { ChatPanel } = await import('/js/ui/chat.js');
    const mount = document.createElement('div'); mount.id = 'chat-fixture'; mount.style.cssText = 'position:fixed;top:0;left:0;z-index:9999';
    document.body.append(mount); render(html`<${ChatPanel} />`, mount);
  });
  await c.page.waitForSelector('#chat-fixture .gm__chat');
  await c.page.click('#chat-fixture .gm__chat');
  const input = '[aria-label="聊天消息"]';
  const fill = value => c.page.$eval(input, (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  await fill('😀'.repeat(31));
  assert.equal(await c.page.$eval('#chat-fixture [type="submit"]', el => el.disabled), true);
  await fill('😀'.repeat(30));
  assert.equal(await c.page.$eval('#chat-fixture [type="submit"]', el => el.disabled), false);
  const prevented = await c.page.$eval(input, el => !el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
  assert.equal(prevented, true);
  let now = Date.now(); server.lobby.now = () => now;
  const abuse = Buffer.from('ZnVjaw==', 'base64').toString();
  await fill(`你好 ${abuse}`); await c.page.click('#chat-fixture [type="submit"]');
  await c.page.waitForFunction(() => document.querySelector('#chat-fixture [role="log"]').textContent.includes('你好 ****'));
  assert.ok(!(await c.page.$eval('#chat-fixture [role="log"]', el => el.textContent)).includes(abuse));
  for (let i = 0; i < 4; i++) {
    now += 1100;
    await c.page.evaluate(text => globalThis.__SP__.net.request('g.chat', { text }), abuse);
  }
  await c.page.waitForFunction(() => document.querySelector('#chat-fixture [role="status"]').textContent.includes('聊天已暂停'));
  assert.equal(await c.page.$eval(input, el => el.disabled), true);
  const token = await c.page.evaluate(() => globalThis.__SP__.store.get().me.token);
  assert.ok(server.registry.byToken(token).chatMutedUntil > now);
  await c.page.evaluate(async () => { await globalThis.__SP__.net.request('state.resync'); });
  await c.page.waitForFunction(() => globalThis.__SP__.store.get().chat.messages.length === 5);
  await c.page.keyboard.press('Escape');
  await c.page.waitForFunction(() => !document.querySelector('#chat-fixture [role="dialog"]'));
  await c.page.evaluate(() => globalThis.__SP__.store.patch('chat', { enabled: false }));
  await c.page.waitForFunction(() => !document.querySelector('#chat-fixture .gm__chat'));
  assert.deepEqual(errors, []);
});

test('chat button is in the actual in-match toolbar and follows the server feature flag', {
  skip: process.env.SP_E2E !== '1' || !hasChrome(), timeout: 60000,
}, async t => {
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0 });
  t.after(() => server.close());
  const puppeteer = (await import('puppeteer-core')).default;
  const c = new Client(puppeteer, server.url, 'chat-toolbar', { prefix: 'chat-toolbar' });
  t.after(() => c.close()); await c.open();
  await c.page.goto(server.url + '/dev/game-mock.html?phase=PREP', { waitUntil: 'domcontentloaded' });
  await c.page.waitForFunction(() => globalThis.__MOCK__?.store && document.querySelector('.gm__corner'));
  assert.equal(await c.page.$('.gm__corner .gm__chat'), null);
  await c.page.evaluate(() => globalThis.__MOCK__.store.patch('chat', { enabled: true }));
  await c.page.waitForSelector('.gm__corner .gm__chat');
  await c.page.click('.gm__corner .gm__chat');
  await c.page.waitForSelector('[aria-label="聊天消息"]');
  await c.page.keyboard.type('rfd ');
  assert.equal(await c.page.$eval('[aria-label="聊天消息"]', el => el.value), 'rfd ');
  await c.page.screenshot({ path: 'test/e2e/out/chat-toolbar.png' });
});
