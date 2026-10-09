import fs from 'node:fs';
import path from 'node:path';
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

// Pure text splitting helper. A caller retaining carried must not also rewind its read position.
// The collector uses readLogBatch instead, checkpointing only consumed byte positions.
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

// Checkpoints are byte positions immediately after complete lines. Unprocessed bytes stay on disk,
// so neither a line budget nor a partial UTF-8 sequence can duplicate data or grow a carried buffer.
export function readLogBatch(file, checkpoint = {}, { maxLines = 10000, maxBytes = 4 * 1024 * 1024, fd: suppliedFd } = {}) {
  const fd = suppliedFd ?? fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw Object.assign(new Error('Log must be a regular file'), { code: 'LOG_READ_FAILED' });
    let offset = Number.isSafeInteger(checkpoint.offset) && checkpoint.offset >= 0 ? checkpoint.offset : 0;
    if (stat.ino !== checkpoint.ino || stat.size < offset) offset = 0;
    const len = Math.min(maxBytes, stat.size - offset);
    const buf = Buffer.alloc(len);
    const lines = [];
    let read = 0, start = 0, scanFrom = 0;
    // Small reads stop as soon as the line budget is spent; a large backlog is not reread in full.
    while (read < len && lines.length < maxLines) {
      const count = fs.readSync(fd, buf, read, Math.min(64 * 1024, len - read), offset + read);
      if (!count) break;
      read += count;
      let end;
      while (lines.length < maxLines && (end = buf.subarray(0, read).indexOf(10, scanFrom)) >= 0) {
        lines.push(buf.toString('utf8', start, end));
        start = end + 1; scanFrom = start;
      }
      scanFrom = read;
    }
    if (!start && read === maxBytes) {
      throw Object.assign(new Error('Log line exceeds read budget'), { code: 'LOG_LINE_TOO_LONG' });
    }
    return { lines, offset: offset + start, ino: stat.ino, inoKey: String(fs.fstatSync(fd, { bigint: true }).ino), backlogBytes: Math.max(0, stat.size - offset - start) };
  } finally { if (suppliedFd == null) fs.closeSync(fd); }
}

// Keep the old inode alive across nginx rename/reopen. On restart, locate an uncompressed
// rotated file by inode before moving to the active log; never silently abandon unread bytes.
export class LogReader {
  constructor(file) { this.file = file; this.fd = null; this.drained = new Set(); }
  open(checkpoint) {
    let file = this.file;
    const current = fs.statSync(file);
    if (checkpoint.ino && checkpoint.ino !== current.ino) {
      const dir = path.dirname(this.file);
      const base = path.basename(this.file);
      let found = false;
      let names = []; try { names = fs.readdirSync(dir); } catch {}
      for (const name of names) {
        if ((!name.startsWith(base + '.') && !name.startsWith(base + '-')) || name.endsWith('.gz')) continue;
        const candidate = path.join(dir, name);
        try { const stat = fs.statSync(candidate); if (stat.isFile() && stat.ino === checkpoint.ino) { file = candidate; found = true; break; } } catch {}
      }
      this.gap = !found;
    }
    this.fd = fs.openSync(file, 'r');
  }
  read(checkpoint = {}, options = {}) {
    if (this.fd == null) this.open(checkpoint);
    let stat = fs.fstatSync(this.fd), current = fs.statSync(this.file);
    if (stat.ino !== current.ino && checkpoint.ino === stat.ino && checkpoint.offset >= stat.size) {
      const dir = path.dirname(this.file), base = path.basename(this.file);
      let rotations = [];
      try {
        rotations = fs.readdirSync(dir).filter(name => (name.startsWith(base + '.') || name.startsWith(base + '-')) && !name.endsWith('.gz'))
          .map(name => ({ name, file: path.join(dir, name), stat: fs.statSync(path.join(dir, name)) })).filter(item => item.stat.isFile());
      } catch {}
      const old = rotations.find(item => item.stat.ino === stat.ino);
      this.drained.add(stat.ino); rotations = rotations.filter(item => !this.drained.has(item.stat.ino));
      let next;
      const suffix = old?.name.slice(base.length + 1);
      if (suffix && /^\d{1,4}$/.test(suffix)) {
        const number = Number(suffix);
        if (number > 1) {
          next = rotations.filter(item => /^\d{1,4}$/.test(item.name.slice(base.length + 1)) && Number(item.name.slice(base.length + 1)) < number)
            .sort((a, b) => Number(b.name.slice(base.length + 1)) - Number(a.name.slice(base.length + 1)))[0];
          if (!next || Number(next.name.slice(base.length + 1)) !== number - 1) this.gap = true;
        }
      } else if (suffix && /^\d{4}[-_.]?\d{2}[-_.]?\d{2}/.test(suffix)) {
        next = rotations.filter(item => item.name.slice(base.length + 1) > suffix).sort((a, b) => a.name.localeCompare(b.name))[0];
      } else {
        next = rotations.filter(item => item.stat.ino !== stat.ino && (item.stat.mtimeMs > stat.mtimeMs || old && item.stat.mtimeMs === stat.mtimeMs && item.name > old.name))
          .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.name.localeCompare(b.name))[0];
      }
      this.close(); this.fd = fs.openSync(next?.file || this.file, 'r'); stat = fs.fstatSync(this.fd);
    }
    const result = readLogBatch(this.file, checkpoint, { ...options, fd: this.fd });
    current = fs.statSync(this.file);
    if (current.ino !== result.ino) result.backlogBytes += current.size;
    result.gap = this.gap === true; this.gap = false;
    return result;
  }
  close() { if (this.fd != null) fs.closeSync(this.fd); this.fd = null; }
}
