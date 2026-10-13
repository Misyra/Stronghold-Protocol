import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ROOM_CODE_LEN } from '../shared/constants.js';
import { sendJson } from './http/common.js';
import { readJsonBody } from './http/readJson.js';
import { saveRoomConfig, validateRoomConfig } from './roomConfig.js';
export { loadRoomConfig } from './roomConfig.js';

const hashSecret = (value) => createHash('sha256').update(value).digest();

const configView = (lobby) => ({ ...lobby.getRoomConfig(), foreignSessionGeoipAvailable: !!lobby.botPopulation.countryLookup });

function authorized(req, expected) {
  const value = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
    ? req.headers.authorization.slice(7) : '';
  const actual = hashSecret(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function roomView(room, lobby, registry) {
  return {
    ...lobby.getRoomStatus(room.code), createdAt: room.createdAt, matchCount: room.matchCount,
    offlinePaused: !!room.match?.offlinePaused, botRehearsal: room.match?.botRehearsal ?? null,
    computation: room.match ? { pending: room.match.pendingWorkerTasks || 0, ...room.match.workerStats } : null,
    players: room.seats.filter((seat) => seat && !seat.isBot).map((seat) => {
      const session = registry.byId(seat.playerId);
      return { playerId: seat.playerId, name: seat.name, ip: session?.addr || null,
        connected: !!(session?.connected && seat.connected && !seat.left), left: !!seat.left, seat: seat.seat };
    }),
  };
}

export async function listenRoomAdmin({ lobby, registry, token, port = 3001, stateFile, log = console }) {
  if (!token) return null;
  const expected = hashSecret(token);
  let limitWrites = Promise.resolve();
  let draining = false;
  const server = http.createServer((req, res) => {
    Promise.resolve().then(async () => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); }
    catch { return sendJson(req, res, 400, { error: 'INVALID_URL' }); }
    if (!url.pathname.startsWith('/api/rooms') && url.pathname !== '/api/room-config') return sendJson(req, res, 404, { error: 'NOT_FOUND' });
    if (!authorized(req, expected)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return sendJson(req, res, 401, { error: 'UNAUTHORIZED' });
    }

    if ((draining || lobby.draining) && !['GET', 'HEAD'].includes(req.method))
      return sendJson(req, res, 503, { error: 'SERVER_DRAINING' });

    if (url.pathname === '/api/rooms' && ['GET', 'HEAD'].includes(req.method)) {
      const limit = Number(url.searchParams.get('limit') ?? 100), offset = Number(url.searchParams.get('offset') ?? 0);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0)
        return sendJson(req, res, 400, { error: 'INVALID_PAGINATION' });
      const rooms = [...lobby.rooms.values()].filter((room) => !room.disposed);
      return sendJson(req, res, 200, { total: rooms.length, offset, limit, serverNow: Date.now(),
        config: configView(lobby), rooms: rooms.slice(offset, offset + limit).map((room) => roomView(room, lobby, registry)) });
    }

    if (url.pathname === '/api/room-config') {
      if (req.method === 'GET' || req.method === 'HEAD') return sendJson(req, res, 200, {
        ...configView(lobby), roomCount: lobby.rooms.size, maxAllowed: 10000,
      });
      if (req.method === 'PUT') {
        let body;
        try { body = await readJsonBody(req, { maxBytes: 2048 }); } catch (error) {
          if (res.destroyed) return;
          if (!req.complete) res.setHeader('Connection', 'close');
          return sendJson(req, res, error.status || 400, { error: error.code });
        }
        if (draining || lobby.draining) return sendJson(req, res, 503, { error: 'SERVER_DRAINING' });
        const error = validateRoomConfig(body, { partial: true });
        if (error) return sendJson(req, res, 400, { error, ...(error === 'INVALID_MAX_ROOMS' ? { maxAllowed: 10000 } : {}) });
        const update = limitWrites.then(async () => {
          const next = { ...lobby.getRoomConfig(), ...body };
          await saveRoomConfig(stateFile, next);
          return { ...lobby.applyRoomConfig(next), foreignSessionGeoipAvailable: !!lobby.botPopulation.countryLookup, persisted: true };
        });
        limitWrites = update.catch(() => {});
        try { return sendJson(req, res, 200, await update); }
        catch (error) { log.error('[room-admin] failed to save room limit', error); return sendJson(req, res, 503, { error: 'ROOM_LIMIT_SAVE_FAILED' }); }
      }
    }

    const closeMatch = new RegExp(`^/api/rooms/([A-Z]{${ROOM_CODE_LEN}})/close$`, 'i').exec(url.pathname);
    if (closeMatch && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req, { maxBytes: 2048 }); } catch (error) {
        if (res.destroyed) return;
        if (!req.complete) res.setHeader('Connection', 'close');
        return sendJson(req, res, error.status || 400, { error: error.code });
      }
      if (draining || lobby.draining) return sendJson(req, res, 503, { error: 'SERVER_DRAINING' });
      const room = lobby.getRoom(closeMatch[1]);
      if (!room || room.disposed) return sendJson(req, res, 404, { error: 'ROOM_NOT_FOUND' });
      if (!Number.isSafeInteger(body?.createdAt) || room.createdAt !== body.createdAt)
        return sendJson(req, res, 409, { error: 'ROOM_CHANGED' });
      const roomCode = room.code, createdAt = room.createdAt;
      lobby.disposeRoom(room, 'admin');
      lobby.checkpoint(roomCode, null);
      lobby.audit('room.adminClosed', null, room);
      return sendJson(req, res, 200, { ok: true, roomCode, createdAt });
    }

    if (url.pathname === '/api/rooms' || url.pathname === '/api/room-config' || closeMatch)
      res.setHeader('Allow', url.pathname === '/api/rooms' ? 'GET, HEAD' : url.pathname === '/api/room-config' ? 'GET, HEAD, PUT' : 'POST');
    return sendJson(req, res, 405, { error: 'METHOD_NOT_ALLOWED' });
    }).catch((error) => {
      log.error('[room-admin] request failed', error);
      if (!res.headersSent) sendJson(req, res, 500, { error: 'INTERNAL_ERROR' });
      else res.destroy();
    });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;
  return { server, port: actualPort, url: `http://127.0.0.1:${actualPort}`,
    drain: () => { draining = true; return limitWrites; },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections?.();
    }) };
}
