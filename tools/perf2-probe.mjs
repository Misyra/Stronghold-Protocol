#!/usr/bin/env node
/* global document */
// tools/perf2-probe.mjs — real-usability probe of the built page (Edge headless, cold cache).
// Checks: the title screen actually mounts, a store-driven switch into a room renders a real room
// screen (no white screen / no placeholder left behind), all four screen chunks preload, and no
// uncaught JS error is raised. Environment-only console noise (missing /assets art, the local
// fonts.css MIME) is listed but not treated as a failure — it is identical on the baseline build.
//
// Usage: CHROME_PATH=... node tools/perf2-probe.mjs [--switch lobby]

import { startServer } from '../server/index.js';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const SWITCH = (() => { const i = process.argv.indexOf('--switch'); return i >= 0 ? process.argv[i + 1] : 'room'; })();

const boot = await startServer({ port: 0, quiet: true });
const PAGE_URL = `http://127.0.0.1:${boot.port}/`;
let browser, pass = true;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) pass = false;
};
try {
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 120000,
    args: ['--no-first-run', '--no-sandbox', '--disable-background-networking'] });
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setCacheEnabled(false);
  const pageErrors = [], consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!document.querySelector('.title-screen'), { timeout: 120000 });
  const title = await page.evaluate(() => ({
    root: document.querySelector('.title-screen')?.className,
    buttons: document.querySelectorAll('.title-screen button').length,
    hasApp: !!document.getElementById('app')?.children.length,
  }));
  check('title screen mounts', title.root?.includes('title-screen') && title.hasApp, JSON.stringify(title));

  const hooks = await page.evaluate(async () => {
    const sp = globalThis.__SP__;
    if (!sp) return { error: 'no __SP__' };
    await sp.whenScreensReady();
    return { warm: sp.screensWarm?.() ?? null };
  });
  check('all screen chunks preload', Array.isArray(hooks.warm) && hooks.warm.length === 4, JSON.stringify(hooks));

  const t0 = Date.now();
  await page.evaluate((route) => {
    const st = globalThis.__SP__.store, s = st.get();
    st.set({ session: { ...s.session, entered: true }, me: { ...s.me, name: s.me?.name || 'TEST' },
      room: route === 'lobby' ? null : { code: 'ABCDEF', mode: 'solo', seats: [], inMatch: false,
        content: { vanilla: true }, difficulty: 'NORMAL', version: null } });
  }, SWITCH);
  const marker = SWITCH === 'lobby' ? '.lobby-screen' : '.room-screen';
  let switched = false;
  try { await page.waitForFunction((sel) => !!document.querySelector(sel), { timeout: 30000 }, marker); switched = true; } catch { /* reported below */ }
  const view = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return { marker: !!el, text: (el?.textContent || '').trim().slice(0, 60),
      fallback: !!document.querySelector('.screen .boot__hex') && !el };
  }, marker);
  check(`switch to ${SWITCH} renders a real screen (no white screen)`, switched && view.marker && !view.fallback,
    `${Date.now() - t0}ms ${JSON.stringify(view)}`);

  check('no uncaught JS errors', pageErrors.length === 0, pageErrors.join(' | ') || '0');
  // Environment noise is expected without public/assets (fonts.css served as text/html, 404 sprite files).
  const nonEnv = consoleErrors.filter((e) => !/404 \(Not Found\)|fonts\.css.*MIME|net::ERR_/.test(e));
  check('no unexpected console errors', nonEnv.length === 0, nonEnv.join(' | ') || `0 (${consoleErrors.length} env-only 404/MIME lines)`);
  await ctx.close();
} finally {
  await browser?.close();
  await boot.close();
}
console.log(pass ? 'PROBE RESULT: PASS' : 'PROBE RESULT: FAIL');
process.exitCode = pass ? 0 : 1;
