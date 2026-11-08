#!/usr/bin/env node
// poc/walltest/proftop.mjs — function-level self-time top for a V8 .cpuprofile (--cpu-prof of the loadgen child
// server or any other), optionally time-sliced to a wall-clock window, with a system rollup for the wall-retest
// report (每席状态同步 / WS 写出 / GC / 定时器 / persist / 对局主线程 / 序列化 / 其他).
//
// Self time = the sum of the sample intervals that landed on a node (standard .cpuprofile attribution); the window
// filter keeps samples whose interval endpoint falls inside [--from, --to] (epoch ms; default: the whole profile).
//
// Usage:
//   node poc/walltest/proftop.mjs <file.cpuprofile> [--from <epochMs>] [--to <epochMs>] [--top 15] [--csv F] [--title S]

import { readFileSync, appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  opt[k] = v;
}
const TOP = Number(opt.top || 15);
const fromUs = opt.from != null ? Number(opt.from) * 1000 : -Infinity;
const toUs = opt.to != null ? Number(opt.to) * 1000 : Infinity;
const title = opt.title || file;

const p = JSON.parse(readFileSync(file, 'utf8'));
const nodes = new Map(p.nodes.map((n) => [n.id, n]));

// self µs per node id, samples sliced to the window
let busyUs = 0;
let windowStartUs = Infinity;
let windowEndUs = -Infinity;
const selfUs = new Map();
let t = p.startTime;
for (let i = 0; i < p.samples.length; i++) {
  const d = p.timeDeltas[i] || 0;
  t += d;
  if (t < fromUs || t > toUs) continue;
  busyUs += d;
  if (t < windowStartUs) windowStartUs = t;
  if (t > windowEndUs) windowEndUs = t;
  selfUs.set(p.samples[i], (selfUs.get(p.samples[i]) || 0) + d);
}

const ROOT_TAG = '/sp-wt-walltest/';
const shorten = (url) => {
  if (!url) return '';
  let f = url.replace(/^file:\/\//, '');
  const at = f.indexOf(ROOT_TAG);
  if (at >= 0) f = f.slice(at + ROOT_TAG.length - 1); // keep the leading '/'
  return f;
};

/** System rollup buckets (the wall-retest families; timer callbacks land under their own file, not the carrier). */
function categoryOf(frame) {
  const fn = frame.functionName || '(anonymous)';
  const url = frame.url || '';
  if (/garbage collector/i.test(fn)) return 'GC';
  if (!url) {
    if (fn === '(program)') return 'V8/调度(program)';
    if (fn === '(root)') return 'V8/调度(root)';
    if (fn === '(idle)') return 'idle';
    return `原生/${fn || 'anonymous'}`;
  }
  const f = shorten(url);
  if (f.startsWith('node:')) {
    if (/stream|net|socket|tls|http/.test(f)) return 'Node IO/socket';
    return 'Node 运行时';
  }
  if (/stateTransport|stateDelta|stateClocks/.test(f)) return '每席状态同步(帧)';
  if (/server\/net\.js|http\/websocket\.js|wsCompression|traffic\.js/.test(f)) return 'WS 写出/链路';
  if (/server\/persist|stateFile/.test(f)) return 'persist';
  if (/server\/match|server\/sim\//.test(f)) return '对局步进/规划(主线程)';
  if (/server\/lobby\.js/.test(f)) return '大厅/房间';
  if (/server\/http\//.test(f)) return 'HTTP/healthz';
  if (/processTimers|listOnTimeout/.test(fn)) return '定时器(承载)';
  return '其他';
}

const rows = [];
for (const [id, us] of selfUs) {
  const n = nodes.get(id);
  if (!n) continue;
  const cf = n.callFrame;
  rows.push({
    us,
    fn: cf.functionName || '(anonymous)',
    where: `${shorten(cf.url)}:${(cf.lineNumber ?? -1) + 1}`,
    cat: categoryOf(cf),
    url: cf.url,
  });
}
rows.sort((a, b) => b.us - a.us);

const totalS = busyUs / 1e6;
const wallS = (windowEndUs - windowStartUs) / 1e6;
console.log(`== ${title}`);
console.log(`window: ${Number.isFinite(windowStartUs) ? new Date(windowStartUs / 1000).toISOString() : '-'} … ${Number.isFinite(windowEndUs) ? new Date(windowEndUs / 1000).toISOString() : '-'} (span ${wallS.toFixed(1)} s wall, busy ${totalS.toFixed(1)} s, ${wallS > 0 ? ((totalS / wallS) * 100).toFixed(0) : '?'}% of wall)`);
console.log(`\n-- self-time top ${TOP} (of ${rows.length} sampled functions) --`);
for (const r of rows.slice(0, TOP)) {
  console.log(`${((r.us / busyUs) * 100).toFixed(1).padStart(5)}%  ${(r.us / 1e6).toFixed(2).padStart(7)}s  ${r.fn}  @ ${r.where}  [${r.cat}]`);
}
console.log(`\n-- system rollup --`);
const cats = new Map();
for (const r of rows) cats.set(r.cat, (cats.get(r.cat) || 0) + r.us);
for (const [cat, us] of [...cats].sort((a, b) => b[1] - a[1])) {
  console.log(`${((us / busyUs) * 100).toFixed(1).padStart(5)}%  ${(us / 1e6).toFixed(2).padStart(7)}s  ${cat}`);
}

if (opt.csv) {
  const csv = ['self_us,share_pct,function,location,category', ...rows.map((r) =>
    `${r.us},${((r.us / busyUs) * 100).toFixed(3)},"${r.fn.replace(/"/g, '""')}","${r.where}","${r.cat}"`)].join('\n');
  appendFileSync(String(opt.csv), `\n# ${title} from=${Number.isFinite(fromUs) ? new Date(fromUs / 1000).toISOString() : 'start'} to=${Number.isFinite(toUs) ? new Date(toUs / 1000).toISOString() : 'end'} busy_s=${totalS.toFixed(1)}\n${csv}\n`);
  console.log(`\ncsv appended to ${opt.csv}`);
}
