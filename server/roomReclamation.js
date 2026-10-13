/** Fork-specific capacity policy. Lobby remains the sole owner of room destruction. */
export class RoomReclamation {
  constructor(lobby) {
    this.lobby = lobby;
    this.state = { active: false, reclaimed: 0 };
    this.lastAt = -Infinity;
    this.timer = setInterval(() => {
      try { this.lobby.reclaimOfflineRooms(); }
      catch (error) { this.lobby.log.error('[lobby] offline room reclamation failed', error); }
    }, 15000);
    this.timer.unref();
  }

  members(room) { return [...room.activeHumans(), ...room.spectators]; }
  online(seat) { return seat.connected || this.lobby.registry.byId(seat.playerId)?.connected; }

  reclaim({ force = false } = {}) {
    const lobby = this.lobby, max = lobby.opts.maxRooms;
    if (lobby.draining || max <= 0) return 0;
    const target = Math.ceil(max * 4 / 5) - 1;
    if (lobby.rooms.size <= target) { this.state.active = false; return 0; }
    if (!this.state.active && lobby.rooms.size * 10 < max * 9) return 0;
    this.state.active = true;
    const now = lobby.now();
    if (!force && now - this.lastAt < 1000) return 0;
    this.lastAt = now;
    const candidates = [];
    for (const room of lobby.rooms.values()) {
      const seats = this.members(room);
      if (seats.some((seat) => this.online(seat))) continue;
      let offlineSince = room.createdAt;
      for (const seat of seats) {
        const at = lobby.registry.byId(seat.playerId)?.disconnectedAt;
        if (Number.isFinite(at)) offlineSince = Math.max(offlineSince, at);
      }
      candidates.push({ room, offlineSince });
    }
    candidates.sort((a, b) => a.offlineSince - b.offlineSince || a.room.createdAt - b.room.createdAt || a.room.code.localeCompare(b.room.code));
    const before = lobby.rooms.size;
    let reclaimed = 0;
    for (const { room } of candidates) {
      if (lobby.rooms.size <= target) break;
      if (room.disposed || this.members(room).some((seat) => this.online(seat))) continue;
      lobby.disposeRoom(room, 'capacity');
      reclaimed++;
      lobby.onCheckpoint?.(room.code, null);
    }
    this.state.reclaimed += reclaimed;
    if (lobby.rooms.size <= target) this.state.active = false;
    if (reclaimed) lobby.audit('room.pressure.reclaimed', null, null,
      { before, after: lobby.rooms.size, maxRooms: max, targetRooms: target, reclaimed, active: this.state.active });
    return reclaimed;
  }

  stats() { return { ...this.state }; }
  stop() { clearInterval(this.timer); }
}
