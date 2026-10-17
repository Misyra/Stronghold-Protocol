import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../server/index.js';
import { Client, hasChrome } from '../e2e/client.mjs';
import { readFileSync } from 'node:fs';

const preflightEnabled = /NICKNAME_PREFLIGHT_ENABLED = true;/.test(readFileSync(new URL('../../public/js/screens/title.js', import.meta.url), 'utf8'));

test('nickname policy: server feedback, normal entry without the suspended API, and remembered blocked names stay editable', {
  skip: process.env.SP_E2E !== '1' || !hasChrome(), timeout: 60000,
}, async t => {
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, clientBuild: false });
  t.after(() => server.close());
  const puppeteer = (await import('puppeteer-core')).default;
  const c = new Client(puppeteer, server.url, 'nickname-policy', { prefix: 'nickname-policy' });
  t.after(() => c.close()); await c.open();
  await c.page.waitForSelector('.fullscreen-prompt');
  await c.click('.fullscreen-prompt button', '暂不全屏');
  const fill = async value => c.page.$eval('.title-login input', (el, value) => {
    el.value = value; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  const enter = async name => {
    // This fork shows its fullscreen prompt again after a page reload.
    if (await c.page.$('.fullscreen-prompt')) await c.click('.fullscreen-prompt button', '暂不全屏');
    await fill(name);
    await c.page.waitForFunction(() => !document.querySelector('.title-name-feedback'));
    await c.page.waitForFunction(() => !document.querySelector('.title-login button.btn--primary').disabled);
    await c.click('.title-login button', '开始');
    await c.page.waitForSelector('.lobby-screen');
    // Without the HTTP round trip, the lobby can render before welcome arrives.
    await c.page.waitForFunction(() => globalThis.__SP__.net.status === 'online');
  };
  const checks = [], requested = [];
  await c.page.setRequestInterception(true);
  c.page.on('request', req => {
    // Simulate the closed API while the temporary switch is off; entering must still work.
    if (!preflightEnabled && req.url().endsWith('/api/nickname/validate')) void req.abort();
    else void req.continue().catch(() => {});
  });
  c.page.on('request', req => requested.push(req.url()));
  c.page.on('response', response => {
    if (response.url().endsWith('/api/nickname/validate')) checks.push(response.status());
  });
  await fill('习·近平');
  await c.page.waitForFunction(() => !document.querySelector('.title-login button.btn--primary').disabled);
  await c.click('.title-login button', '开始');
  await c.page.waitForFunction(() => document.querySelector('.title-login .field__hint')?.textContent.includes('请更换昵称'));
  assert.equal(await c.page.$eval('.title-login button.btn--primary', el => el.disabled), false);
  assert.equal(server.registry.size, 0);
  assert.deepEqual(checks, preflightEnabled ? [422] : []);
  const feedback = await c.page.$eval('.title-name-feedback', el => ({
    text: el.textContent, href: el.querySelector('a').href,
    target: el.querySelector('a').target, rel: el.querySelector('a').rel,
  }));
  assert.match(feedback.text, /如果你认为昵称没有问题/);
  assert.match(feedback.text, /GitHub 反馈/);
  assert.equal(feedback.href, 'https://github.com/Misyra/Stronghold-Protocol/issues/new?template=BugReport.yml');
  assert.equal(feedback.target, '_blank');
  assert.match(feedback.rel, /noopener/); assert.match(feedback.rel, /noreferrer/);
  await enter('正常博士');
  assert.equal(server.registry.size, 1);
  // Simulate an outdated/modified client that skips the title check.
  await c.page.evaluate(() => globalThis.__SP__.net.setName('F.u.c.k'));
  await c.page.waitForSelector('.title-screen');
  await c.page.waitForFunction(() => globalThis.__SP__.net.name === '' && globalThis.__SP__.store.get().session.entered === false);
  await c.page.waitForSelector('.title-name-feedback a');
  assert.equal(server.registry.byPlayerId.values().next().value.name, '正常博士');
  await enter('另一个博士');
  await c.page.evaluate(async () => {
    const { identity } = await import('/js/net.js'); identity.saveName('法輪功'); identity.setEntered(true);
  });
  await c.page.reload({ waitUntil: 'domcontentloaded' });
  await c.page.waitForSelector('.title-screen');
  assert.equal(await c.page.$eval('.title-login input', el => el.value), '法輪功');
  await c.page.waitForFunction(() => document.querySelector('.title-login .field__hint')?.textContent.includes('请更换昵称'));
  await enter('恢复正常');
  assert.equal(await c.page.evaluate(() => globalThis.__SP__.store.get().me.name), '恢复正常');
  assert.deepEqual(checks, preflightEnabled ? [422, 200, 200, 200] : []);
  if (!preflightEnabled) assert.ok(!requested.some(url => url.endsWith('/api/nickname/validate')));
  assert.ok(!requested.some(url => /nicknamePolicy|site-policy|lexicon|moderation/.test(url)), 'browser never fetches dictionary files');
});

test('editing a nickname cancels pending approval, then a fresh validation can enter', {
  // Retain the HTTP cancellation scenario for when the temporary suspension is lifted.
  skip: !preflightEnabled || process.env.SP_E2E !== '1' || !hasChrome(), timeout: 60000,
}, async t => {
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, clientBuild: false });
  t.after(() => server.close());
  const puppeteer = (await import('puppeteer-core')).default;
  const c = new Client(puppeteer, server.url, 'nickname-stale', { prefix: 'nickname-stale' });
  t.after(() => c.close()); await c.open();
  await c.page.waitForSelector('.fullscreen-prompt');
  await c.click('.fullscreen-prompt button', '暂不全屏');
  await c.page.setRequestInterception(true);
  let capture, holding = true;
  const pending = new Promise(resolve => { capture = resolve; });
  c.page.on('request', req => {
    if (holding && req.url().endsWith('/api/nickname/validate')) capture(req);
    else void req.continue().catch(() => {});
  });
  const fill = value => c.page.$eval('.title-login input', (el, value) => {
    el.value = value; el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await fill('正常博士');
  await c.click('.title-login button', '开始');
  const old = await pending;
  assert.equal(await c.page.$eval('.title-login button.btn--primary', el => el.disabled), true);
  assert.equal(server.registry.size, 0);
  await fill('修改代号');
  await c.page.waitForFunction(() => !document.querySelector('.title-login button.btn--primary').disabled);
  holding = false;
  await old.respond({ status: 200, contentType: 'application/json', body: '{"ok":true}' }).catch(() => {});
  await c.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await c.page.evaluate(() => globalThis.__SP__.store.get().session.entered), false);
  assert.equal(server.registry.size, 0);
  await c.click('.title-login button', '开始');
  await c.page.waitForSelector('.lobby-screen');
  assert.equal(await c.page.evaluate(() => globalThis.__SP__.store.get().me.name), '修改代号');
  assert.equal(server.registry.size, 1);
});
