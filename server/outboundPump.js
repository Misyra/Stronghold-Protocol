// The fork's outbound scheduler, lifted whole out of server/net.js's Network class so the upstream wire
// layer keeps a one-line seam instead of a 170-line insertion (FORK_MAINTENANCE.md: 共用文件只修改本分支
// 的接入点). It never imports net.js — every part of the Network it needs is handed in through the
// constructor, so the dependency stays one-way and this module can be read, tested and replaced alone.
//
// Two jobs share one budget:
//   * frames — queueFrame queues a frame when the peer cannot drain, and a pumped turn writes at most
//     PUMP_VISITS frames / PUMP_MS, so one huge broadcast cannot stall the event loop;
//   * fanout — eachConnection queues a per-connection callback and the same slices walk it, newest work
//     first, so a round of pings or a room broadcast never blocks fresh I/O.

import { performance } from 'node:perf_hooks';
import { OutboundQueue } from './outboundQueue.js';

/** One event-loop turn pumps at most this many visits (frames or connections). */
const PUMP_VISITS = 128;
/** …or this many milliseconds, whichever comes first. */
const PUMP_MS = 2;
/** ws.readyState OPEN. net.js holds the same literal for its wire primitives; kept local to stay one-way. */
const WS_OPEN = 1;

export class OutboundPump {
  /**
   * @param {{
   *   conns: Map<any, any>,
   *   opts: { maxQueuedFrames: number, backpressurePollMs: number },
   *   diagnostics: { slowDisconnects: number, droppedSnapshots: number, coalescedStates: number },
   *   defaults: { snapDropBytes: number, hardBufferBytes: number },
   *   isClosed: () => boolean,
   *   writeFrame: (ws: any, frame: any) => boolean,
   *   writeMessage: (ws: any, frame: any) => boolean,
   *   encode: (msg: any) => string | null,
   *   send: (ws: any, msg: any, encoded: string | null) => boolean,
   * }} net the parts of Network this scheduler drives
   */
  constructor({ conns, opts, diagnostics, defaults, isClosed, writeFrame, writeMessage, encode, send }) {
    this.conns = conns;
    this.opts = opts;
    this.diagnostics = diagnostics;
    this.defaults = defaults;
    this.isClosed = isClosed;
    this.writeFrame = writeFrame;
    this.writeMessage = writeMessage;
    this.encode = encode;
    this.send = send;
    /** Fanout queue (see eachConnection): FIFO jobs of per-connection callbacks, pumped in small slices. */
    this._fanout = [];
    this._fanoutImmediate = null;
    this._fanoutRunning = false;
    this._heartbeatPending = false;
    /** Per-socket FIFO frames; Map insertion order rotates recipients fairly between slices. */
    this._outbound = new Map();
    this._blockedOutbound = new Map();
    this._backpressureTimer = null;
    this._outboundImmediate = null;
    this._sendVisits = 0;
    this._sendDeadline = 0;
  }

  /** Bytes queued unsent across all open sockets ({ total, max }) — health diagnostics for a backed-up peer. */
  bufferedBytes() {
    let total = 0, max = 0;
    for (const conn of this.conns.values()) {
      const n = (conn.ws?.bufferedAmount || 0) + (this._outbound.get(conn.ws)?.bytes || this._blockedOutbound.get(conn.ws)?.bytes || 0);
      total += n;
      if (n > max) max = n;
    }
    return { total, max };
  }

  /**
   * Accept one immutable encoding, preserving FIFO across broadcasts, raw room states and unicasts.
   * The first 128 writes / 2 ms are immediate; the budget is shared across all rooms until setImmediate.
   * Deferred bytes count toward the existing snapshot-drop and disconnect limits.
   * @param {any} ws
   * @param {{ data: string, bytes: number, droppable: boolean, kind: string | null, msg: object | null, scope?: object | null, reset?: boolean }} frame
   */
  queueFrame(ws, frame) {
    const conn = this.conns.get(ws);
    if (this.isClosed() || !conn || conn.closing || ws.readyState !== WS_OPEN) return false;
    const pending = this._outbound.get(ws) || this._blockedOutbound.get(ws);
    const buffered = (ws.bufferedAmount || 0) + (pending?.bytes || 0);
    if (buffered > this.defaults.hardBufferBytes) {
      this.diagnostics.slowDisconnects++;
      try { ws.terminate(); } catch { /* socket already closing */ }
      return false;
    }
    if (frame.droppable && buffered > this.defaults.snapDropBytes) {
      this.diagnostics.droppedSnapshots++;
      return false;
    }
    // Transport probes carry no game state and may bypass queued gameplay frames.
    if (frame.kind === 'pong') return this.writeMessage(ws, frame);
    const blocked = (ws.bufferedAmount || 0) > this.defaults.snapDropBytes;
    if (!this._sendVisits) this._sendDeadline = performance.now() + PUMP_MS;
    if (!blocked && !pending && this._sendVisits < PUMP_VISITS && performance.now() < this._sendDeadline) {
      this._sendVisits++;
      this._scheduleOutbound();
      return this.writeFrame(ws, frame);
    }
    const queue = pending || new OutboundQueue();
    if (queue.push(frame, buffered > this.defaults.snapDropBytes)) this.diagnostics.coalescedStates++;
    if (queue.size > this.opts.maxQueuedFrames || (ws.bufferedAmount || 0) + queue.bytes > this.defaults.hardBufferBytes) {
      this.diagnostics.slowDisconnects++;
      this._outbound.delete(ws);
      this._blockedOutbound.delete(ws);
      try { ws.terminate(); } catch { /* socket already closing */ }
      return false;
    }
    if (blocked) {
      this._outbound.delete(ws);
      this._blockedOutbound.set(ws, queue);
      this._scheduleBackpressure();
    } else {
      this._blockedOutbound.delete(ws);
      this._outbound.set(ws, queue);
      this._scheduleOutbound();
    }
    return true;
  }

  _scheduleBackpressure() {
    if (this._backpressureTimer !== null || this.isClosed() || !this._blockedOutbound.size) return;
    this._backpressureTimer = setTimeout(() => {
      this._backpressureTimer = null;
      for (const [ws, queue] of this._blockedOutbound) {
        const conn = this.conns.get(ws);
        if (!conn || conn.closing || ws.readyState !== WS_OPEN) this._blockedOutbound.delete(ws);
        else if ((ws.bufferedAmount || 0) + queue.bytes > this.defaults.hardBufferBytes) {
          this.diagnostics.slowDisconnects++;
          this._blockedOutbound.delete(ws);
          try { ws.terminate(); } catch { /* socket already closing */ }
        } else if ((ws.bufferedAmount || 0) <= this.defaults.snapDropBytes) {
          this._blockedOutbound.delete(ws);
          this._outbound.set(ws, queue);
        }
      }
      if (this._outbound.size) this._scheduleOutbound();
      this._scheduleBackpressure();
    }, this.opts.backpressurePollMs);
    this._backpressureTimer.unref?.();
  }

  _scheduleOutbound() {
    if (this._outboundImmediate !== null || this.isClosed()) return;
    this._outboundImmediate = setImmediate(() => {
      this._outboundImmediate = null;
      this._sendVisits = 0;
      this._sendDeadline = 0;
      this._pumpOutbound();
    });
    this._outboundImmediate.unref?.();
  }

  /** Drain fairly across sockets; each socket's broadcast / private / result order stays intact. */
  _pumpOutbound() {
    this._sendDeadline = performance.now() + PUMP_MS;
    while (!this.isClosed() && this._outbound.size && this._sendVisits < PUMP_VISITS && performance.now() < this._sendDeadline) {
      const [ws, queue] = this._outbound.entries().next().value;
      this._outbound.delete(ws);
      this._sendVisits++;
      const conn = this.conns.get(ws);
      if (conn && !conn.closing && ws.readyState === WS_OPEN) {
        if ((ws.bufferedAmount || 0) > this.defaults.snapDropBytes) {
          this._blockedOutbound.set(ws, queue);
          this._scheduleBackpressure();
          continue;
        }
        const frame = queue.shift();
        if (queue.size) this._outbound.set(ws, queue);
        this.writeFrame(ws, frame);
      } else this._outbound.delete(ws);
    }
    // A final empty turn resets the shared budget even when small-room broadcasts drained synchronously.
    if (this._sendVisits || this._outbound.size) this._scheduleOutbound();
  }

  /**
   * Queue a per-connection callback over a snapshot of the current sockets and pump it in small slices
   * (at most 128 visits or 2 ms per turn, then `setImmediate`) so one huge fanout cannot stall the event
   * loop or starve fresh I/O: work that arrives between slices (new frames, replies) runs first. `fn` must
   * not throw — callbacks are invoked from setImmediate, an exception would surface as uncaughtException.
   * @param {(conn: any) => void} fn
   * @param {'broadcast' | 'heartbeat'} [kind]
   */
  eachConnection(fn, kind) {
    if (this.isClosed()) return;
    this._fanout.push({ connections: [...this.conns.values()], index: 0, fn, kind });
    if (!this._fanoutRunning && this._fanoutImmediate === null) this._pumpFanout();
  }

  /** Drain the fanout FIFO one slice; a connection is visited only while still live (Network.conns owns it). */
  _pumpFanout() {
    this._fanoutImmediate = null;
    this._fanoutRunning = true;
    const deadline = performance.now() + PUMP_MS;
    let visited = 0;
    try {
      while (!this.isClosed() && this._fanout.length && visited < PUMP_VISITS) {
        const job = this._fanout[0];
        if (job.index === job.connections.length) {
          this._fanout.shift();
          if (job.kind === 'heartbeat') this._heartbeatPending = false; // the next heartbeat() may queue a new round
          continue;
        }
        const conn = job.connections[job.index++];
        if (this.conns.get(conn.ws) === conn) job.fn(conn);
        visited++;
        if (performance.now() >= deadline) break;
      }
    } finally {
      this._fanoutRunning = false;
      if (!this.isClosed() && this._fanout.length) {
        this._fanoutImmediate = setImmediate(() => this._pumpFanout());
        this._fanoutImmediate.unref?.();
      }
    }
  }

  /**
   * Global broadcast: the same send budget also serves Lobby.broadcastRoom / broadcastState / unicasts.
   * Capture recipients now, encode once, and defer expensive writes / state deltas through queueFrame.
   * @param {object} msg
   */
  broadcastAll(msg) {
    if (this.isClosed()) return;
    const data = this.encode(msg);
    if (data == null) return;
    for (const conn of this.conns.values()) if (!conn.closing) this.send(conn.ws, msg, data);
  }

  /**
   * Queue one heartbeat round; false while the previous round has not drained yet, so a slow fanout can
   * never stack rounds. `_heartbeatPending` is cleared by the pumped job itself, not here.
   * @param {(conn: any) => void} fn
   * @returns {boolean}
   */
  runHeartbeat(fn) {
    if (this.isClosed() || this._heartbeatPending) return false;
    this._heartbeatPending = true;
    this.eachConnection(fn, 'heartbeat');
    return true;
  }

  /** Drop a socket's queues, and stop polling backpressure once no blocked peer is left (Network.onClose). */
  forget(ws) {
    this._outbound.delete(ws);
    this._blockedOutbound.delete(ws);
    if (!this._blockedOutbound.size && this._backpressureTimer !== null) {
      clearTimeout(this._backpressureTimer);
      this._backpressureTimer = null;
    }
  }

  /**
   * Flush what is still queued to the sockets that can take it, then drop every timer and queue
   * (Network.close, before it marks itself closed). No-op on a second call.
   */
  close() {
    for (const [ws, queue] of [...this._outbound, ...this._blockedOutbound]) {
      const conn = this.conns.get(ws);
      if (!conn || conn.closing || ws.readyState !== WS_OPEN) continue;
      while (queue.size) this.writeFrame(ws, queue.shift());
    }
    if (this._fanoutImmediate !== null) clearImmediate(this._fanoutImmediate);
    this._fanoutImmediate = null;
    this._fanout.length = 0;
    if (this._outboundImmediate !== null) clearImmediate(this._outboundImmediate);
    this._outboundImmediate = null;
    this._outbound.clear();
    if (this._backpressureTimer !== null) clearTimeout(this._backpressureTimer);
    this._backpressureTimer = null;
    this._blockedOutbound.clear();
  }
}
