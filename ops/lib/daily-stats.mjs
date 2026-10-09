import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, dayKey, privateAddress } from './collector-utils.mjs';

export const TRAFFIC_KEYS = ['requests', 'pageViews', 'assetHits', 'wsConnects', 'aborts', 'errors', 'bytes',
  'peakSessions', 'peakSockets', 'peakHumans', 'peakBots', 'peakTxKB'];
const empty = date => ({ date, ...Object.fromEntries(TRAFFIC_KEYS.map(k => [k, k === 'peakBots' ? null : 0])), ips: [] });
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// A single atomic recovery frame commits BOTH counts and the log cursor. Daily files/history
// are projections of that frame, so interruption between writes cannot double-count a replay.
export class DailyStats {
  constructor({ dir, timeZone = 'Asia/Shanghai', retainDays = 30, now = Date.now }) {
    this.dir = dir; this.timeZone = timeZone; this.retainDays = retainDays; this.now = now;
    this.days = new Map(); this.dirty = new Set(); this.history = {};
    this.checkpoint = {}; this.lastSave = 0; this.checkpointDirty = false;
    this.stateFile = path.join(dir, 'collector-state.json');
    const frame = read(this.stateFile);
    const names = fs.readdirSync(dir).filter(f => /^daily-\d{4}-\d\d-\d\d\.json$/.test(f)).sort();
    this.history = read(path.join(dir, 'daily-history.json')) || {};
    let latest;
    for (const name of names) {
      const day = read(path.join(dir, name));
      if (!day || typeof day.date !== 'string') continue;
      this.history[day.date] = this.summary(day); latest = day;
    }
    if (frame?.schemaVersion === 1 && Array.isArray(frame.days)) {
      this.checkpoint = frame.checkpoint || {};
      for (const day of frame.days) {
        if (!/^\d{4}-\d\d-\d\d$/.test(day?.date)) continue;
        this.cache(day); this.dirty.add(day.date); this.history[day.date] = this.summary(day);
      }
    } else if (latest) this.checkpoint = { offset: latest.logOffset || 0, ino: latest.logIno || 0 };
    this.rollover();
  }
  key() { return dayKey(new Date(this.now()), this.timeZone); }
  cache(day) {
    const value = { ...empty(day.date), ...day, ips: new Set(Array.isArray(day.ips) ? day.ips : []) };
    this.days.set(day.date, value); return value;
  }
  day(date) {
    if (this.days.has(date)) return this.days.get(date);
    return this.cache(read(path.join(this.dir, 'daily-' + date + '.json')) || empty(date));
  }
  summary(day) {
    const ips = day.ips instanceof Set ? day.ips.size : Array.isArray(day.ips) ? day.ips.length : null;
    return { date: day.date, ...Object.fromEntries(TRAFFIC_KEYS.map(k => [k, day[k] ?? null])), visitors: ips ?? day.visitors ?? null };
  }
  rollover() {
    const date = this.key();
    if (this.today?.date === date) return;
    if (this.today) { this.history[this.today.date] = this.summary(this.today); this.dirty.add(this.today.date); }
    this.today = this.day(date); this.dirty.add(date);
    this.trimHistory();
  }
  trimHistory() {
    const keys = Object.keys(this.history).sort();
    while (keys.length > this.retainDays) delete this.history[keys.shift()];
  }
  ingest({ date, ip, route, status, bytes }) {
    if (date > this.key()) return;
    // First installation ignores historical log lines. Existing dates, including yesterday
    // after rollover or restart, remain editable while the log backlog is being drained.
    if (date !== this.today.date && !this.days.has(date) && !Object.hasOwn(this.history, date)) return;
    if (route.startsWith('/monitor') || route.startsWith('/api/admin/') || route.startsWith('/api/panel/') ||
      route.startsWith('/internal/') || route === '/api/status' || route === '/healthz') return;
    const day = this.day(date); day.requests++; day.bytes += Number(bytes) || 0;
    if (status === '101' && route.startsWith('/ws')) day.wsConnects++;
    else if (route === '/' || route === '/play') day.pageViews++;
    else if (route.startsWith('/assets/')) day.assetHits++;
    if (Number(status) >= 500) day.errors++; else if (status === '499') day.aborts++;
    if (!privateAddress(ip)) day.ips.add(ip);
    this.dirty.add(date);
    if (date !== this.today.date) this.history[date] = this.summary(day);
  }
  consume(checkpoint) { this.checkpoint = { offset: checkpoint.offset, ino: checkpoint.ino }; this.checkpointDirty = true; }
  peaks(s) {
    for (const [key, value] of [['peakSessions', s.sessions], ['peakSockets', s.sockets], ['peakHumans', s.humans],
      ['peakBots', s.bots], ['peakTxKB', s.txKB]]) {
      if (typeof value === 'number' && Number.isFinite(value)) this.today[key] = Math.max(this.today[key] ?? 0, value);
    }
    this.dirty.add(this.today.date);
  }
  save(force = false) {
    if (!force && ((!this.dirty.size && !this.checkpointDirty) || this.now() - this.lastSave < 30000)) return;
    const serialized = [...this.dirty].map(date => {
      const day = this.days.get(date);
      return { ...day, ips: [...day.ips], logOffset: this.checkpoint.offset || 0, logIno: this.checkpoint.ino || 0 };
    });
    atomicJson(this.stateFile, { schemaVersion: 1, checkpoint: this.checkpoint, days: serialized });
    for (const day of serialized) atomicJson(path.join(this.dir, 'daily-' + day.date + '.json'), day);
    this.trimHistory(); atomicJson(path.join(this.dir, 'daily-history.json'), this.history);
    this.dirty.clear(); this.checkpointDirty = false; this.lastSave = this.now();
    for (const date of this.days.keys()) if (date !== this.today.date) this.days.delete(date);
  }
  snapshot() {
    return { today: this.summary(this.today), history: Object.values(this.history)
      .filter(d => d.date !== this.today.date).sort((a, b) => a.date.localeCompare(b.date)).slice(-this.retainDays) };
  }
}
