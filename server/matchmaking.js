// Same-process, opt-in FIFO queues. Only identified connected players in this site's lobby participate.
import { DIFFICULTIES, MAX_SEATS, ERR } from '../shared/constants.js';
import { sendSession } from './net.js';

export class Matchmaking {
  constructor({ registry, roomOf, allocate, now = Date.now, limit = 2000 }) {
    this.registry = registry; this.roomOf = roomOf; this.allocate = allocate; this.now = now; this.limit = limit;
    this.entries = new Map(); this.draining = false;
  }
  has(session) { return this.entries.has(session.playerId); }
  participants(difficulty) {
    return [...this.entries.values()].filter((e) => e.difficulty === difficulty).map((e) => this.registry.byId(e.playerId))
      .filter((s) => s?.connected && !this.roomOf(s));
  }
  state(session, count) {
    const e = this.entries.get(session.playerId);
    return e ? { t: 'matchmaking.state', status: 'searching', difficulty: e.difficulty, joinedAt: e.joinedAt,
      players: Math.min(MAX_SEATS, count ?? this.participants(e.difficulty).length), target: MAX_SEATS, serverNow: this.now() } :
      { t: 'matchmaking.state', status: 'idle', serverNow: this.now() };
  }
  sync(session) { sendSession(session, this.state(session)); }
  publish(difficulty) {
    const people = this.participants(difficulty);
    for (const s of people) sendSession(s, this.state(s, people.length));
  }
  join(session, difficulty) {
    if (!DIFFICULTIES.includes(difficulty)) return { error: ERR.BAD_MSG };
    if (!session.connected) return { error: ERR.NOT_READY };
    if (this.roomOf(session)) return { error: ERR.ALREADY, detail: 'leave your room before matchmaking' };
    const old = this.entries.get(session.playerId);
    if (old?.difficulty === difficulty) { this.sync(session); return { ok: true }; }
    if (!old && this.entries.size >= this.limit) return { error: ERR.RATE, detail: 'matchmaking queue full' };
    if (old) this.cancel(session);
    this.entries.set(session.playerId, { playerId: session.playerId, difficulty, joinedAt: this.now() });
    this.publish(difficulty); this.drain(difficulty); return { ok: true };
  }
  cancel(session, notify = true) {
    const e = this.entries.get(session.playerId); this.entries.delete(session.playerId);
    if (notify) this.sync(session);
    if (e) this.publish(e.difficulty);
    return { ok: true };
  }
  drain(difficulty) {
    if (this.draining) return;
    this.draining = true;
    try {
      let candidates;
      while ((candidates = this.participants(difficulty)).length >= MAX_SEATS) {
        const group = candidates.slice(0, MAX_SEATS);
        for (const s of group) this.entries.delete(s.playerId);
        let result;
        try { result = this.allocate(group, difficulty); } catch { result = { error: ERR.INTERNAL }; }
        for (const s of group) sendSession(s, { t: 'matchmaking.state', status: result?.ok ? 'matched' : 'failed',
          difficulty, ...(result?.ok ? { code: s.roomCode } : { error: result?.error || ERR.INTERNAL }), serverNow: this.now() });
        this.publish(difficulty);
      }
    } finally { this.draining = false; }
  }
  shutdown() { for (const s of [...this.entries.values()].map((e) => this.registry.byId(e.playerId)).filter(Boolean)) this.cancel(s); this.entries.clear(); }
}
