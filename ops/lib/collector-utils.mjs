import fs from 'node:fs';
const formatters = new Map();
export function dayKey(date = new Date(), timeZone = 'Asia/Shanghai') {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, formatter);
  }
  return formatter.format(date);
}

export function nginxDay(line, timeZone = 'Asia/Shanghai') {
  const m = /\[(\d\d)\/([A-Za-z]{3})\/(\d{4}):(\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)\]/.exec(line);
  if (!m) return null;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(m[2]) + 1;
  if (!month) return null;
  const date = new Date(`${m[3]}-${String(month).padStart(2, '0')}-${m[1]}T${m[4]}${m[5]}:${m[6]}`);
  return Number.isFinite(date.getTime()) ? dayKey(date, timeZone) : null;
}

export function privateAddress(ip) {
  ip = ip.toLowerCase().replace(/^::ffff:/, '');
  if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')) return true;
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

export function atomicJson(file, value) {
  const temp = `${file}.tmp-${process.pid}`;
  try {
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
}

// Full CPU accounting from /proc/stat. os.cpus() drops iowait/softirq/steal, so under IO load the
// old busy/(busy+idle) ratio inflated wildly. Here: cpu = 100 − idle − iowait ("true busy"),
// iowaitPct reported separately — cpu + iowait always equals top's 1 − idle for easy cross-checks.
export function cpuTimesFromStat(line) {
  if (typeof line !== 'string' || !line.startsWith('cpu ')) return null;
  const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (fields.length < 8 || fields.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const [user, nice, system, idle, iowait, irq, softirq, steal] = fields;
  return { idle, iowait, total: user + nice + system + idle + iowait + irq + softirq + steal };
}

export function cpuAccounting(cur, prev) {
  if (!cur || !prev || cur.total <= prev.total) return { pct: null, iowaitPct: null };
  const dt = cur.total - prev.total;
  const idle = Math.max(0, cur.idle - prev.idle), iowait = Math.max(0, cur.iowait - prev.iowait);
  const busy = Math.max(0, dt - idle - iowait);
  return { pct: Math.round(busy / dt * 1000) / 10, iowaitPct: Math.round(iowait / dt * 1000) / 10 };
}

// PSI (pressure stall information) from /proc/pressure/{cpu,io,memory}: avg10 of "some" (part of the
// tasks stalled) and "full" (all tasks stopped), i.e. the share of time the resource made work slow.
// A missing "full" line (older kernels) or a missing file stays null — never zero.
export function parsePressure(files) {
  const out = { cpuSome: null, cpuFull: null, ioSome: null, ioFull: null, memSome: null, memFull: null };
  for (const [key, text] of Object.entries(files || {})) {
    if (typeof text !== 'string') continue;
    for (const line of text.split('\n')) {
      const m = /^(some|full)\s+avg10=([\d.]+)/.exec(line);
      if (!m) continue;
      const field = key === 'memory' ? 'mem' : key;
      out[`${field}${m[1] === 'some' ? 'Some' : 'Full'}`] = Math.min(100, Math.round(Number(m[2]) * 10) / 10);
    }
  }
  return out;
}

// 按每轮预算切分日志文本：超出预算的完整行连同不完整尾巴一起留在 carried 里，下一轮从该字节
// 位置继续读——不加轮次预算会允许最坏情况下单轮解析上百 MB，上限保证了单轮 CPU 有界且不丢行。
export function logChunkLines(text, maxLines = Infinity) {
  const lines = String(text).split('\n');
  const carried = lines.pop() || '';
  if (lines.length <= maxLines) return { lines, carried };
  const rest = lines.slice(maxLines);
  return { lines: lines.slice(0, maxLines), carried: `${rest.join('\n')}\n${carried}` };
}

// /proc/diskstats fields 4-14 (Linux): reads readsMerged sectorsRead msReading writes writesMerged
// sectorsWritten msWriting inProgress msDoingIO weightedMs. Sectors are 512 bytes.
export function parseDiskLine(line) {
  const fields = String(line || '').trim().split(/\s+/);
  if (fields.length < 14) return null;
  const n = fields.slice(3, 14).map(Number);
  if (n.length < 11 || n.some((v) => !Number.isFinite(v) || v < 0)) return null;
  const [reads, readsMerged, sectorsRead, msReading, writes, writesMerged, sectorsWritten, msWriting, inProgress, msDoingIO, weightedMs] = n;
  return { reads, readsMerged, sectorsRead, msReading, writes, writesMerged, sectorsWritten, msWriting, inProgress, msDoingIO, weightedMs };
}

export function diskCountersFromStats(text, dev) {
  if (typeof text !== 'string' || typeof dev !== 'string' || !dev) return null;
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f[2] === dev) return parseDiskLine(line);
  }
  return null;
}

// Deltas between two /proc/diskstats samples. utilPct is the classic %util (busy share of the
// interval); awaitMs is the rough per-op service time (read+write ticks / completed ops) — pair it
// with PSI IO to tell "disk is the bottleneck" from "disk is merely used".
export function diskRate(cur, prev, dtSec) {
  const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;
  if (!cur || !prev || dtSec <= 0) return { readKBS: null, writeKBS: null, utilPct: null, awaitMs: null };
  const d = (key) => Math.max(0, cur[key] - prev[key]);
  const ops = d('reads') + d('writes');
  return {
    readKBS: round(d('sectorsRead') * 0.5 / dtSec, 1),
    writeKBS: round(d('sectorsWritten') * 0.5 / dtSec, 1),
    utilPct: round(Math.min(100, d('msDoingIO') / (dtSec * 1000) * 100), 1),
    awaitMs: ops > 0 ? round((d('msReading') + d('msWriting')) / ops, 1) : null,
  };
}

export function aggregateSeries(samples, from) {
  const keys = ['sessions', 'sockets', 'humans', 'bots', 'cpu', 'psiIoSome'];
  const peaks = ['sockets', 'humans', 'bots', 'cpu', 'psiIoSome'];
  const buckets = new Map();
  for (const sample of samples) {
    if (sample.t < from) continue;
    const t = Math.floor(sample.t / 300000) * 300000;
    const bucket = buckets.get(t) || { t, sessions: [], sockets: [], humans: [], bots: [], cpu: [], psiIoSome: [] };
    for (const key of keys) {
      // CPU and IO pressure are measured independently of game health; game counts follow the game.
      const value = key === 'cpu' || key === 'psiIoSome' || sample.game === true ? sample[key] : null;
      if (typeof value === 'number' && Number.isFinite(value)) bucket[key].push(value);
    }
    buckets.set(t, bucket);
  }
  // Peaks per bucket for online seats/CPU/pressure so short spikes survive; sessions keep their mean
  // because the capacity threshold compares against the sustained reserved-session count.
  return [...buckets.values()].sort((a, b) => a.t - b.t).map((b) => ({ t: b.t,
    ...Object.fromEntries(keys.map((key) => [key, !b[key].length ? null :
      peaks.includes(key) ? Math.max(...b[key]) : Math.round(b[key].reduce((sum, n) => sum + n, 0) / b[key].length)])) }));
}
