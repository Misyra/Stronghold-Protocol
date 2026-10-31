// Same-capacity human matchmaking with optional admission caps and opt-in async preparation.
// Parties are indivisible session identities, never sockets. Every human explicitly accepts
// before the lobby atomically commits its room-owned rules; the legacy allocate path stays synchronous.
// `paused()` (the lobby's maintenance switch, server/onlineLimit.js): join and accept answer MAINTENANCE and no offer is
// formed; the lobby clears the queue when the switch goes on (clear('maintenance')).
import { randomBytes } from 'node:crypto';
import { ERR, MAX_SEATS, DIFFICULTIES, MATCHMAKING_VERSION } from '../shared/constants.js';
import { EXPERIMENTAL_DEFAULTS, experimentalOptions, experimentalKey, sameExperimental } from '../shared/experimental.js';
import { PLAYER_CAPACITY_VERSION, roomCapacity } from '../shared/playerCapacity.js';
import { NO_PHASES } from './phaseMetrics.js';

// Quantity/per-network admission caps use 0 = unlimited; ticket and acceptance deadlines stay bounded.
export const MATCHMAKING_DEFAULTS = Object.freeze({ maxEntries: 0, maxPerAddr: 0, waitMs: 600_000, acceptMs: 30_000 });
const OK = Object.freeze({ ok: true });
const fail = (error, detail) => ({ error, detail });
const id = () => randomBytes(16).toString('hex');
// Preserve ordinary-room preference order; each pool appends any newer room-owned option keys.
const LEGACY_OPTION_KEYS = Object.freeze([false, true].flatMap(revivalEnabled => [false, true]
  .map(disableSharedPool => experimentalKey({ revivalEnabled, disableSharedPool }))));

// Observe cleanup/invalid async-commit rejections without logging provider data.
function observeThenable(value) {
  if (!value || typeof value.then !== 'function') return false;
  Promise.resolve(value).catch(() => {});
  return true;
}

export class Matchmaking {
  constructor({ now = Date.now, send, available, members, allocate, asyncAllocate = null, allocationMs = 6000,
    options = {}, timers = { setTimeout, clearTimeout }, metrics = NO_PHASES, paused = () => false }) {
    if (asyncAllocate !== null && typeof asyncAllocate !== 'function') throw new TypeError('invalid matchmaking asyncAllocate');
    if (typeof paused !== 'function') throw new TypeError('invalid matchmaking paused');
    this.paused = paused;
    if (!Number.isSafeInteger(allocationMs) || allocationMs < 1 || allocationMs > 8000) throw new TypeError('invalid matchmaking allocationMs');
    this.asyncAllocate = asyncAllocate;
    this.allocationMs = allocationMs;
    this.now = now;
    this.send = send;
    this.available = available;
    this.members = members || ((session) => ({ sessions: [session], roomCode: null, leaderId: session.playerId }));
    this.allocate = allocate;
    this.timers = timers;
    this.opts = { ...MATCHMAKING_DEFAULTS, ...options };
    const limits = { maxEntries: 20_000, maxPerAddr: 20_000, waitMs: 3_600_000, acceptMs: 120_000 };
    for (const [key, max] of Object.entries(limits)) {
      const min = key === 'maxEntries' || key === 'maxPerAddr' ? 0 : 1;
      if (!Number.isSafeInteger(this.opts[key]) || this.opts[key] < min || this.opts[key] > max) throw new TypeError(`invalid matchmaking ${key}`);
    }
    this.entries = new Map();
    this.parties = new Map();
    this.offers = new Map();
    this.sequence = 0;
    this.timer = null;
    this.populationTimer = null;
    this.closed = false;
    /** diagnostics only (server/phaseMetrics.js) */
    this.metrics = metrics;
  }

  has(session) { return this.entries.has(session.playerId); }
  get size() { return this.entries.size; }
  partyState(party) {
    return { partyId: party.id, partySize: party.entries.length, partyLeaderId: party.leaderId, partyRoomCode: party.roomCode };
  }

  poolKey(e) { return `${e.version}:${e.difficulty}:${e.party.required}`; }

  /** Read-only population: no sweep, offer creation, deadline or party mutation. */
  waitingPopulation() {
    const counts = new Map(), waiting = [];
    const now = this.now();
    for (const party of this.parties.values()) {
      if (party.entries.some(e => e.offerId || this.entries.get(e.session.playerId) !== e || this.stale(e, now))) continue;
      for (const e of party.entries) {
        const key = this.poolKey(e);
        counts.set(key, (counts.get(key) || 0) + 1);
        waiting.push({ entry: e, session: e.session, playerId: e.session.playerId, ticketId: e.ticketId });
      }
    }
    return { counts, waiting };
  }

  state(session, counts = null) {
    const e = this.entries.get(session.playerId);
    if (!e) {
      const matched = session.matchmakingResult;
      return matched && session.roomCode === matched.code ? { t: 'queue.state', state: 'matched', required: matched.required ?? MAX_SEATS, ...matched }
        : { t: 'queue.state', state: 'idle', ticketId: null, required: MAX_SEATS };
    }
    const offer = e.offerId ? this.offers.get(e.offerId) : null;
    return {
      t: 'queue.state', state: offer ? 'offered' : 'queued', ticketId: e.ticketId,
      difficulty: e.difficulty, required: e.party.required, joinedAt: e.joinedAt,
      deadline: offer ? offer.deadline : e.expiresAt, ...this.partyState(e.party),
      ...(!e.offerId ? { waitingCount: (counts || this.waitingPopulation().counts).get(this.poolKey(e)) || 0 } : {}),
      ...(e.reason ? { reason: e.reason } : {}),
      ...(offer ? { offerId: offer.id, accepted: e.accepted, experimental: { ...offer.experimental }, acceptedCount: offer.entries.filter((x) => x.accepted).length,
        ...(offer.allocation ? { allocationPending: true } : {}) } : {}),
    };
  }

  sync(session) {
    this.refresh(session);
    const e = this.entries.get(session.playerId);
    if (e) this.push(e);
    else this.send(session, this.state(session));
  }
  push(e, counts = null) {
    if (this.entries.get(e.session.playerId) !== e) return;
    const state = this.state(e.session, counts);
    e.lastWaitingCount = state.waitingCount;
    this.send(e.session, state);
  }
  pushAll(entries) {
    const counts = entries.some(e => !e.offerId) ? this.waitingPopulation().counts : null;
    for (const e of entries) this.push(e, counts);
  }
  idle(e, reason) { this.send(e.session, { t: 'queue.state', state: 'idle', ticketId: null, required: MAX_SEATS, reason }); }

  notifyPopulation() {
    const t0 = this.metrics.start();
    const { counts, waiting } = this.waitingPopulation();
    for (const saved of waiting) {
      const e = saved.entry;
      // A preceding send can cancel/rejoin, replace an identity or create an offer.
      // Resolve a complete current snapshot, never replay a saved queued frame.
      if (this.entries.get(saved.playerId) !== e || e.session !== saved.session || e.session.playerId !== saved.playerId
        || e.ticketId !== saved.ticketId || e.offerId || this.stale(e, this.now())) continue;
      if (e.lastWaitingCount !== (counts.get(this.poolKey(e)) || 0)) this.push(e, counts);
    }
    this.metrics.end('queue.population', t0, waiting.length);
  }

  armPopulation() {
    if (this.closed || ![...this.entries.values()].some(e => !e.offerId)) {
      if (this.populationTimer != null) this.timers.clearTimeout(this.populationTimer);
      this.populationTimer = null;
      return;
    }
    if (this.populationTimer != null) return;
    const timer = this.timers.setTimeout(() => {
      if (this.populationTimer !== timer) return;
      this.populationTimer = null;
      this.notifyPopulation();
      this.armPopulation();
    }, 1000);
    this.populationTimer = timer;
    timer?.unref?.();
  }

  join(session, { difficulty, party = false }) {
    this.refresh(session);
    if (this.closed) return fail(ERR.WRONG_PHASE, 'matchmaking is closed');
    if (this.paused()) return fail(ERR.MAINTENANCE);
    if (!DIFFICULTIES.includes(difficulty) || typeof party !== 'boolean') return fail(ERR.BAD_MSG, 'invalid matchmaking request');
    if (session.matchmakingVersion !== MATCHMAKING_VERSION) return fail(ERR.BAD_MSG, 'matchmaking version required; refresh the page');
    const previous = this.entries.get(session.playerId);
    if (previous) {
      if (previous.difficulty !== difficulty) return fail(ERR.QUEUED, 'cancel before changing difficulty');
      this.push(previous);
      if (!previous.offerId) { this.pump(); this.arm(); }
      return OK;
    }
    const group = this.members(session, difficulty, party);
    if (!group || group.error) return group || fail(ERR.INTERNAL, 'could not inspect party');
    let experimental = null;
    try { if (group.roomCode) experimental = experimentalOptions(group.experimental ?? EXPERIMENTAL_DEFAULTS); }
    catch { return fail(ERR.BAD_MSG, 'invalid party experimental options'); }
    // Room inspection owns the mode; lobby solos remain in the ordinary four-player pool.
    const required = roomCapacity('coop', experimental);
    const sessions = group.sessions;
    if (!Array.isArray(sessions) || sessions.length < 1 || sessions.length > required
      || sessions.some(member => !member || typeof member.playerId !== 'string')
      || new Set(sessions.map((s) => s.playerId)).size !== sessions.length) return fail(ERR.BAD_TARGET, 'invalid party');
    for (const member of sessions) {
      if (this.has(member)) return fail(ERR.QUEUED, 'party member already queued');
      if (member.matchmakingVersion !== MATCHMAKING_VERSION
        || (required > MAX_SEATS && member.playerCapacityVersion !== PLAYER_CAPACITY_VERSION)) {
        return fail(ERR.BAD_MSG, 'all party members must refresh the page');
      }
    }
    this.sweep();
    if (this.opts.maxEntries > 0 && this.entries.size + sessions.length > this.opts.maxEntries) return fail(ERR.RATE, 'matchmaking queue is full');
    if (this.opts.maxPerAddr > 0) {
      const counts = new Map();
      for (const member of sessions) if (member.limitKey) counts.set(member.limitKey, (counts.get(member.limitKey) || 0) + 1);
      for (const e of this.entries.values()) if (counts.has(e.key)) counts.set(e.key, counts.get(e.key) + 1);
      if ([...counts.values()].some((count) => count > this.opts.maxPerAddr)) return fail(ERR.RATE, 'too many queued players from your network');
    }
    const now = this.now();
    const unit = { id: id(), roomCode: group.roomCode || null, leaderId: group.leaderId || session.playerId,
      experimental, required, sequence: ++this.sequence, entries: [] };
    unit.entries = sessions.map((member) => ({
      session: member, key: member.limitKey, ticketId: id(), difficulty, version: member.matchmakingVersion, party: unit,
      joinedAt: now, expiresAt: now + this.opts.waitMs, sequence: unit.sequence, offerId: null, accepted: false, revivalVote: null,
    }));
    if (unit.entries.some((e) => !this.available(e.session, e))) return fail(ERR.WRONG_PHASE, 'party member unavailable');
    this.parties.set(unit.id, unit);
    for (const e of unit.entries) { e.session.matchmakingResult = null; this.entries.set(e.session.playerId, e); }
    this.pushAll(unit.entries);
    this.pump();
    this.arm();
    return OK;
  }

  cancel(session, { ticketId }) {
    this.refresh(session);
    const e = this.entries.get(session.playerId);
    if (!e) { this.send(session, this.state(session)); return OK; }
    if (ticketId !== e.ticketId) return fail(ERR.BAD_TARGET, 'stale matchmaking ticket');
    this.remove(session, 'cancelled');
    return OK;
  }

  accept(session, { ticketId, offerId, revivalVote }) {
    if (revivalVote !== undefined && typeof revivalVote !== 'boolean') return fail(ERR.BAD_MSG, 'invalid obsolete vote');
    this.refresh(session);
    if (this.closed) return fail(ERR.WRONG_PHASE, 'matchmaking is closed');
    const e = this.entries.get(session.playerId);
    const matched = session.matchmakingResult;
    if (!e && matched?.ticketId === ticketId && matched.offerId === offerId && session.roomCode === matched.code) {
      this.send(session, this.state(session));
      return OK;
    }
    if (this.paused()) return fail(ERR.MAINTENANCE);
    const offer = this.offers.get(offerId);
    if (!e || e.ticketId !== ticketId || e.offerId !== offerId || !offer || !offer.entries.includes(e)) return fail(ERR.BAD_TARGET, 'stale matchmaking offer');
    if (!this.available(session, e) || session.matchmakingVersion !== e.version) {
      this.remove(session, 'unavailable');
      return fail(ERR.WRONG_PHASE, 'player unavailable');
    }
    if (e.accepted) {
      this.push(e);
      return OK;
    }
    e.revivalVote = false; // Legacy bookkeeping only; no player vote selects room rules.
    e.accepted = true;
    this.pushAll(offer.entries);
    if (!offer.entries.every((x) => x.accepted)) return OK;
    if (this.asyncAllocate) {
      this.prepareAllocation(offer);
      return OK; // Acknowledges acceptance only; allocation is not yet committed.
    }
    // No await: the lobby validates identities, parties and quotas again before starting/committing.
    let result;
    try { result = this.allocate(offer.entries.map((x) => x.session), e.difficulty); }
    catch { result = fail(ERR.INTERNAL, 'could not allocate a match'); }
    if (!result || result.error || typeof result.code !== 'string') {
      // Healthy parties keep their original rooms, tickets, FIFO/TTL. No immediate capacity re-offer loop.
      const removed = new Set(offer.entries.filter((member) => this.stale(member, this.now())));
      this.breakOffer(offer, removed, 'allocation_failed');
      this.arm();
      return result?.error ? result : fail(ERR.INTERNAL, 'could not allocate a match');
    }
    this.offers.delete(offer.id);
    for (const member of offer.entries) {
      this.entries.delete(member.session.playerId);
      this.parties.delete(member.party.id);
      member.session.matchmakingResult = {
        ticketId: member.ticketId, offerId: offer.id, difficulty: member.difficulty, required: offer.required, code: result.code,
        experimental: { ...offer.experimental }, ...this.partyState(member.party),
      };
    }
    // room.state(inMatch) first: the client clears old game slices on a changed room. Matched is last.
    result.publish?.();
    for (const member of offer.entries) this.send(member.session, this.state(member.session));
    this.pump();
    this.arm();
    return OK;
  }

  /**
   * Opt-in provider contract: prepare must not mutate the original friend rooms.
   * Resolve { code, commit?, abort?, publish? }; commit is synchronous/atomic,
   * publish is synchronous/nonthrowing, and abort must compensate partial commit
   * and late preparation idempotently. The signal alone is not compensation.
   */
  prepareAllocation(offer) {
    if (offer.allocation || this.offers.get(offer.id) !== offer || this.closed) return;
    const allocation = {
      controller: new AbortController(), offerId: offer.id, experimental: offer.experimental, required: offer.required,
      cancelled: false, cleaned: false, completed: false, result: null,
      entries: offer.entries.map((entry) => ({ entry, session: entry.session, playerId: entry.session.playerId,
        ticketId: entry.ticketId, version: entry.version, party: entry.party, difficulty: entry.difficulty,
        expiresAt: entry.expiresAt, sequence: entry.sequence, revivalVote: entry.revivalVote, experimental: entry.party.experimental })),
    };
    offer.allocation = allocation;
    offer.deadline = Math.min(offer.deadline, this.now() + this.allocationMs);
    allocation.deadline = offer.deadline;
    this.pushAll(offer.entries);
    this.arm();
    const context = Object.freeze({ signal: allocation.controller.signal, offerId: offer.id,
      isCurrent: () => this.allocationCurrent(offer, allocation) });
    let prepared;
    try { prepared = this.asyncAllocate(allocation.entries.map((member) => member.session), offer.entries[0].difficulty, context); }
    catch { this.failAllocation(offer, allocation); return; }
    Promise.resolve(prepared).then(
      (result) => this.finishAllocation(offer, allocation, result),
      () => this.failAllocation(offer, allocation),
    ).catch(() => this.failAllocation(offer, allocation));
  }

  allocationCurrent(offer, allocation, inspectAvailable = true) {
    try {
      if (this.closed || allocation.cancelled || allocation.controller.signal.aborted || offer.allocation !== allocation
        || this.offers.get(allocation.offerId) !== offer || offer.id !== allocation.offerId
        || offer.entries.length !== allocation.entries.length || offer.experimental !== allocation.experimental
        || offer.required !== allocation.required || offer.entries.length !== offer.required
        || roomCapacity('coop', offer.experimental) !== offer.required) return false;
      const now = this.now();
      if (offer.deadline !== allocation.deadline || now >= allocation.deadline) return false;
      return allocation.entries.every((saved, index) => {
        const e = saved.entry;
        return offer.entries[index] === e && this.entries.get(saved.playerId) === e && e.session === saved.session
          && e.session.playerId === saved.playerId && e.ticketId === saved.ticketId && e.version === saved.version
          && e.offerId === allocation.offerId && e.party === saved.party && this.parties.get(e.party.id) === e.party
          && e.difficulty === saved.difficulty && e.expiresAt === saved.expiresAt && e.sequence === saved.sequence
          && e.party.required === allocation.required && e.party.experimental === saved.experimental
          && (!e.party.experimental || sameExperimental(e.party.experimental, offer.experimental))
          && (allocation.required <= MAX_SEATS || e.session.playerCapacityVersion === PLAYER_CAPACITY_VERSION)
          && e.accepted === true && e.revivalVote === saved.revivalVote && e.expiresAt > now
          && e.session.matchmakingVersion === saved.version && (e.session.limitKey || null) === (e.key || null)
          && (!inspectAvailable || this.available(e.session, e));
      });
    } catch { return false; }
  }

  cancelAllocation(allocation) {
    if (!allocation || allocation.completed) return;
    allocation.cancelled = true;
    if (!allocation.controller.signal.aborted) allocation.controller.abort();
    if (allocation.cleaned || !allocation.result) return;
    allocation.cleaned = true;
    try { observeThenable(allocation.result.abort?.()); } catch { /* best-effort provider compensation */ }
  }

  failAllocation(offer, allocation) {
    this.cancelAllocation(allocation);
    // Never break a newer offer or overwrite replacement identities/tickets.
    if (this.offers.get(allocation.offerId) !== offer || offer.allocation !== allocation) return;
    const removed = new Set(offer.entries.filter((member) => this.stale(member, this.now())));
    this.breakOffer(offer, removed, 'allocation_failed');
    this.arm(); // Healthy fully confirmed parties keep age/TTL; no immediate capacity retry loop.
  }

  finishAllocation(offer, allocation, result) {
    allocation.result = result;
    if (!this.allocationCurrent(offer, allocation)) { this.failAllocation(offer, allocation); return; }
    try {
      if (!result || result.error || typeof result.code !== 'string' || !result.code.length
        || ['commit', 'abort', 'publish'].some((hook) => result[hook] != null && typeof result[hook] !== 'function')) {
        throw new TypeError('invalid matchmaking allocation result');
      }
      if (!this.allocationCurrent(offer, allocation)) throw new TypeError('stale matchmaking allocation');
      const committed = result.commit?.();
      if (observeThenable(committed) || committed === false || committed?.error) throw new TypeError('matchmaking commit must succeed synchronously');
      // Commit may change room availability, but must not reenter and replace the
      // cohort, advance its epoch, cancel it or commit after its bounded deadline.
      if (!this.allocationCurrent(offer, allocation, false)) throw new TypeError('stale matchmaking commit');
    } catch { this.failAllocation(offer, allocation); return; }

    allocation.completed = true;
    this.offers.delete(offer.id);
    for (const member of offer.entries) {
      this.entries.delete(member.session.playerId);
      this.parties.delete(member.party.id);
      member.session.matchmakingResult = {
        ticketId: member.ticketId, offerId: offer.id, difficulty: member.difficulty, required: offer.required, code: result.code,
        experimental: { ...offer.experimental }, ...this.partyState(member.party),
      };
    }
    // Same ordering as the legacy path: room/match publication precedes matched.
    try { result.publish?.(); }
    finally {
      for (const member of offer.entries) this.send(member.session, this.state(member.session));
      this.pump();
      this.arm();
    }
  }

  /** Removing any identity removes its whole party; unrelated parties keep their FIFO age. */
  remove(session, reason = 'disconnected') {
    const e = this.entries.get(session.playerId);
    if (!e) return;
    if (e.offerId) this.breakOffer(this.offers.get(e.offerId), new Set(e.party.entries), reason);
    else this.dropParty(e.party, reason);
    this.pump();
    this.arm();
  }

  dropParty(party, reason) {
    this.parties.delete(party.id);
    for (const e of party.entries) if (this.entries.delete(e.session.playerId)) this.idle(e, reason);
  }

  breakOffer(offer, removed, reason) {
    if (!offer || this.offers.get(offer.id) !== offer) return;
    this.offers.delete(offer.id);
    const removedParties = new Set([...removed].map((e) => e.party));
    // Only parties whose every human accepted THIS offer may continue automatically. Capture before
    // clearing acceptance: allocation failures arrive fully accepted and must retain their tickets/rooms.
    const unconfirmedParties = new Set(offer.entries.filter((e) => !e.accepted).map((e) => e.party));
    this.cancelAllocation(offer.allocation);
    for (const party of new Set([...removedParties, ...unconfirmedParties])) {
      if (this.parties.get(party.id) === party) this.parties.delete(party.id);
    }
    const retained = [];
    for (const e of offer.entries) {
      if (this.entries.get(e.session.playerId) !== e) continue;
      e.offerId = null;
      e.accepted = false;
      e.revivalVote = null;
      if (removedParties.has(e.party) || unconfirmedParties.has(e.party)) {
        this.entries.delete(e.session.playerId);
        this.idle(e, removedParties.has(e.party) ? reason : 'unconfirmed');
      } else {
        e.reason = reason === 'cancelled' ? 'peer_cancelled' : reason === 'disconnected' ? 'peer_disconnected' : reason;
        retained.push(e);
      }
    }
    this.pushAll(retained);
  }

  pump() {
    if (this.closed || this.paused()) return;
    const t0 = this.metrics.start();
    try { this.pumpPools(); } finally { this.metrics.end('queue.pump', t0, this.entries.size); }
  }

  pumpPools() {
    const pools = new Map();
    for (const party of this.parties.values()) {
      const e = party.entries[0];
      if (e.offerId) continue;
      const key = this.poolKey(e);
      if (!pools.has(key)) pools.set(key, []);
      pools.get(key).push(party);
    }
    for (const pool of pools.values()) {
      pool.sort((a, b) => a.sequence - b.sequence);
      const unused = new Set(pool);
      const buckets = new Map();
      const optionKeys = new Set(LEGACY_OPTION_KEYS);
      for (const party of pool) {
        if (party.experimental) optionKeys.add(experimentalKey(party.experimental));
        const key = `${party.entries.length}:${party.experimental ? experimentalKey(party.experimental) : '*'}`;
        if (!buckets.has(key)) buckets.set(key, { parties: [], cursor: 0 });
        buckets.get(key).parties.push(party);
      }
      for (const leader of pool) {
        if (!unused.has(leader)) continue;
        const remaining = leader.required - leader.entries.length;
        let rest = null;
        // Solos are wildcards; fixed-option parties only merge with compatible parties.
        // Capacity/flag buckets bound the fit to at most twenty slots, independently of queue length.
        for (const optionKey of leader.experimental ? [experimentalKey(leader.experimental)] : optionKeys) {
          const candidates = [];
          for (let size = 1; size <= remaining; size++) for (const key of ['*', optionKey]) {
            const bucket = buckets.get(`${size}:${key}`);
            if (!bucket) continue;
            const list = bucket.parties;
            while (bucket.cursor < list.length && (list[bucket.cursor].sequence <= leader.sequence || !unused.has(list[bucket.cursor]))) bucket.cursor++;
            let taken = 0;
            for (let i = bucket.cursor; i < list.length && taken < Math.floor(remaining / size); i++) {
              if (unused.has(list[i])) { candidates.push(list[i]); taken++; }
            }
          }
          candidates.sort((a, b) => a.sequence - b.sequence);
          // Suffix reachability preserves the earliest feasible FIFO combination without
          // exponential backtracking when larger rooms have many incompatible party sizes.
          const reachable = Array.from({ length: candidates.length + 1 }, () => new Uint8Array(remaining + 1));
          reachable[candidates.length][0] = 1;
          for (let i = candidates.length - 1; i >= 0; i--) {
            const size = candidates[i].entries.length;
            for (let slots = 0; slots <= remaining; slots++) {
              reachable[i][slots] = reachable[i + 1][slots] || (slots >= size && reachable[i + 1][slots - size]);
            }
          }
          let found = null;
          if (reachable[0][remaining]) {
            found = [];
            let slots = remaining;
            for (let i = 0; i < candidates.length && slots; i++) {
              const size = candidates[i].entries.length;
              if (size <= slots && reachable[i + 1][slots - size]) { found.push(candidates[i]); slots -= size; }
            }
          }
          if (found && (!rest || found.some((party, i) => party.sequence !== rest[i]?.sequence
            && found.slice(0, i).every((p, j) => p === rest[j]) && party.sequence < (rest[i]?.sequence ?? Infinity)))) rest = found;
        }
        if (!rest) continue; // never split a party; an unfillable older unit does not block later fits
        const parties = [leader, ...rest];
        const entries = parties.flatMap((party) => party.entries);
        const experimental = parties.find(party => party.experimental)?.experimental ?? EXPERIMENTAL_DEFAULTS;
        const offer = { id: id(), experimental, required: leader.required,
          deadline: Math.min(this.now() + this.opts.acceptMs, ...entries.map((e) => e.expiresAt)), entries };
        this.offers.set(offer.id, offer);
        for (const party of parties) unused.delete(party);
        for (const e of entries) { e.offerId = offer.id; e.accepted = false; e.revivalVote = null; e.reason = null; }
        this.pushAll(entries);
      }
    }
  }

  stale(e, now) {
    return e.expiresAt <= now || !this.available(e.session, e) || e.session.matchmakingVersion !== e.version
      || (e.party.required > MAX_SEATS && e.session.playerCapacityVersion !== PLAYER_CAPACITY_VERSION)
      || (e.session.limitKey || null) !== (e.key || null);
  }

  /** Hello/repeated accepts inspect at most one bounded offer, never the entire queue per frame. */
  refresh(session) {
    const e = this.entries.get(session.playerId);
    if (!e) return;
    const now = this.now();
    const offer = e.offerId ? this.offers.get(e.offerId) : null;
    if (!offer) {
      const stale = e.party.entries.find((member) => this.stale(member, now));
      if (stale) this.remove(session, stale.expiresAt <= now ? 'expired' : 'unavailable');
      return;
    }
    const removed = new Set(offer.entries.filter((member) => this.stale(member, now) || (offer.deadline <= now && !member.accepted)));
    const allocationExpired = !!offer.allocation && offer.deadline <= now;
    if (!removed.size && !allocationExpired) return;
    this.breakOffer(offer, removed, allocationExpired ? 'allocation_timeout' : offer.deadline <= now ? 'confirmation_timeout' : 'unavailable');
    if (!allocationExpired) this.pump();
    this.arm();
  }

  /** One timer scans retained tickets; incoming operations also enforce their own deadlines. */
  sweep() {
    const t0 = this.metrics.start();
    try { this.sweepEntries(); } finally { this.metrics.end('queue.sweep', t0, this.entries.size); }
  }

  sweepEntries() {
    const now = this.now();
    const expired = new Set([...this.entries.values()].filter((e) => this.stale(e, now)));
    let allocationExpired = false;
    for (const offer of [...this.offers.values()]) {
      const removed = new Set(offer.entries.filter((e) => expired.has(e) || (offer.deadline <= now && !e.accepted)));
      const pendingExpired = !!offer.allocation && offer.deadline <= now;
      if (removed.size || pendingExpired) {
        this.breakOffer(offer, removed, pendingExpired ? 'allocation_timeout' : offer.deadline <= now ? 'confirmation_timeout' : 'unavailable');
        allocationExpired ||= pendingExpired;
      }
    }
    for (const e of expired) if (this.entries.get(e.session.playerId) === e) this.dropParty(e.party, e.expiresAt <= now ? 'expired' : 'unavailable');
    if (!allocationExpired) this.pump();
    this.arm();
  }

  arm() {
    this.armPopulation();
    if (this.timer != null) { this.timers.clearTimeout(this.timer); this.timer = null; }
    if (this.closed || !this.entries.size) return;
    let at = Infinity;
    for (const e of this.entries.values()) at = Math.min(at, e.expiresAt);
    for (const offer of this.offers.values()) at = Math.min(at, offer.deadline);
    this.timer = this.timers.setTimeout(() => { this.timer = null; this.sweep(); }, Math.max(1, at - this.now()));
    this.timer?.unref?.();
  }

  clear(reason) {
    if (this.timer != null) this.timers.clearTimeout(this.timer);
    if (this.populationTimer != null) this.timers.clearTimeout(this.populationTimer);
    this.timer = null;
    this.populationTimer = null;
    const entries = [...this.entries.values()], offers = [...this.offers.values()];
    this.entries.clear();
    this.parties.clear();
    this.offers.clear();
    for (const offer of offers) this.cancelAllocation(offer.allocation);
    for (const e of entries) this.idle(e, reason);
  }

  close() { this.closed = true; this.clear('shutdown'); }
}
