// SP_E2E=1 CHROME_PATH=... node --test test/ui/state-delta.e2e.test.js
// Real browser Net + app store, with a StubMatch to isolate transport recovery from combat timing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startServer } from '../../server/index.js';
import { StubMatch } from '../../server/match/StubMatch.js';
import { TestClient } from '../helpers/wsClient.js';

const chrome = process.env.CHROME_PATH;
test('browser: state patches update the app, a lost baseline recovers automatically, reconnect starts full', {
  skip: process.env.SP_E2E !== '1' || !existsSync(chrome || ''), timeout: 90000,
}, async (t) => {
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, store: null, workers: 0,
    MatchClass: StubMatch, resyncMinGapMs: 100 });
  t.after(() => server.close());
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true,
    args: ['--no-first-run', '--mute-audio', '--disable-background-timer-throttling'] });
  t.after(() => browser.close());
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('sp.name', 'Delta browser'); sessionStorage.setItem('sp.entered', '1');
  });
  await page.goto('http://127.0.0.1:' + server.port + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.__SP__?.store.get().connection.status === 'online' && document.querySelector('.lobby-screen'));
  await page.evaluate(() => {
    const net = globalThis.__SP__.net;
    globalThis.__deltaTest = { full: 0, patch: 0, resync: 0 };
    const onMessage = net._onMessage.bind(net), sendRaw = net._sendRaw.bind(net);
    net._onMessage = (data) => {
      const m = JSON.parse(data);
      if (m.t === 'm.state') globalThis.__deltaTest[m.full ? 'full' : 'patch']++;
      return onMessage(data);
    };
    net._sendRaw = (msg) => { if (msg.t === 'state.resync') globalThis.__deltaTest.resync++; return sendRaw(msg); };
  });
  const buddy = await TestClient.connect('ws://127.0.0.1:' + server.port + '/ws');
  t.after(() => buddy.terminate());
  await buddy.hello('Legacy buddy');
  const code = await page.evaluate(async () => {
    await globalThis.__SP__.net.request('room.create', { mode: 'coop', difficulty: 'NORMAL' });
    return globalThis.__SP__.store.get().room.code;
  });
  await buddy.request({ t: 'room.join', code });
  await buddy.request({ t: 'room.ready', ready: true });
  await page.evaluate(() => globalThis.__SP__.net.request('room.start'));
  await page.waitForFunction(() => globalThis.__SP__.store.get().match.public?.phase === 'INFO_CHECK'
    && globalThis.__SP__.store.get().match.private?.playerId === globalThis.__SP__.net.playerId);
  await page.evaluate(async () => {
    const net = globalThis.__SP__.net;
    net._states.states.delete('m.public'); // Simulate losing the application baseline, not a TCP frame.
    await net.request('g.infoReady');
  });
  await page.waitForFunction(() => {
    const { net, store } = globalThis.__SP__;
    return globalThis.__deltaTest.resync > 0 && globalThis.__deltaTest.patch > 0 && globalThis.__deltaTest.full >= 4
      && net._states.missing.size === 0 && store.get().match.public.players.find((p) => p.playerId === net.playerId)?.ready;
  });
  const before = await page.evaluate(() => ({ ...globalThis.__deltaTest, playerId: globalThis.__SP__.net.playerId }));
  await page.evaluate(() => globalThis.__SP__.net.reconnectNow());
  await page.waitForFunction((count) => globalThis.__SP__.net.status === 'online'
    && globalThis.__deltaTest.full >= count + 2 && globalThis.__SP__.net._states.missing.size === 0, {}, before.full);
  assert.equal(await page.evaluate(() => globalThis.__SP__.net.playerId), before.playerId);
  await buddy.request({ t: 'g.infoReady' });
  await page.waitForFunction(() => !!globalThis.__SP__.store.get().match.result && globalThis.__SP__.net._states.states.size === 0);
  assert.deepEqual(errors, []);
});
