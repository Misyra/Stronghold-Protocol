import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../../server/index.js';
import { StubMatch } from '../../server/match/StubMatch.js';
import { Client, hasChrome, sleep } from '../e2e/client.mjs';

test('real browser: hidden when disabled, Unicode limit, IME Enter, refused send, mute countdown and reconnect', {
  skip: process.env.SP_E2E !== '1' || !hasChrome(), timeout: 60000,
}, async t => {
  const chatLogDir = mkdtempSync(path.join(tmpdir(), 'sp-chat-browser-'));
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, chatEnabled: true, chatLogDir, workers: 0, MatchClass: StubMatch });
  t.after(async () => {
    await server.close();
    assert.equal(path.dirname(path.resolve(chatLogDir)), path.resolve(tmpdir()));
    assert.ok(path.basename(chatLogDir).startsWith('sp-chat-browser-'));
    rmSync(chatLogDir, { recursive: true, force: true });
  });
  const puppeteer = (await import('puppeteer-core')).default;
  const c = new Client(puppeteer, server.url, 'chat-ui', { prefix: 'chat-ui' });
  t.after(() => c.close()); await c.open();
  const errors = []; c.page.on('pageerror', e => errors.push(e.message));
  await c.page.evaluate(() => [...document.querySelectorAll('.fullscreen-prompt button')].find(b => b.textContent.includes('暂不'))?.click());
  await c.page.$eval('.title-login input', el => { el.value = '博士甲'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await c.page.waitForFunction(() => !document.querySelector('.title-login button.btn--primary').disabled);
  await c.click('.title-login button', '开始');
  await c.page.waitForFunction(() => globalThis.__SP__.store.get().connection.status === 'online');
  await c.page.evaluate(async () => {
    const { net } = globalThis.__SP__;
    await net.request('room.create', { mode: 'solo', difficulty: 'NORMAL' });
    await net.request('room.start', {});
    const { render } = await import('/vendor/preact.module.js');
    const { html } = await import('/js/ui/components.js');
    const { Communication } = await import('/js/ui/chat.js');
    const { useState } = await import('/vendor/hooks.module.js');
    function Probe() { const [open, setOpen] = useState(false); return html`<${Communication} open=${open} onToggle=${setOpen} />`; }
    const mount = document.createElement('div'); mount.id = 'chat-fixture'; mount.style.cssText = 'position:fixed;bottom:40px;left:40px;z-index:9999';
    document.body.append(mount); render(html`<${Probe} />`, mount);
  });
  await c.page.waitForSelector('#chat-fixture .ewheel__btn');
  await c.page.click('#chat-fixture .ewheel__btn');
  const input = '[aria-label="聊天消息"]';
  const fill = value => c.page.$eval(input, (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  await fill('😀'.repeat(31));
  assert.equal(await c.page.$eval(input, el => [...el.value].length), 30, 'normal input is truncated by Unicode code points');
  await c.page.$eval(input, el => { el.value = '😀'.repeat(31); el.dispatchEvent(new InputEvent('input', { isComposing: true, bubbles: true })); });
  assert.equal(await c.page.$eval('#chat-fixture [type="submit"]', el => el.disabled), true);
  await fill('😀'.repeat(30));
  assert.equal(await c.page.$eval('#chat-fixture [type="submit"]', el => el.disabled), false);
  const prevented = await c.page.$eval(input, el => !el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
  assert.equal(prevented, true);
  let now = Date.now(); server.lobby.now = () => now;
  const abuse = Buffer.from('ZnVjaw==', 'base64').toString();
  await fill(`你好 ${abuse}`); await c.page.focus(input); await c.page.keyboard.press('Enter');
  await c.page.waitForFunction(() => [...document.querySelectorAll('.toast__text')].some(el => el.textContent.includes('请文明交流')));
  await sleep(300);
  assert.ok(!(await c.page.evaluate(() => globalThis.__SP__.store.get().emotes.at(-1)?.text ?? '')).includes(abuse), 'a refused message never becomes a bubble');
  now += 1100;
  await c.page.evaluate(() => globalThis.__SP__.net.request('g.chat', { text: '队友好' }));
  await c.page.waitForFunction(() => globalThis.__SP__.store.get().emotes.at(-1)?.text === '队友好');
  for (let strike = 2; strike <= 4; strike++) {
    now += 1100;
    await c.page.evaluate(text => globalThis.__SP__.net.request('g.chat', { text }).catch(() => {}), abuse);
  }
  await c.page.waitForFunction(() => document.querySelector('#chat-fixture [role="status"]')?.textContent.includes('聊天已暂停'));
  assert.equal(await c.page.$eval(input, el => el.disabled), true);
  assert.equal(await c.page.$$eval('#chat-fixture .ewheel__item', els => els.every(el => !el.disabled)), true, 'chat mute does not disable emotes');
  const token = await c.page.evaluate(() => globalThis.__SP__.store.get().me.token);
  assert.ok(server.registry.byToken(token).chatMutedUntil > now);
  const bubbleSeq = await c.page.evaluate(() => globalThis.__SP__.store.get().emotes.at(-1).seq);
  await c.page.evaluate(async () => { await globalThis.__SP__.net.request('state.resync'); });
  await c.page.waitForFunction(() => globalThis.__SP__.store.get().chat.messages.length === 1);
  assert.equal(await c.page.evaluate(() => globalThis.__SP__.store.get().emotes.at(-1).seq), bubbleSeq, 'history resync does not replay bubbles');
  await c.page.keyboard.press('Escape');
  await c.page.waitForFunction(() => !document.querySelector('#chat-fixture [role="dialog"]'));
  await c.page.evaluate(() => globalThis.__SP__.store.patch('chat', { enabled: false }));
  await c.page.click('#chat-fixture .ewheel__btn');
  await c.page.waitForSelector('#chat-fixture .ewheel__item');
  assert.equal(await c.page.$('#chat-fixture input'), null, 'disabled server still offers emotes, without a chat input');
  assert.deepEqual(errors, []);
});

test('communication popup combines emotes and chat, preserves drafts, fits desktop and mobile, and follows the feature flag', {
  skip: process.env.SP_E2E !== '1' || !hasChrome(), timeout: 60000,
}, async t => {
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0 });
  t.after(() => server.close());
  const puppeteer = (await import('puppeteer-core')).default;
  const c = new Client(puppeteer, server.url, 'chat-toolbar', { prefix: 'chat-toolbar' });
  t.after(() => c.close()); await c.open();
  // Set touch emulation before navigation: changing it mid-test reloads the page and discards the open panel/draft.
  await c.page.setViewport({ width: 1600, height: 900, hasTouch: true });
  await c.page.goto(server.url + '/dev/game-mock.html?phase=PREP', { waitUntil: 'domcontentloaded' });
  await c.page.waitForFunction(() => globalThis.__MOCK__?.store && document.querySelector('.gm__corner'));
  assert.equal(await c.page.$('.gm__corner .gm__chat'), null);
  await c.page.click('.gm__corner .ewheel__btn');
  await c.page.waitForSelector('.gm__corner .ewheel__panel');
  assert.equal(await c.page.$('.gm__corner .ewheel__chat'), null, 'disabled chat does not hide emotes');
  for (const [width, height] of [[1600, 900], [960, 540], [1000, 600], [844, 390], [640, 360]]) {
    await c.page.setViewport({ width, height, hasTouch: true }); await sleep(500);
    const layout = await c.page.$eval('.ewheel__popup', el => {
      const popup = el.getBoundingClientRect(), panel = el.querySelector('.ewheel__panel').getBoundingClientRect();
      return {
        compact: Math.abs(popup.height - panel.height) < 1 && Math.abs(popup.top - panel.top) < 1,
        inside: popup.top >= 0 && popup.left >= 0 && popup.right <= innerWidth && popup.bottom <= innerHeight,
        noChat: !el.querySelector('input, form, .ewheel__chat'),
        clickable: [...el.querySelectorAll('.ewheel__item, .ewheel__dot')].every(e => {
          const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        }),
      };
    });
    assert.deepEqual(layout, { compact: true, inside: true, noChat: true, clickable: true });
    await c.page.screenshot({ path: `test/e2e/out/communication-disabled-${width}.png` });
  }
  await c.page.evaluate(() => globalThis.__MOCK__.store.patch('chat', { enabled: true }));
  await c.page.waitForSelector('.gm__corner .ewheel__chat input');
  assert.equal(await c.page.$eval('.ewheel__chat input', el => el.placeholder), '请文明交流');
  assert.equal(await c.page.$('.ewheel__chat-rules'), null, 'rules do not occupy a permanent row');
  assert.equal(await c.page.$$eval('.gm__corner [role="dialog"]', els => els.length), 1, 'one shared popup');
  assert.equal(await c.page.$$eval('.gm__corner .ewheel__item', els => els.length), 6, 'emotes and the input are visible together');
  assert.equal(await c.page.$('.gm__corner .gm__chat'), null, 'no separate chat button');
  await c.page.click('.ewheel__chat input');
  await c.page.keyboard.type('rfd ');
  const theme = await c.page.$eval('.ewheel__page', el => el.dataset.theme);
  await c.page.keyboard.press('ArrowLeft');
  assert.equal(await c.page.$eval('.ewheel__page', el => el.dataset.theme), theme, 'cursor arrows do not flip emote pages');
  assert.equal(await c.page.$eval('.ewheel__chat input', el => el.value), 'rfd ');
  for (const [width, height] of [[1600, 900], [960, 540], [1000, 600], [844, 390], [640, 360]]) {
    await c.page.setViewport({ width, height, hasTouch: true }); await sleep(500);
    const layout = await c.page.$eval('.ewheel__popup', el => {
      const box = el.getBoundingClientRect(), form = el.querySelector('form').getBoundingClientRect();
      const chat = el.querySelector('.ewheel__chat').getBoundingClientRect(), emotes = el.querySelector('.ewheel__viewport').getBoundingClientRect();
      return { inside: box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth,
        chatBelow: chat.top >= emotes.bottom,
        formInside: form.left >= box.left && form.right <= box.right,
        clickable: [...el.querySelectorAll('input, [type="submit"], .ewheel__chat-help, .ewheel__chat-close, .ewheel__chat-tab, .ewheel__item, .ewheel__dot, .ewheel__nav')].every(e => {
          const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        }) };
    });
    assert.deepEqual(layout, { inside: true, chatBelow: true, formInside: true, clickable: true });
    await c.page.screenshot({ path: `test/e2e/out/communication-${width}.png` });
    const heightBefore = await c.page.$eval('.ewheel__popup', el => el.getBoundingClientRect().height);
    await c.page.click('.ewheel__chat-help');
    await c.page.waitForSelector('.ewheel__chat-rules');
    assert.match(await c.page.$eval('.ewheel__chat-rules', el => el.textContent), /无法发送/);
    const help = await c.page.$eval('.ewheel__popup', el => {
      const tooltip = el.querySelector('.ewheel__chat-rules').getBoundingClientRect();
      const button = el.querySelector('[type="submit"]').getBoundingClientRect();
      const question = el.querySelector('.ewheel__chat-help').getBoundingClientRect();
      return { height: el.getBoundingClientRect().height,
        inside: tooltip.top >= 0 && tooltip.right <= innerWidth && tooltip.left >= 0,
        inToolbar: question.top < button.top && !!el.querySelector('.ewheel__chat-toolbar .ewheel__chat-help'),
        expanded: el.querySelector('.ewheel__chat-help').getAttribute('aria-expanded') };
    });
    assert.deepEqual(help, { height: heightBefore, inside: true, inToolbar: true, expanded: 'true' });
    await c.page.screenshot({ path: `test/e2e/out/communication-help-${width}.png` });
    await c.page.click('.ewheel__chat-help');
    await c.page.waitForFunction(() => !document.querySelector('.ewheel__chat-rules'));
  }
  // The server already retains the last 50 messages. Switching views must keep the input and panel height stable.
  await c.page.evaluate(() => {
    const s = globalThis.__MOCK__.store;
    s.patch('chat', { messages: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, playerId: s.get().me.playerId,
      name: '博士甲', text: i === 49 ? '<img src=x onerror=alert(1)>' : '队友集合，一起守住这一轮。'.repeat(2), at: Date.now() + i })) });
  });
  const emoteHeight = await c.page.$eval('.ewheel__popup', el => el.getBoundingClientRect().height);
  await (await c.page.$('.ewheel__popup')).screenshot({ path: 'test/e2e/out/chat-panel-mobile.png' });
  await c.page.click('.ewheel__chat-tab[aria-label="聊天记录"]');
  await c.page.waitForSelector('.ewheel__chat-history');
  assert.equal(await c.page.$('.ewheel__panel'), null);
  assert.equal(await c.page.$('.ewheel__chat-history img'), null, 'history renders escaped text');
  assert.equal(await c.page.$eval('.ewheel__chat input', el => el.value), 'rfd ', 'switching views preserves the draft');
  assert.ok(Math.abs(await c.page.$eval('.ewheel__popup', el => el.getBoundingClientRect().height) - emoteHeight) < 1);
  assert.equal(await c.page.$eval('.ewheel__chat-history', el => el.scrollHeight - el.scrollTop - el.clientHeight < 2), true, 'history opens at the latest message');
  await (await c.page.$('.ewheel__popup')).screenshot({ path: 'test/e2e/out/chat-history-mobile.png' });
  await c.page.$eval('.ewheel__chat-history', el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  await c.page.evaluate(() => {
    const s = globalThis.__MOCK__.store;
    s.patch('chat', { messages: [...s.get().chat.messages.slice(1), { id: 51, playerId: 'teammate', name: '博士乙', text: '收到', at: Date.now() }] });
  });
  await c.page.waitForFunction(() => document.querySelector('.ewheel__chat-history').textContent.includes('收到'));
  assert.equal(await c.page.$eval('.ewheel__chat-history', el => el.scrollTop), 0, 'new messages do not interrupt reading older history');
  await c.page.click('.ewheel__chat-tab[aria-label="表情"]');
  await c.page.waitForSelector('.ewheel__item');
  await c.page.keyboard.press('Escape');
  await c.page.waitForFunction(() => !document.querySelector('.ewheel__popup'));
  await c.page.click('.gm__corner .ewheel__btn');
  await c.page.waitForSelector('.ewheel__chat input');
  assert.equal(await c.page.$eval('.ewheel__chat input', el => el.value), 'rfd ', 'closing preserves the draft');
  await c.page.mouse.click(800, 20);
  await c.page.waitForFunction(() => !document.querySelector('.ewheel__popup'));
  // Actual game toolbar/team panel: 30-character messages wrap and use the sender's existing emote anchor.
  await c.page.evaluate(() => {
    const s = globalThis.__MOCK__.store;
    const playerId = s.get().match.public.players[0].playerId;
    s.set({ emotes: [{ seq: 1, playerId, text: '大家准备好了吗我们一起守住这一轮下一轮继续加油博士队友集合', at: Date.now() }] });
  });
  await c.page.waitForSelector('.team__bubble.ebubble--chat');
  const box = await c.page.$eval('.team__bubble.ebubble--chat', el => {
    const bubble = el.getBoundingClientRect(), avatar = el.closest('.team__row').querySelector('.team__btn').getBoundingClientRect();
    return { rightOfAvatar: bubble.left >= avatar.right, width: bubble.width, height: bubble.height, text: el.textContent.trim(), animation: getComputedStyle(el).animationName };
  });
  assert.equal(box.rightOfAvatar, true); assert.ok(box.height > 0 && box.width > 0);
  assert.match(box.animation, /emo-bubble-pop/);
  await c.page.screenshot({ path: 'test/e2e/out/chat-toolbar.png' });
  await c.page.evaluate(() => {
    const s = globalThis.__MOCK__.store, first = s.get().emotes[0];
    s.set({ emotes: [...s.get().emotes, { seq: 2, playerId: first.playerId, id: 'autochess_battle_happy', at: Date.now() }] });
  });
  await c.page.waitForSelector('.team__bubble[data-emote="autochess_battle_happy"]');
  assert.equal(await c.page.$('.team__bubble.ebubble--chat'), null, 'emote replaces text on the same avatar');
  await c.page.evaluate(() => {
    const s = globalThis.__MOCK__.store, first = s.get().emotes[0];
    s.set({ emotes: [...s.get().emotes, { seq: 3, playerId: first.playerId, text: '<img src=x onerror=alert(1)>', at: Date.now() }] });
  });
  await c.page.waitForSelector('.team__bubble.ebubble--chat');
  assert.equal(await c.page.$('.team__bubble.ebubble--chat img'), null, 'chat remains escaped text');
  assert.equal(await c.page.$('.team__bubble[data-emote]'), null, 'text replaces the earlier emote');
  await c.page.waitForFunction(() => !document.querySelector('.team__bubble'), { timeout: 6000 });
});
