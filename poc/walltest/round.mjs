#!/usr/bin/env node
// poc/walltest/round.mjs — one loadgen round of the 2026-11-08 capacity-wall retest. The caller holds the serial
// lock (/tmp/sp-serial-lock); this script runs exactly one round: `node tools/loadgen.mjs` with the --state's env
// (off = 四项全关 / on = 三开, SP_FRAME_ECONOMY 两种态都保持关), a ps spy on the server child (%cpu is process-wide
// on macOS — worker threads included — which healthz ELU is not, see the Node 26.13 caveat) and on the loadgen
// process itself (its saturation caps how many clients one loadgen can drive), wall-clock start/end, and one TSV
// line + full JSON into --out.
//
// Usage:
//   node poc/walltest/round.mjs --tag off-r1 --state off [--out /tmp/sp-walltest]
//        [--clients 2000 --rooms 600 --rate 20 --duration 115 --warmup 105 --seed 1 --port 3999]
//        [--loop-window-ms 1000 --workers 4] [--extra "--plan-pool 1 --max-connections 4200 …"]

import { spawn, execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  opt[k] = v;
}
const num = (v, d) => (v != null && v !== true && Number.isFinite(Number(v)) ? Number(v) : d);
const O = {
  tag: String(opt.tag || 'round'),
  state: ['off', 'on'].includes(opt.state) ? opt.state : 'off',
  out: String(opt.out || '/tmp/sp-walltest'),
  clients: Math.floor(num(opt.clients, 2000)),
  rooms: Math.floor(num(opt.rooms, 600)),
  rate: num(opt.rate, 20),
  duration: num(opt.duration, 115),
  warmup: num(opt.warmup, 105),
  seed: Math.floor(num(opt.seed, 1)),
  port: Math.floor(num(opt.port, 3999)),
  workers: Math.floor(num(opt.workers, 4)),
  loopWindowMs: Math.floor(num(opt['loop-window-ms'], 1000)),
  extra: typeof opt.extra === 'string' && opt.extra.trim() ? opt.extra.trim().split(/\s+/) : [],
};

// 两态（任务口径）：off = 四项全关；on = 三开（SP_CONTENT_BUILD_WORKER + SP_BATTLE_POOL + SP_BOT_PLAN_POOL）。
// SP_FRAME_ECONOMY 保持关。SP_BOT_PLAN_POOL 走 loadgen 的 --plan-pool（其 env 会被 CHILD_ENV_DENY 剥离），
// 由调用方放进 --extra；这里只管 env 透传（SP_BATTLE_POOL / SP_CONTENT_BUILD_WORKER 不在剥离名单）。
const STATE_ENV = {
  off: { SP_BATTLE_POOL: '0', SP_CONTENT_BUILD_WORKER: '0', SP_FRAME_ECONOMY: '0' },
  on: { SP_BATTLE_POOL: '1', SP_CONTENT_BUILD_WORKER: '1', SP_FRAME_ECONOMY: '0' },
};

const startIso = new Date().toISOString();
const startMs = Date.now();
const jsonPath = path.join(O.out, `${O.tag}.loadgen.json`);
const args = ['tools/loadgen.mjs',
  '--clients', String(O.clients), '--rooms', String(O.rooms), '--rate', String(O.rate),
  '--duration', String(O.duration), '--warmup', String(O.warmup), '--seed', String(O.seed),
  '--port', String(O.port), '--loop-window-ms', String(O.loopWindowMs), '--workers', String(O.workers),
  '--json', jsonPath,
  ...O.extra];
console.log(`[round ${O.tag}] start ${startIso} state=${O.state}\n[round ${O.tag}] node ${args.join(' ')}\n[round ${O.tag}] env ${JSON.stringify(STATE_ENV[O.state])}`);

mkdirSync(O.out, { recursive: true });

/** ps spy: samples of {t, cpu (%process-wide), rss (KB)} every 2 s; stop() ends it. Gone pid = spy ends itself. */
function makeSpy(pid, label) {
  const samples = [];
  const timer = setInterval(() => {
    execFile('ps', ['-p', String(pid), '-o', '%cpu=,rss='], (err, stdout) => {
      if (err) return;
      const parts = stdout.trim().split(/\s+/).map(Number);
      if (!Number.isFinite(parts[0])) return;
      samples.push({ t: Date.now(), cpu: parts[0], rssKB: Number.isFinite(parts[1]) ? parts[1] : null });
    });
  }, 2000);
  timer.unref?.();
  return { label, pid, samples, stop: () => clearInterval(timer) };
}

const lgSpy = makeSpy(child.pid, 'loadgen');
let serverSpy = null;

const child = spawn(process.execPath, args, {
  cwd: ROOT,
  env: { ...process.env, ...STATE_ENV[O.state] },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const logLines = [];
const capture = (buf) => {
  for (const line of String(buf).split('\n')) {
    if (!line.trim()) continue;
    logLines.push(line);
    console.log(`[lg] ${line}`);
    const m = /server up on 127\.0\.0\.1:\d+ \(boot \d+ ms, pid (\d+)\)/.exec(line);
    if (m && !serverSpy) serverSpy = makeSpy(Number(m[1]), 'server');
  }
};
child.stdout.on('data', capture);
child.stderr.on('data', capture);

const exitCode = await new Promise((resolve) => child.once('exit', (code, signal) => resolve(code == null ? `signal:${signal}` : code)));
lgSpy.stop();
serverSpy?.stop();
const endIso = new Date().toISOString();
const wallS = Math.round((Date.now() - startMs) / 1000);
console.log(`[round ${O.tag}] done ${endIso} wall ${wallS}s loadgen exit ${exitCode}`);

const spyAgg = (s) => {
  if (!s || !s.samples.length) return null;
  const cpu = s.samples.map((x) => x.cpu);
  const rss = s.samples.map((x) => x.rssKB).filter((x) => x != null);
  return {
    pid: s.pid, n: s.samples.length,
    cpuAvg: Math.round(cpu.reduce((a, b) => a + b, 0) / cpu.length),
    cpuMax: Math.round(Math.max(...cpu) * 10) / 10,
    rssMBMax: rss.length ? Math.round(Math.max(...rss) / 1024) : null,
  };
};

let row = { tag: O.tag, state: O.state, start: startIso, end: endIso, wallS, loadgenExit: exitCode, note: 'loadgen JSON missing' };

// loadgen wrote the JSON itself (--json in args); read it back for the TSV row.
let sum = null;
try {
  const { readFileSync } = await import('node:fs');
  sum = JSON.parse(readFileSync(jsonPath, 'utf8'));
} catch (e) {
  console.error(`[round ${O.tag}] no loadgen JSON at ${jsonPath}: ${e.message}`);
}

if (sum) {
  const errs = sum.clients?.errorReplies || {};
  const errTotal = Object.values(errs).reduce((a, b) => a + b, 0);
  row = {
    tag: O.tag, state: O.state, start: startIso, end: endIso, wallS, loadgenExit: exitCode,
    clients: sum.meta?.clients, rooms: sum.meta?.rooms, planPool: sum.meta?.planPool,
    connectFailed: sum.phases?.connectFailed, matchesStarted: sum.phases?.matchesStarted,
    humans: sum.server?.humans?.avg, roomsUp: sum.server?.rooms?.avg, sockets: sum.server?.sockets?.avg,
    loopP50max: sum.loop?.p50?.max, loopP95mean: sum.loop?.p95?.mean, loopP95max: sum.loop?.p95?.max,
    loopP99max: sum.loop?.p99?.max, loopMax: sum.loop?.max?.max, windows: sum.loop?.windows?.length,
    cpuLinePeak: sum.loop?.cpu?.max, inMsgPerSec: sum.clients?.inMsgPerSec, outMsgPerSec: sum.clients?.outMsgPerSec,
    stormIntents: sum.clients?.stormIntents, errTotal, errs: JSON.stringify(errs),
    rssAvg: sum.server?.rssMB?.avg, rssMax: sum.server?.rssMB?.max,
    healthzMsMax: sum.server?.healthzMs?.max,
    prepToCombatMax: sum.clients?.rehearsal?.prepToCombat?.max ?? null,
    srvCpu: spyAgg(serverSpy), lgCpu: spyAgg(lgSpy),
    problems: sum.problems?.length ?? 0, problemFirst: sum.problems?.[0] ?? null,
  };
}

writeFileSync(path.join(O.out, `${O.tag}.round.json`), JSON.stringify({ ...row, summary: sum, log: logLines }, null, 2));
const tsvCols = ['tag', 'state', 'start', 'end', 'wallS', 'clients', 'rooms', 'connectFailed', 'matchesStarted', 'humans',
  'loopP50max', 'loopP95mean', 'loopP95max', 'loopP99max', 'loopMax', 'windows', 'cpuLinePeak', 'inMsgPerSec', 'outMsgPerSec',
  'stormIntents', 'errTotal', 'rssAvg', 'rssMax', 'healthzMsMax', 'prepToCombatMax'];
const flat = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const tsv = tsvCols.map((k) => flat(row[k])).join('\t') + `\tsrv=${JSON.stringify(row.srvCpu)}\tlg=${JSON.stringify(row.lgCpu)}\tproblems=${row.problems}\texit=${row.loadgenExit}\terrKinds=${row.errs ?? ''}`;
appendFileSync(path.join(O.out, 'summary.tsv'), tsv + '\n');
console.log(`[round ${O.tag}] row: ${tsv}`);
process.exitCode = sum && sum.problems?.some((p) => String(p).startsWith('fatal')) ? 1 : 0;
