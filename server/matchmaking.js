// Same-process, opt-in FIFO queues. Only identified connected players in this site's lobby participate.
import { DIFFICULTIES, MAX_SEATS, MAX_SPECTATORS, ERR } from '../shared/constants.js';
import { sendSession } from './net.js';

export class Matchmaking {
  constructor({ registry, roomOf, allocate, partyChanged = () => {}, now = Date.now, limit = 2000 }) {
    this.registry = registry; this.roomOf = roomOf; this.allocate = allocate; this.now = now; this.limit = limit;
    this.partyChanged = partyChanged;
    this.entries = new Map(); this.draining = false;
  }
  has(session) { return this.entries.has(session.playerId); }
  participants(difficulty) {
    return [...this.entries.values()].filter((e) => e.difficulty === difficulty).map((e) => this.registry.byId(e.playerId))
      .filter((s) => {
        if (!s?.connected) return false;
        const room = this.roomOf(s), party = this.entries.get(s.playerId)?.party;
        return party ? room === party && !room.match && !room.disposed : !room;
      });
  }
  // A premade alliance is one indivisible queue entry: never split its players across matches.
  units(difficulty) {
    const units = [], parties = new Map();
    for (const s of this.participants(difficulty)) {
      const party = this.entries.get(s.playerId).party;
      if (!party) units.push({ people: [s], spectators: 0 });
      else {
        let unit = parties.get(party);
        if (!unit) { unit = { people: [], spectators: party.spectators.length }; parties.set(party, unit); units.push(unit); }
        unit.people.push(s);
      }
    }
    return units.filter((u) => {
      const party = this.entries.get(u.people[0].playerId).party;
      return !party || u.people.length === party.activeHumans().length;
    });
  }
  group(difficulty) {
    // Bounded subset sum (four seats / two spectators), in queue order. Oversized parties wait intact.
    const choices = new Map([['0:0', { people: [], spectators: 0 }]]);
    for (const unit of this.units(difficulty)) {
      for (const choice of [...choices.values()]) {
        const people = [...choice.people, ...unit.people], spectators = choice.spectators + unit.spectators;
        if (people.length > MAX_SEATS || spectators > MAX_SPECTATORS) continue;
        if (people.length === MAX_SEATS) return people;
        const key = `${people.length}:${spectators}`;
        if (!choices.has(key)) choices.set(key, { people, spectators });
      }
    }
    return null;
  }
  progress(difficulty) {
    const units = this.units(difficulty), sizes = new Map(), counts = new Map(), result = new Map();
    for (const u of units) {
      const key = `${u.people.length}:${u.spectators}`;
      sizes.set(key, (sizes.get(key) || 0) + 1);
    }
    for (const u of units) {
      const key = `${u.people.length}:${u.spectators}`;
      if (!counts.has(key)) {
        const possible = new Map([[key, { players: u.people.length, spectators: u.spectators }]]);
        for (const [size, total] of sizes) {
          const [players, spectators] = size.split(':').map(Number);
          for (let i = 0; i < Math.min(MAX_SEATS, total - (key === size ? 1 : 0)); i++) {
            for (const p of [...possible.values()]) {
              const next = { players: p.players + players, spectators: p.spectators + spectators };
              if (next.players <= MAX_SEATS && next.spectators <= MAX_SPECTATORS) possible.set(`${next.players}:${next.spectators}`, next);
            }
          }
        }
        counts.set(key, Math.max(...[...possible.values()].map((p) => p.players)));
      }
      for (const s of u.people) result.set(s.playerId, counts.get(key));
    }
    return result;
  }
  state(session, count) {
    const e = this.entries.get(session.playerId);
    return e ? { t: 'matchmaking.state', status: 'searching', difficulty: e.difficulty, joinedAt: e.joinedAt,
      players: count ?? this.progress(e.difficulty).get(session.playerId) ?? 0, target: MAX_SEATS, serverNow: this.now() } :
      { t: 'matchmaking.state', status: 'idle', serverNow: this.now() };
  }
  sync(session) { sendSession(session, this.state(session)); }
  publish(difficulty) {
    const people = this.participants(difficulty);
    const progress = this.progress(difficulty);
    for (const s of people) sendSession(s, this.state(s, progress.get(s.playerId)));
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
  joinParty(party) {
    const people = party.activeHumans().map((s) => this.registry.byId(s.playerId));
    if (people.some((s) => !s?.connected)) return { error: ERR.NOT_READY };
    if (people.every((s) => this.entries.get(s.playerId)?.party === party)) {
      this.publish(party.difficulty); return { ok: true };
    }
    if (this.entries.size + people.length > this.limit) return { error: ERR.RATE };
    const joinedAt = this.now();
    for (const s of people) this.entries.set(s.playerId, { playerId: s.playerId, difficulty: party.difficulty, joinedAt, party });
    party.matchmaking = true; this.partyChanged(party);
    this.publish(party.difficulty); this.drain(party.difficulty); return { ok: true };
  }
  cancel(session, notify = true) {
    const e = this.entries.get(session.playerId);
    const entries = e?.party ? [...this.entries.values()].filter((entry) => entry.party === e.party) : e ? [e] : [];
    for (const entry of entries) this.entries.delete(entry.playerId);
    if (e?.party) { e.party.matchmaking = false; this.partyChanged(e.party); }
    for (const entry of entries) {
      const member = this.registry.byId(entry.playerId);
      if (member && (notify || member !== session)) this.sync(member);
    }
    if (notify && !e) this.sync(session);
    if (e) this.publish(e.difficulty);
    return { ok: true };
  }
  drain(difficulty) {
    if (this.draining) return;
    this.draining = true;
    try {
      let group;
      while ((group = this.group(difficulty))) {
        const parties = new Set(group.map((s) => this.entries.get(s.playerId)?.party).filter(Boolean));
        for (const s of group) this.entries.delete(s.playerId);
        for (const party of parties) party.matchmaking = false;
        let result;
        try { result = this.allocate(group, difficulty); } catch { result = { error: ERR.INTERNAL }; }
        for (const party of parties) this.partyChanged(party);
        for (const s of group) sendSession(s, { t: 'matchmaking.state', status: result?.ok ? 'matched' : 'failed',
          difficulty, ...(result?.ok ? { code: s.roomCode } : { error: result?.error || ERR.INTERNAL }), serverNow: this.now() });
        this.publish(difficulty);
      }
    } finally { this.draining = false; }
  }
  shutdown() { for (const s of [...this.entries.values()].map((e) => this.registry.byId(e.playerId)).filter(Boolean)) this.cancel(s); this.entries.clear(); }
}
