// Adapted from xinhai-ai/Stronghold-Protocol commit 40d4505f (GPL-3.0-or-later); see docs/development/PERFORMANCE.md.
// Room-pinned simulation lanes (opt-in SP_ROOM_WORKERS): every lane is a full SimulationPool and a room key always
// lands on the same lane, so a room's battle / rehearsal tasks queue behind their own room, not the whole server.
import { SimulationPool } from './pool.js';

/**
 * One lane of the room worker pool.
 * @typedef {{ id: number, rooms: Set<string>, pool: import('./pool.js').SimulationPool }} Lane
 */

/**
 * A group of SimulationPool lanes that pins each room's simulation tasks to one lane. The WebSocket and the Match
 * object stay on the main thread; only the CPU work is placed. Disabled unless server/index.js is told otherwise
 * (SP_ROOM_WORKERS / opts.roomWorkers): a plain SimulationPool serves every room from one shared queue.
 */
export class RoomWorkerPool {
  /**
   * @param {{ data?: object, lanes?: number, totalWorkers?: number, maxQueue?: number, timeoutMs?: number,
   *           workerUrl?: URL }} [opts]
   *   `lanes` is the number of independent queues (the room → lane pinning); `totalWorkers` is the thread budget
   *   shared by the lanes; the rest go to every lane's SimulationPool unchanged. `workerUrl` is this fork's
   *   SimulationPool test seam (upstream hardcodes the real simulation worker).
   */
  constructor({ data, lanes = 1, totalWorkers = 1, maxQueue = 256, timeoutMs = 120000, workerUrl } = {}) {
    if (!Number.isInteger(lanes) || lanes < 1 || lanes > 32) throw new RangeError('room worker lanes must be 1..32');
    if (!Number.isInteger(totalWorkers) || totalWorkers < lanes || totalWorkers > 32) {
      throw new RangeError('room worker total must be between lanes and 32');
    }
    /** @type {Lane[]} */
    this.lanes = Array.from({ length: lanes }, (_, i) => ({
      id: i,
      rooms: new Set(),
      pool: new SimulationPool({
        data,
        size: Math.max(1, Math.ceil((totalWorkers - i) / lanes)),
        maxQueue,
        timeoutMs,
        workerUrl,
      }),
    }));
    /** @type {Map<string, number>} */
    this.assignments = new Map();
    this.closed = false;
  }

  /** Pin a room or standalone match key to the least-loaded lane. @returns {import('./pool.js').SimulationPool} */
  assign(key) {
    const id = String(key || '');
    const existing = this.assignments.get(id);
    if (existing != null) return this.lanes[existing].pool;
    const lane = this.lanes.reduce((best, current) => current.rooms.size < best.rooms.size ? current : best, this.lanes[0]);
    lane.rooms.add(id);
    this.assignments.set(id, lane.id);
    return lane.pool;
  }

  /** Forget a room's lane so its next match may be placed again (release is a no-op for unknown keys). */
  release(key) {
    const id = String(key || '');
    const laneId = this.assignments.get(id);
    if (laneId == null) return;
    this.assignments.delete(id);
    this.lanes[laneId]?.rooms.delete(id);
  }

  /** Aggregate pool stats (`kind: 'room-lanes'`) plus one entry per lane, for /healthz `workers`. */
  stats() {
    const lanes = this.lanes.map((lane) => ({ id: lane.id, rooms: lane.rooms.size, ...lane.pool.stats() }));
    const sum = (field) => lanes.reduce((n, item) => n + (Number(item[field]) || 0), 0);
    return {
      kind: 'room-lanes',
      size: sum('size'), threads: sum('threads'), busy: sum('busy'), queued: sum('queued'),
      maxQueue: sum('maxQueue'), timeoutMs: Math.max(...lanes.map((s) => s.timeoutMs)),
      submitted: sum('submitted'), completed: sum('completed'), failed: sum('failed'),
      cancelled: sum('cancelled'), rejected: sum('rejected'), queueMs: sum('queueMs'), computeMs: sum('computeMs'),
      avgComputeMs: sum('completed') ? sum('computeMs') / sum('completed') : 0,
      lanes,
    };
  }

  /** Stop every lane's threads. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(this.lanes.map((lane) => lane.pool.close()));
  }
}
