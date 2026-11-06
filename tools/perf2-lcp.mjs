#!/usr/bin/env node
/* global document */
// tools/perf2-lcp.mjs — cold-load LCP/FCP + first screen-switch latency, for the entry-split A/B.
//
// Serves the real app (server/index.js startServer, so /build, /shared, /sim, /data, /js all resolve
// exactly as in production) and drives Microsoft Edge headless with a CDP-throttled 4 Mbps link.
// Each round uses a fresh incognito context (cold HTTP cache, no SW, empty storage), injects a
// PerformanceObserver before any script runs, and records FCP + LCP (last buffered entry at settle),
// the LCP element identity, and the wall-clock moment the app shell / title screen is mounted.
//
// A/B is exchanged by swapping public/build on disk between two pre-built snapshots
// (--A <dir> --B <dir>) before each round; the caller passes an AB/BA-alternating --labels sequence.
// One startServer per round so the built-client probe re-stats the freshly swapped index.html.
//
// Usage:
//   CHROME_PATH=... node tools/perf2-lcp.mjs --A /tmp/sp-perf2/A --B /tmp/sp-perf2/B \
//       --labels A,B,B,A,A,B,B,A [--switch room] [--json out.json] [--settle 2500]
//   CHROME_PATH=... node tools/perf2-lcp.mjs --diag --A /tmp/sp-perf2/A   (one round, LCP element dump)

import { startServer } from '../server/index.js';
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'public', 'build');
const CHROME = process.env.CHROME_PATH || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);
const A_DIR = arg('--A', '');
const B_DIR = arg('--B', '');
const LABELS = arg('--labels', 'A').split(',').map((s) => s.trim()).filter(Boolean);
const SWITCH_ROUTE = arg('--switch', '');
const SETTLE = Number(arg('--settle', '2500'));
const OUT = arg('--json', '');
const DIAG = has('--diag');

// 4 Mbps down / 1 Mbps up / 40 ms RTT — a "slow 4G-ish" wired link. CDP throughput is bytes/sec.
const DOWN_BPS = 4 * 1024 * 1024 / 8;
const UP_BPS = 1 * 1024 * 1024 / 8;
const LATENCY_MS = 40;

/** Point public/build at the chosen snapshot dir (copy tree). Keep a backup of the live build. */
function swapBuild(label) {
  const src = label === 'A' ? A_DIR : B_DIR;
  if (!src) return;
  // The build tree is git-ignored and disposable: clear it, then copy the snapshot in.
  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.cpSync(src, BUILD, { recursive: true });
}

let browser;
const results = [];
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 120000,
    args: ['--no-first-run', '--no-sandbox', '--disable-background-networking',
      '--disable-features=Translate,BackForwardCache', '--disable-application-cache'],
  });

  for (let r = 0; r < LABELS.length; r++) {
    const label = LABELS[r];
    swapBuild(label);
    const boot = await startServer({ port: 0, quiet: true });
    const PAGE_URL = `http://127.0.0.1:${boot.port}/`;
    let ctx;
    try {
      ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await page.setCacheEnabled(false);
      const cdp = await page.target().createCDPSession();
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, latency: LATENCY_MS,
        downloadThroughput: DOWN_BPS, uploadThroughput: UP_BPS,
        connectionType: 'cellular4g',
      });
      await cdp.send('Page.enable');

      const problems = [];
      page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text().slice(0, 160)); });
      const netEvents = [];
      let navTs = 0;
      if (has('--nettrace')) {
        page.on('request', (req) => {
          if (req.url().includes('/build/assets/')) netEvents.push({ t: Date.now() - navTs, ev: 'start', u: req.url().split('/').pop() });
        });
        page.on('requestfinished', (req) => {
          if (req.url().includes('/build/assets/')) netEvents.push({ t: Date.now() - navTs, ev: 'done', u: req.url().split('/').pop() });
        });
      }

      // Install the paint observers in the page before any app script evaluates.
      await page.evaluateOnNewDocument(() => {
        globalThis.__perf = { fcp: 0, lcp: 0, lcpEntries: 0, lcpEl: '' };
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) if (e.name === 'first-contentful-paint') globalThis.__perf.fcp = e.startTime;
        }).observe({ type: 'paint', buffered: true });
        new PerformanceObserver((list) => {
          const es = list.getEntries();
          if (!es.length) return;
          const e = es[es.length - 1];
          globalThis.__perf.lcp = e.startTime;
          globalThis.__perf.lcpEntries = es.length;
          const el = e.element;
          globalThis.__perf.lcpEl = el ? `${el.tagName}${el.id ? '#' + el.id : ''}${el.className ? '.' + String(el.className).split(' ').join('.') : ''}` : (e.url || '?');
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      });

      const navStart = Date.now();
      navTs = navStart;
      await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    // Wait for the REAL title screen, not the lazy fallback: a cold B group renders a placeholder
    // while its title chunk loads, so #app children alone would flatter its mount time. A and B both
    // start at the title screen (fresh context, not entered), so .title-screen is the shared marker.
    await page.waitForFunction(() => !!document.querySelector('.title-screen, .lobby-screen, .room-screen, .gm'),
      { timeout: 120000 });
    const titleMount = Date.now() - navStart;
      // Let LCP settle: a quiet wall window covers post-FCP paints; buffered entries keep updating.
      await new Promise((res) => setTimeout(res, SETTLE));
      const perf = await page.evaluate(() => ({ ...globalThis.__perf }));

      // Optional: first screen switch (hover/idle-preload masking test). Drive the store directly.
      // --warm: await the page's own preload completion first (the idle preloader has warmed every
      // screen chunk), so switchMs measures a pre-warmed switch. Without it the B group pays the
      // real dynamic-import waterfall — that is the "cold switch" cost we also want to quantify.
      let switchMs = null, warmMs = null, screensWarm = null;
      if (SWITCH_ROUTE) {
        if (has('--warm')) {
          const tw = Date.now();
          try {
            await page.evaluate(async () => {
              if (typeof globalThis.__SP__?.whenScreensReady === 'function') await globalThis.__SP__.whenScreensReady();
            });
          } catch { /* A group has no preload hook */ }
          warmMs = Date.now() - tw;
          screensWarm = await page.evaluate(() => globalThis.__SP__?.screensWarm?.() ?? null);
        }
        const t0 = Date.now();
        await page.evaluate((route) => {
          const st = globalThis.__SP__?.store;
          if (!st) throw new Error('no __SP__ store');
          const s = st.get();
          st.set({ session: { ...s.session, entered: true }, me: { ...s.me, name: s.me?.name || 'TEST' },
            room: route === 'lobby' ? null : { code: 'ABCDEF', mode: 'solo', seats: [], inMatch: false,
              content: { vanilla: true }, difficulty: 'NORMAL', version: null } });
        }, SWITCH_ROUTE);
        const marker = SWITCH_ROUTE === 'room' ? '.room-screen'
          : SWITCH_ROUTE === 'lobby' ? '.lobby-screen'
          : SWITCH_ROUTE === 'game' ? '.gm' : '.title-screen';
        try {
          await page.waitForFunction((sel) => !!document.querySelector(sel), { timeout: 30000 }, marker);
          switchMs = Date.now() - t0;
        } catch { switchMs = -1; }
      }

      const row = { round: r + 1, label, fcp: Math.round(perf.fcp), lcp: Math.round(perf.lcp),
        lcpEntries: perf.lcpEntries, lcpEl: perf.lcpEl, titleMount, switchMs, warmMs, screensWarm, problems };
      results.push(row);
      console.log(`[${label}] round ${r + 1}: FCP=${row.fcp}ms LCP=${row.lcp}ms titleMount=${titleMount}ms switch=${switchMs} warm=${warmMs} screensWarm=${JSON.stringify(screensWarm)} lcpEl=${row.lcpEl} problems=${problems.length}`);
      if (DIAG) console.log('  problems:', JSON.stringify(problems));
      if (has('--nettrace')) {
        const done = netEvents.filter((e) => e.ev === 'done').map((e) => `${e.t}:${e.u}`);
        console.log(`  nettrace(${label}) FCP=${row.fcp} LCP=${row.lcp} titleMount=${titleMount} done=[${done.join(' | ')}]`);
      }
      await cdp.detach();
    } finally {
      await ctx?.close();
      await boot.close();
    }
  }
} finally {
  await browser?.close();
}

const best = (label, key) => {
  const v = results.filter((x) => x.label === label).map((x) => x[key]).filter((n) => typeof n === 'number' && n > 0);
  return v.length ? Math.min(...v) : null;
};
const summary = { downMbps: 4, latencyMs: LATENCY_MS, settleMs: SETTLE, switchRoute: SWITCH_ROUTE || null,
  byLabel: Object.fromEntries([...new Set(results.map((x) => x.label))].map((l) => [l, {
    rounds: results.filter((x) => x.label === l).length,
    minFcp: best(l, 'fcp'), minLcp: best(l, 'lcp'), minTitleMount: best(l, 'titleMount'),
    minSwitch: best(l, 'switchMs'), minWarm: best(l, 'warmMs'),
  }])), results };
console.log('SUMMARY ' + JSON.stringify(summary.byLabel));
if (OUT) fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
