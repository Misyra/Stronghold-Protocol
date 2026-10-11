#!/usr/bin/env node
import { gameDiagnostics } from './lib/game-diagnostics.mjs';
/**
 * Stronghold Protocol 在线监控采集器（零第三方依赖，仅 Node 内置模块）
 *
 * 数据来源：
 *   1. 游戏服务 /healthz —— sockets / sessions / rooms / matches / humans / bots
 *   2. 本机 /proc + os —— CPU、内存、负载、磁盘、网卡速率、进程内存
 *   3. nginx 访问日志（增量解析）—— 今日独立访客 IP、页面浏览、素材请求、WS 连接次数、
 *      请求总数、错误数、出网流量
 *
 * 输出：
 *   GET /api/data    面板所需全部 JSON
 *   GET /api/health  采集器自检
 *
 * 基于用户提供的 sp-export/管理面板-collector.mjs 改造。
 * 仅监听回环；不生成 HTML。由站点 Agent 提供带鉴权的管理 API。
 */
import { LinuxDiagnostics } from './lib/linux-diagnostics.mjs';
import { RequestDiagnostics, RequestMinutes, parseAccessLine } from './lib/request-diagnostics.mjs';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DailyStats } from './lib/daily-stats.mjs';
import { sampleHistory, SampleWriter } from './lib/sample-history.mjs';
import { onlineCapacity } from './lib/metrics.mjs';
import { execFileSync } from 'node:child_process';
import { integer, loopback, periodic, fetchJson, safeUrl } from './lib/http.mjs';
import { dayKey, nginxDay, aggregateSeries, cpuTimesFromStat, cpuAccounting, cpuStealAccounting, parsePressure, diskCountersFromStats, diskRate, LogReader } from './lib/collector-utils.mjs';

const T0 = Date.now();

const CFG = {
  bind: process.env.MON_BIND || '127.0.0.1',
  timeZone: process.env.MON_TIME_ZONE || 'Asia/Shanghai',
  port: integer(process.env.MON_PORT, 3999, 1, 65535),
  healthz: process.env.MON_HEALTHZ || 'http://127.0.0.1:3000/healthz',
  dataDir: process.env.MON_DATA_DIR || '/opt/stronghold-monitor/data',
  intervalMs: integer(process.env.MON_INTERVAL_MS, 15000, 5000, 300000),
  nginxLog: process.env.MON_NGINX_LOG || '/var/log/nginx/game.rainya.me.access.log',
  retainDays: integer(process.env.MON_RETAIN_DAYS, 30, 1, 365),
  iface: process.env.MON_IFACE || 'eth0',
  // 磁盘 IO 性能指标（/proc/diskstats）统计的设备；留空自动取 / 挂载点设备（容器里请显式指定宿主设备）
  diskDev: process.env.MON_DISK_DEV || '',
  // 单轮最多解析的日志行数（超出部分顺延到下一轮，不丢数据）——把单轮 CPU 封顶
  logMaxLines: integer(process.env.MON_LOG_MAX_LINES, 10000, 1000, 500000),
  // 在线上限与告警阈值（面板横幅；不改变游戏服务行为）
  capacity: integer(process.env.MON_CAPACITY, 200, 1, 1000000),
  warnPct: integer(process.env.MON_WARN_PCT, 70, 1, 100),
  critPct: integer(process.env.MON_CRIT_PCT, 90, 1, 100),
};

if (!loopback(CFG.bind)) throw new Error('Collector must bind to loopback');
if (CFG.warnPct > CFG.critPct) throw new Error('MON_WARN_PCT must not exceed MON_CRIT_PCT');
dayKey(new Date(), CFG.timeZone); // Validate timezone before writing data.
safeUrl(CFG.healthz);

fs.mkdirSync(CFG.dataDir, { recursive: true });

const RING_MAX = Math.ceil((25 * 3600 * 1000) / CFG.intervalMs);
/** 最近 25h 的采样点（内存环形缓冲，重启后从文件恢复） */
const ring = [];
let last = null;
let seq = 0;
let alertLevel = 'ok';
const sampleWriter = new SampleWriter(CFG.dataDir, RING_MAX);

// ---------------------------------------------------------------------------- 每日统计

const stats = new DailyStats({ dir: CFG.dataDir, timeZone: CFG.timeZone, retainDays: CFG.retainDays });
const logReader = new LogReader(CFG.nginxLog);
const requestMinutes = new RequestMinutes({ state: stats.requestMinutes });
const diagnostics = { nginx: { status: 'missing', error: 'NO_SAMPLE' }, storage: { status: 'ok', error: null } };
const storageFailures = new Set();
let lastLogAt = null, logBacklogBytes = null;
function storageIO(section, work) {
  try { work(); storageFailures.delete(section); }
  catch (error) {
    if (!storageFailures.has(section)) console.warn('[monitor] 统计落盘失败:', section, error.code || 'WRITE_FAILED');
    storageFailures.add(section);
  }
  diagnostics.storage = { status: storageFailures.size ? 'error' : 'ok', error: storageFailures.size ? 'STORAGE_WRITE_FAILED' : null };
  return !storageFailures.has(section);
}
function saveDay(force = false) { return storageIO('daily', () => stats.save(force)); }
function loadState() {
  try {
    const files = fs.readdirSync(CFG.dataDir).filter(f => /^samples-\d{4}-\d\d-\d\d\.jsonl$/.test(f)).sort().slice(-2);
    for (const file of files) {
      for (const line of fs.readFileSync(path.join(CFG.dataDir, file), 'utf8').trim().split('\n').slice(-RING_MAX)) {
        try { const s = JSON.parse(line); if (Number.isFinite(s.t) && typeof s.game === 'boolean') ring.push(s); } catch {}
      }
    }
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    last = ring.at(-1) || null;
  } catch {}
  pruneOldSamples();
}

function pruneOldSamples() {
  try {
    const keep = new Set();
    const now = Date.now();
    for (let i = 0; i <= CFG.retainDays; i++) keep.add(dayKey(new Date(now - i * 86400000), CFG.timeZone));
    for (const f of fs.readdirSync(CFG.dataDir)) {
      const m = /^samples-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (m && !keep.has(m[1])) { fs.unlinkSync(path.join(CFG.dataDir, f)); continue; }
      const d = /^daily-(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
      if (d && !keep.has(d[1])) fs.unlinkSync(path.join(CFG.dataDir, f));
    }
  } catch { /* 忽略 */ }
}

// ---------------------------------------------------------------------------- nginx 日志
const LOG_RE = /^(\S+) \S+ \S+ \[[^\]]+\] "([^"]*)" (\d{3}) (\d+|-)/;

function logStatus(code = null) {
  if (code && diagnostics.nginx.error !== code) console.warn('[monitor] nginx 日志不可用:', code);
  diagnostics.nginx = { status: code ? 'error' : 'ok', error: code };
}
let requestDiagnostics = new RequestDiagnostics();
function parseNginx() {
  requestDiagnostics = new RequestDiagnostics();
  let batch;
  try {
    batch = logReader.read(stats.checkpoint, { maxLines: CFG.logMaxLines });
  } catch (error) {
    const code = error.code === 'ENOENT' ? 'LOG_MISSING' : ['EACCES', 'EPERM'].includes(error.code) ? 'LOG_UNREADABLE' :
      error.code === 'LOG_LINE_TOO_LONG' ? 'LOG_LINE_TOO_LONG' : 'LOG_READ_FAILED';
    logStatus(code); requestMinutes.invalidate();
    return;
  }
  const { lines } = batch;
  stats.consume(batch); logBacklogBytes = batch.backlogBytes;
  let recognized = 0;
  for (const line of lines) {
    const date = nginxDay(line, CFG.timeZone), m = LOG_RE.exec(line);
    if (!date || !m) { requestMinutes.invalidate(); continue; }
    recognized++;
    const request = parseAccessLine(line);
    requestDiagnostics.ingest(request); requestMinutes.ingest(request);
    const stamp = /\[(\d\d)\/([A-Za-z]{3})\/(\d{4}):(\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d)\]/.exec(line);
    if (stamp) lastLogAt = Date.parse(stamp[1] + ' ' + stamp[2] + ' ' + stamp[3] + ' ' + stamp[4] + ' ' + stamp[5] + stamp[6]);
    const route = (m[2].split(' ')[1] || '').split('?')[0];
    stats.ingest({ date, ip: m[1], route, status: m[3], bytes: m[4] });
  }
  if (batch.gap) { logStatus('LOG_ROTATION_GAP'); requestMinutes.invalidate(); return; }
  // With no new lines, retain a format error until a recognizable line actually arrives.
  if (lines.length) logStatus(recognized ? null : 'LOG_FORMAT_INVALID');
  else if (diagnostics.nginx.error !== 'LOG_FORMAT_INVALID') logStatus();
}

// ---------------------------------------------------------------------------- 系统指标
let cpuPrev = null;
let netPrev = null;

function readCpuTimes() {
  if (os.platform() === 'win32') {
    // Windows has no iowait accounting in os.cpus(); 1 − idle is the best available there.
    let idle = 0, total = 0;
    for (const c of os.cpus()) { for (const k of Object.keys(c.times)) total += c.times[k]; idle += c.times.idle; }
    return { idle, iowait: 0, total };
  }
  try { return cpuTimesFromStat(fs.readFileSync('/proc/stat', 'utf8').split('\n').find((l) => l.startsWith('cpu '))); }
  catch { return null; }
}

// cpu = 100 − idle − iowait (true busy, matches mpstat/sar busy); iowaitPct is separate, so
// cpu + iowait always equals top's 1 − idle. See cpuAccounting in lib/collector-utils.mjs.
function cpuSample() {
  const cur = readCpuTimes();
  const result = { ...cpuAccounting(cur, cpuPrev), stealPct: cpuStealAccounting(cur, cpuPrev) };
  cpuPrev = cur;
  return result;
}

// PSI avg10 per resource; files may not exist (old kernels / disabled PSI) — stays null.
function readPressureSample() {
  const files = {};
  for (const key of ['cpu', 'io', 'memory']) {
    try { files[key] = fs.readFileSync(`/proc/pressure/${key}`, 'utf8'); } catch { /* PSI unavailable */ }
  }
  return parsePressure(files);
}

// 磁盘设备自动发现：/ 挂载点对应的块设备名（diskstats 里的名字不带 /dev/ 前缀）。
function detectRootDevice() {
  try {
    for (const line of fs.readFileSync('/proc/self/mounts', 'utf8').split('\n')) {
      const f = line.split(/\s+/);
      if (f[1] === '/' && f[0].startsWith('/dev/')) return f[0].replace(/^\/dev\//, '');
    }
  } catch { /* 无 /proc（win32/容器）时保持 null，磁盘 IO 指标为 — */ }
  return null;
}
CFG.diskDev = CFG.diskDev || detectRootDevice();

// 磁盘 IO：两个采样点之间算 delta（读/写 KB/s、%util、每操作等待 ms）。
let diskPrev = null;
function diskSample(dtSec) {
  let cur = null;
  try { cur = diskCountersFromStats(fs.readFileSync('/proc/diskstats', 'utf8'), CFG.diskDev); } catch { cur = null; }
  const rate = diskRate(cur, diskPrev, dtSec);
  diskPrev = cur;
  return rate;
}

function netRate(dtSec) {
  let cur = null;
  try {
    const txt = fs.readFileSync('/proc/net/dev', 'utf8');
    for (const line of txt.split('\n')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      if (line.slice(0, i).trim() !== CFG.iface) continue;
      const f = line.slice(i + 1).trim().split(/\s+/).map(Number);
      cur = { rx: f[0], tx: f[8] };
    }
  } catch { return { rxKB: null, txKB: null }; }
  if (!cur || !netPrev || dtSec <= 0) { netPrev = cur; return { rxKB: null, txKB: null }; }
  const r = { rxKB: Math.round(Math.max(0, (cur.rx - netPrev.rx) / 1024 / dtSec)), txKB: Math.round(Math.max(0, (cur.tx - netPrev.tx) / 1024 / dtSec)) };
  netPrev = cur;
  return r;
}

// 进程 RSS：每 RESCAN_EVERY 轮才做一次全量 /proc 扫描，其余轮次只回读缓存的几个 pid——
// 全扫要逐个读几百个 /proc/<pid>/cmdline，缓存后单轮固定只读个位数的文件。
const RESCAN_EVERY = 15;
let pidCache = null;
const needGameRss = true;
let samplesSinceScan = 0;
function findMonitoredPids() {
  const whichOf = (cmd) => needGameRss && cmd.includes('server/index.js') ? 'game' : cmd.includes('nginx') ? 'nginx' : null;
  const verify = () => pidCache.filter(({ pid, which }) => {
    try { return whichOf(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')) === which; } catch { return false; }
  });
  samplesSinceScan++;
  // 游戏进程不在缓存里（刚启动/刚重启/首次运行）时立即重扫，避免 RSS 空转一整个重扫周期。
  if (!pidCache || samplesSinceScan >= RESCAN_EVERY || (needGameRss && !pidCache.some((p) => p.which === 'game'))) {
    samplesSinceScan = 0; pidCache = [];
    let names = [];
    try { names = fs.readdirSync('/proc'); } catch { return pidCache; }
    for (const n of names) {
      const c0 = n.charCodeAt(0);
      if (!(c0 >= 48 && c0 <= 57)) continue;
      let cmd = '';
      try { cmd = fs.readFileSync(`/proc/${n}/cmdline`, 'utf8'); } catch { continue; }
      if (!cmd) continue;
      const which = whichOf(cmd);
      if (which) pidCache.push({ pid: n, which });
    }
    return pidCache;
  }
  pidCache = verify();
  return pidCache;
}

function rssOf(gameRss) {
  // Keep the game PID for thread diagnostics even when health already supplies RSS.
  if (os.platform() === 'win32') return { game: gameRss, nginx: null };
  const out = { game: 0, nginx: 0 };
  for (const { pid, which } of findMonitoredPids()) {
    try {
      const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
      if (m) out[which] += Number(m[1]) / 1024;
    } catch { /* 进程已退出，下轮缓存校验会清掉 */ }
  }
  out.game = gameRss ?? Math.round(out.game * 10) / 10;
  out.nginx = Math.round(out.nginx * 10) / 10;
  return out;
}

/** 443 端口上的并发连接与独立客户端 IP。直接解析 /proc/net/tcp{,6}（state 01 = established），
 *  避免每轮采样都 fork 一次 ss；/proc 不可读时退回 ss。 */
function clientConns() {
  const byIp = new Map();
  let total = 0, read = 0;
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    read++;
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 4 || f[3] !== '01') continue;
      if (parseInt(f[1].split(':')[1], 16) !== 443) continue;
      const ip = f[2].split(':')[0];
      if (!ip) continue;
      byIp.set(ip, (byIp.get(ip) || 0) + 1);
      total++;
    }
  }
  if (read > 0) return { total, unique: byIp.size };
  try {
    // -H 去掉表头；ss 在按 state 过滤时不打印状态列，故按位置取：
    // Recv-Q Send-Q 本地地址 对端地址 [进程]
    const out = execFileSync('ss', ['-Htn', 'state', 'established'], { encoding: 'utf8', timeout: 5000 });
    for (const line of out.split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f.length < 4) continue;
      if (!f[2] || !f[2].endsWith(':443')) continue;
      const ip = f[3].replace(/:\d+$/, '');
      if (!ip) continue;
      byIp.set(ip, (byIp.get(ip) || 0) + 1);
      total++;
    }
    return { total, unique: byIp.size };
  } catch { return { total: null, unique: null }; }
}

/** 跨过阈值时往 journal 打一条告警（可在 journalctl -u stronghold-monitor 看到）。 */
function alertCheck(s) {
  const cap = CFG.capacity;
  const lvl = onlineCapacity(s, { limit: cap, warnPct: CFG.warnPct, critPct: CFG.critPct, cores: os.cpus().length }).level;
  if (lvl !== alertLevel) {
    console.log(`[monitor][alert] ${alertLevel} -> ${lvl} · 在线 ${s.sockets ?? '?'}/${cap} · 保留会话 ${s.sessions ?? '?'} · 负载 ${s.load1} · CPU ${s.cpu}%（IO 等待 ${s.iowaitPct}%） · PSI IO some/full ${s.psiIoSome}/${s.psiIoFull} · 出网 ${s.txKB} KB/s · 5xx ${stats.today.errors}`);
    alertLevel = lvl;
  }
}

function diskInfo() {
  try {
    const s = fs.statfsSync('/');
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return {
      pct: Math.round(((total - free) / total) * 1000) / 10,
      freeGB: Math.round((free / 1024 ** 3) * 10) / 10,
      totalGB: Math.round((total / 1024 ** 3) * 10) / 10,
    };
  } catch { return { pct: null, freeGB: null, totalGB: null }; }
}

// ---------------------------------------------------------------------------- 采样
async function sampleGame() {
  const t0 = Date.now();
  try {
    const j = await fetchJson(CFG.healthz, { timeoutMs: 10000, maxBytes: 64 * 1024 });
    const latencyMs = Date.now() - t0;
    return { ...j, ok: j.ok === true, latencyMs };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, error: e?.name === 'TimeoutError' ? 'timeout' : (e?.message || String(e)) };
  }
}

let lastSlowWarnAt = 0;
let clockTicks = null;
if (os.platform() === 'linux') { try { const n = Number(execFileSync('getconf', ['CLK_TCK'], {encoding:'utf8',timeout:1000})); if(Number.isFinite(n) && n>0)clockTicks=n; } catch { /* CPU unknown without the platform clock tick rate */ } }
const linuxDiagnostics = new LinuxDiagnostics({ticksPerSec:clockTicks});

async function takeSample() {
  const sampleStartedAt = Date.now();
  stats.rollover(); parseNginx();
  const g = await sampleGame();
  const dt = last ? Math.max(1, (Date.now() - last.t) / 1000) : CFG.intervalMs / 1000;
  // Failed health checks must not look like fresh game counts.
  const net = netRate(dt);
  const cpu = cpuSample();
  const psi = readPressureSample();
  const disk = diskSample(dt);
  const memTotal = Math.round(os.totalmem() / 1024 ** 2);
  const memUsed = memTotal - Math.round(os.freemem() / 1024 ** 2);
  const gameRss = g.ok && typeof g.memory?.rss === 'number' && Number.isFinite(g.memory.rss) && g.memory.rss >= 0 ? Math.round(g.memory.rss / 1024 ** 2 * 10) / 10 : null;
  const rss = rssOf(gameRss);
  const d = diskInfo();
  const cc = clientConns();
  const s = {
    ...requestDiagnostics.snapshot(diagnostics.nginx.status === 'ok'),
    ...requestMinutes.snapshot({ok:diagnostics.nginx.status === 'ok',backlogBytes:logBacklogBytes}),
    requestMinuteWindows: requestMinutes.updates({ok:diagnostics.nginx.status === 'ok',backlogBytes:logBacklogBytes}),
    seq: ++seq, sampleId: randomUUID(),
    t: Date.now(),
    game: g.ok,
    sockets: g.ok ? (g.sockets ?? null) : null,
    sessions: g.ok ? (g.sessions ?? null) : null,
    rooms: g.ok ? (g.rooms ?? null) : null,
    matches: g.ok ? (g.matches ?? null) : null,
    humans: g.ok ? (g.humans ?? null) : null,
    bots: g.ok ? (g.bots ?? null) : null,
    uptimeSec: g.ok ? g.uptimeSec : null,
    app: g.ok ? g.app : null,
    healthzMs: g.latencyMs ?? null,
    ...gameDiagnostics(g),
    ...linuxDiagnostics.sample({pid: os.platform() === 'linux' ? (() => { const games=findMonitoredPids().filter(p=>p.which==='game'); return games.length===1 ? games[0].pid : null; })() : null, iface:CFG.iface}),
    cpu: cpu.pct,
    iowaitPct: cpu.iowaitPct,
    cpuStealPct: cpu.stealPct,
    psiCpuSome: psi.cpuSome, psiCpuFull: psi.cpuFull,
    psiIoSome: psi.ioSome, psiIoFull: psi.ioFull,
    psiMemSome: psi.memSome, psiMemFull: psi.memFull,
    memPct: Math.round((memUsed / memTotal) * 1000) / 10,
    memUsedMB: memUsed,
    memTotalMB: memTotal,
    load1: os.platform() === 'win32' ? null : Math.round(os.loadavg()[0] * 100) / 100,
    load5: os.platform() === 'win32' ? null : Math.round(os.loadavg()[1] * 100) / 100,
    load15: os.platform() === 'win32' ? null : Math.round(os.loadavg()[2] * 100) / 100,
    diskPct: d.pct,
    diskFreeGB: d.freeGB,
    diskReadKBS: disk.readKBS,
    diskWriteKBS: disk.writeKBS,
    diskUtilPct: disk.utilPct,
    diskAwaitMs: disk.awaitMs,
    rxKB: net.rxKB,
    txKB: net.txKB,
    gameRssMB: rss.game,
    nginxRssMB: rss.nginx,
    conns: cc.total,
    connsUniqueIps: cc.unique,
    hostUptimeSec: Math.round(os.uptime()),
    logBacklogBytes, logLagSec: logBacklogBytes > 0 && Number.isFinite(lastLogAt) ? Math.max(0, Math.round((Date.now() - lastLogAt) / 1000)) : logBacklogBytes === 0 ? 0 : null,
  };
  s.collectorLocalMs = Math.max(0, Date.now() - sampleStartedAt - (g.latencyMs || 0));
  stats.rollover(); stats.peaks(s);
  alertCheck(s);
  last = s;
  ring.push(s);
  if (ring.length > RING_MAX) ring.shift();
  s.monitor = { diagnostics: structuredClone(diagnostics), today: stats.snapshot().today, timeZone: CFG.timeZone, intervalSec: CFG.intervalMs / 1000, collectorUptimeSec: Math.round((s.t - T0) / 1000), samples: ring.length, capacity: capacity() };
  sampleWriter.enqueue(`samples-${dayKey(new Date(s.t), CFG.timeZone)}.jsonl`, s);
  storageIO('samples', () => sampleWriter.flush());
  stats.requestMinutes = requestMinutes.serialize();
  saveDay();
  // 本地工作（不含健康检查的网络等待）超过 1 秒提示一次——正常只有几毫秒，出现说明日志积压或负载异常。
  const localMs = Date.now() - sampleStartedAt - (g.latencyMs || 0);
  if (localMs > 1000 && Date.now() - lastSlowWarnAt > 300000) {
    lastSlowWarnAt = Date.now();
    console.warn(`[monitor] 本轮本地采样耗时 ${localMs}ms（>1s），可增大 MON_INTERVAL_MS 或调小 MON_LOG_MAX_LINES`);
  }
}

// ---------------------------------------------------------------------------- API
function buildSeries(hours) { return aggregateSeries(ring, Date.now() - hours * 3600 * 1000); }

function capacity() { return { basis: 'sockets', limit: CFG.capacity, warnPct: CFG.warnPct, critPct: CFG.critPct, level: alertLevel, cores: os.cpus().length }; }
function apiData() {
  const daily = stats.snapshot();
  return {
    now: Date.now(),
    diagnostics: structuredClone(diagnostics),
    timeZone: CFG.timeZone,
    collectorUptimeSec: Math.round((Date.now() - T0) / 1000),
    intervalSec: Math.round(CFG.intervalMs / 1000),
    capacity: capacity(),
    current: last ? { ...last, monitor: undefined } : null,
    series: buildSeries(24),
    today: daily.today, history: daily.history,
    capabilities: { sampleHistory: true },
    samples: ring.length,
  };
}

function json(req, res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(req.method === 'HEAD' ? undefined : body);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); return json(req, res, 405, { error: 'read only' }); }
  const u = (req.url || '/').split('?')[0];
  if (u === '/api/samples') {
    try { const url = new URL(req.url, 'http://localhost'); return json(req, res, 200, sampleHistory(CFG.dataDir, { cursor: url.searchParams.get('cursor'), limit: url.searchParams.get('limit') || 200 })); }
    catch (error) { return json(req, res, error.code === 'INVALID_CURSOR' || error.message.startsWith('Expected an integer') ? 400 : 503, { error: { code: error.code || 'HISTORY_UNAVAILABLE' } }); }
  }
  if (u === '/api/data') return json(req, res, 200, apiData());
  if (u === '/api/health') return json(req, res, 200, { ok: true, ready: !!last && Date.now() - last.t <= Math.max(45000, CFG.intervalMs * 3), degraded: Object.values(diagnostics).some(s => s.status === 'error'), diagnostics, uptimeSec: Math.round((Date.now() - T0) / 1000), samples: ring.length });
  return json(req, res, 404, { ok: false, error: 'not found' });
});

server.listen(CFG.port, CFG.bind, () => {
  console.log(`[monitor] listening http://${CFG.bind}:${CFG.port} · interval ${CFG.intervalMs / 1000}s · data ${CFG.dataDir}`);
  console.log(`[monitor] game ${CFG.healthz} · nginx log ${CFG.nginxLog}`);
});

loadState();
const polling = periodic(takeSample, CFG.intervalMs, (e) => console.error('[monitor] 采样失败:', e?.message || e));

async function shutdown() { await polling.stop(); try { saveDay(true); sampleWriter.flush(); } catch {} logReader.close(); server.close(() => process.exit(0)); server.closeIdleConnections(); }
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
