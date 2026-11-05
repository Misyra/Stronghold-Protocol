// tools/allocator-observe.mjs — glibc allocator 调优的只读 A/B 观测（docs/DEPLOY.md §13）
//
// 在【游戏服务器本机】运行；`?traffic=1` 只对 loopback / 私网开放。全程只读：
//   * GET http://127.0.0.1:<port>/healthz?traffic=1
//   * /proc/<MainPID>/smaps、/proc/<MainPID>/status、systemctl show -p MainPID --value stronghold
// 绝不 restart / daemon-reload / kill / 写任何服务配置；输出只到 stdout。
//
//   node tools/allocator-observe.mjs --label before --minutes 30 > /tmp/alloc-before.jsonl
//   node tools/allocator-observe.mjs --label after  --minutes 30 > /tmp/alloc-after.jsonl
//   node tools/allocator-observe.mjs --compare /tmp/alloc-before.jsonl /tmp/alloc-after.jsonl
//
// 采样字段：performance.process.rssBytes / mainThread.memory.* / eventLoopDelayMs.p95,p99 /
// eventLoopUtilization / cpu.percent，persist.checkpointsEncoded|Skipped，/healthz 的 online|rooms|matches，
// 以及 smaps 的 rw-p 段数 / 大小分布与 status 的 RssAnon|Threads。
//
// 机器负载噪声大：对比按 min / p50 / p95 / max 给，min 逼近无干扰下界，p95 抓 event loop 毛刺。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (key, fallback) => {
  const i = argv.indexOf(`--${key}`);
  return i < 0 || i + 1 >= argv.length ? fallback : argv[i + 1];
};
const has = (key) => argv.includes(`--${key}`);
const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// ---------------------------------------------------------------- entry (last, after all consts are initialized)
async function main() {
  if (has('compare')) {
    const beforePath = arg('compare', null);
    const afterPath = argv[argv.indexOf('--compare') + 2] || null;
    if (!beforePath || !afterPath) {
      console.error('usage: node tools/allocator-observe.mjs --compare BEFORE.jsonl AFTER.jsonl');
      process.exit(2);
    }
    compare(loadJsonl(beforePath), loadJsonl(afterPath));
    return;
  }
  const label = arg('label', 'sample');
  const minutes = num(arg('minutes', 30), 30);
  const interval = num(arg('interval', 30), 30);
  const port = num(arg('port', 3000), 3000);
  const unit = arg('unit', 'stronghold');
  // 非 systemd 部署（或想盯另一个进程）时直接钉 pid；0 = 每次从 systemctl 重取。
  const pidOverride = num(arg('pid', 0), 0);
  const samples = Math.ceil((minutes * 60) / interval);
  for (let i = 0; i < samples; i++) {
    process.stdout.write(`${JSON.stringify(sampleOnce({ label, port, unit, pidOverride }))}\n`);
    if (i + 1 < samples) await sleep(interval * 1000);
  }
}

// ---------------------------------------------------------------- helpers
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function sampleOnce({ label, port, unit, pidOverride = 0 }) {
  const pid = pidOverride || mainPid(unit);
  const health = fetchHealth(port);
  const perf = health.performance || {};
  const proc = perf.process || {};
  const mt = perf.mainThread || {};
  const ev = mt.eventLoopDelayMs || {};
  const mem = mt.memory || {};
  const persist = health.persist || {};
  return {
    label,
    ts: new Date().toISOString(),
    pid,
    rssMB: round((proc.rssBytes || 0) / 1048576, 2),
    heapUsedMB: round((mem.heapUsedBytes || 0) / 1048576, 2),
    externalMB: round((mem.externalBytes || 0) / 1048576, 2),
    arrayBuffersMB: round((mem.arrayBuffersBytes || 0) / 1048576, 2),
    evP95Ms: ev.p95 ?? null,
    evP99Ms: ev.p99 ?? null,
    elu: mt.eventLoopUtilization ?? null,
    cpuPercent: proc.cpu?.percent ?? null,
    windowMs: perf.windowMs ?? null,
    perfState: perf.state ?? null,
    online: health.online ?? null,
    rooms: health.rooms ?? null,
    matches: health.matches ?? null,
    checkpointsEncoded: persist.checkpointsEncoded ?? null,
    checkpointsSkipped: persist.checkpointsSkipped ?? null,
    smaps: smapsStats(pid),
    status: statusStats(pid),
  };
}

/** MainPID 每次重取：期间若重启过也能跟上，不会拿旧 pid。 */
function mainPid(unit) {
  try {
    const out = execFileSync('systemctl', ['show', '-p', 'MainPID', '--value', unit], { encoding: 'utf8' });
    const n = Number(out.trim());
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

function fetchHealth(port) {
  // curl 而不是 fetch：脚本跑在服务器本机，curl 在所有部署形态里都有，超时直接由 --max-time 兜住。
  try {
    const res = execFileSync('curl', ['-s', '--max-time', '4', `http://127.0.0.1:${port}/healthz?traffic=1`],
      { encoding: 'utf8', maxBuffer: 8 << 20 });
    return JSON.parse(res || '{}');
  } catch { return {}; }
}

/** /proc/<pid>/smaps 的 rw-p 段统计；小段阈值 500 MB（glibc main arena 量级）。 */
function smapsStats(pid) {
  if (!pid) return null;
  let text;
  try { text = readFileSync(`/proc/${pid}/smaps`, 'utf8'); } catch { return null; }
  const sizes = [];
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]+)-([0-9a-f]+) rw-p/.exec(line);
    if (m) sizes.push(parseInt(m[2], 16) - parseInt(m[1], 16));
  }
  const big = sizes.filter((s) => s >= 500 * 1024 * 1024);
  const small = sizes.filter((s) => s < 500 * 1024 * 1024);
  return {
    rwSegments: sizes.length,
    rwTotalMB: round(sizes.reduce((a, b) => a + b, 0) / 1048576, 1),
    bigSegments: big.length,
    bigMB: round(big.reduce((a, b) => a + b, 0) / 1048576, 1),
    smallSegments: small.length,
    smallMB: round(small.reduce((a, b) => a + b, 0) / 1048576, 1),
    smallAvgKB: small.length ? round(small.reduce((a, b) => a + b, 0) / small.length / 1024, 1) : null,
    under1MB: small.filter((s) => s < 1048576).length,
  };
}

function statusStats(pid) {
  if (!pid) return null;
  let text;
  try { text = readFileSync(`/proc/${pid}/status`, 'utf8'); } catch { return null; }
  const out = {};
  for (const line of text.split('\n')) {
    const [k, v] = line.split(':');
    if (['VmRSS', 'RssAnon', 'RssFile', 'Threads', 'VmSize'].includes(k)) out[k] = (v || '').trim();
  }
  return out;
}

function round(v, d) { const p = 10 ** d; return Math.round(v * p) / p; }

// ---------------------------------------------------------------- compare
function loadJsonl(path) {
  const rows = [];
  let i = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    i++;
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch (e) { console.error(`${path}:${i}: skip bad line: ${e.message}`); }
  }
  return rows;
}

const METRICS = [
  ['rssMB', 'RSS (MB)', 'lower'],
  ['heapUsedMB', 'V8 heapUsed (MB)', 'lower'],
  ['externalMB', 'external (MB)', 'lower'],
  ['arrayBuffersMB', 'ArrayBuffers (MB)', 'lower'],
  ['evP95Ms', 'eventLoopDelay p95 (ms)', 'lower'],
  ['evP99Ms', 'eventLoopDelay p99 (ms)', 'lower'],
  ['elu', 'eventLoopUtilization', 'lower'],
  ['cpuPercent', 'CPU (%)', 'lower'],
  ['smaps.rwSegments', 'rw-p segments', 'lower'],
  ['smaps.rwTotalMB', 'rw-p total (MB)', 'lower'],
  ['smaps.smallSegments', 'small segments', 'lower'],
  ['smaps.under1MB', 'segments <1MB', 'lower'],
  // 段数收敛后平均段变大是碎片合并的正常结果，不是退化：只给数、不判方向。
  ['smaps.smallAvgKB', 'small avg (KB)', 'neutral'],
];

function valueAt(row, path) {
  let v = row;
  for (const k of path.split('.')) v = v?.[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function percentile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

function stats(xs) {
  if (!xs.length) return null;
  return {
    min: Math.min(...xs), p50: percentile(xs, 0.5), p95: percentile(xs, 0.95),
    max: Math.max(...xs), n: xs.length,
  };
}

function fmt(s) {
  return s ? `min ${s.min.toFixed(2)}  p50 ${s.p50.toFixed(2)}  p95 ${s.p95.toFixed(2)}  max ${s.max.toFixed(2)}  n=${s.n}` : 'n/a';
}

function compare(before, after) {
  console.log(`before: ${before.length} samples   after: ${after.length} samples\n`);
  for (const [path, name, direction] of METRICS) {
    const a = stats(before.map((r) => valueAt(r, path)).filter((v) => v !== null));
    const b = stats(after.map((r) => valueAt(r, path)).filter((v) => v !== null));
    let delta = '';
    if (a && b && a.p50 !== 0 && direction !== 'neutral') {
      const d = ((b.p50 - a.p50) / Math.abs(a.p50)) * 100;
      delta = `  p50 ${d >= 0 ? '+' : ''}${d.toFixed(1)}%  [${d <= 0 ? 'OK' : 'WATCH'}]`;
    }
    console.log(`${name.padEnd(26)} BEFORE  ${fmt(a)}`);
    console.log(`${''.padEnd(26)} AFTER   ${fmt(b)}${delta}\n`);
  }
  console.log('── context ──');
  for (const k of ['online', 'rooms', 'matches', 'checkpointsEncoded', 'checkpointsSkipped']) {
    const a = before.map((r) => r[k]).filter((v) => v !== null && v !== undefined);
    const b = after.map((r) => r[k]).filter((v) => v !== null && v !== undefined);
    if (a.length || b.length) console.log(`${k.padEnd(26)} before ${a.at(-1) ?? 'n/a'}   after ${b.at(-1) ?? 'n/a'}`);
  }
  console.log('\n判读：RSS 与 rw-p 段数应收敛（min…max 变窄）；evP95Ms / cpuPercent 不得明显恶化。');
}

await main();
