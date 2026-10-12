import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOM_CODE_LEN } from '../shared/constants.js';
import { sendJson } from './http/common.js';

const hashSecret = (value) => createHash('sha256').update(value).digest();

export async function loadRoomConfig(file) {
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    if (state?.schemaVersion !== 1 || !Number.isSafeInteger(state.maxRooms) || state.maxRooms < 1 || state.maxRooms > 10000)
      throw new Error('invalid room admin state');
    if (Object.hasOwn(state, 'allowBots') && typeof state.allowBots !== 'boolean') throw new Error('invalid bot policy');
    return { maxRooms: state.maxRooms, ...(typeof state.allowBots === 'boolean' ? { allowBots: state.allowBots } : {}) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`cannot read room admin state at ${file}: ${error.message}`);
  }
}

async function saveRoomConfig(file, config) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, ...config }) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}

function authorized(req, expected) {
  const value = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
    ? req.headers.authorization.slice(7) : '';
  const actual = hashSecret(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function readJson(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('INVALID_JSON'), { status: 400 })); }
    });
    req.on('error', () => reject(Object.assign(new Error('REQUEST_ABORTED'), { status: 400 })));
  });
}

function roomView(room, lobby, registry) {
  return {
    ...lobby.getRoomStatus(room.code), createdAt: room.createdAt, matchCount: room.matchCount,
    offlinePaused: !!room.match?.offlinePaused, botRehearsal: room.match?.botRehearsal ?? null,
    computation: room.match ? { pending: room.match._workerTasks?.size || 0, ...room.match.workerStats } : null,
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

    if (url.pathname === '/api/rooms' && ['GET', 'HEAD'].includes(req.method)) {
      const limit = Number(url.searchParams.get('limit') ?? 100), offset = Number(url.searchParams.get('offset') ?? 0);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0)
        return sendJson(req, res, 400, { error: 'INVALID_PAGINATION' });
      const rooms = [...lobby.rooms.values()].filter((room) => !room.disposed);
      return sendJson(req, res, 200, { total: rooms.length, offset, limit, serverNow: Date.now(),
        config: { maxRooms: lobby.opts.maxRooms, allowBots: lobby.opts.allowBots }, rooms: rooms.slice(offset, offset + limit).map((room) => roomView(room, lobby, registry)) });
    }

    if (url.pathname === '/api/room-config') {
      if (req.method === 'GET' || req.method === 'HEAD') return sendJson(req, res, 200, {
        maxRooms: lobby.opts.maxRooms, allowBots: lobby.opts.allowBots, roomCount: lobby.rooms.size, maxAllowed: 10000,
      });
      if (req.method === 'PUT') {
        let body;
        try { body = await readJson(req); } catch (error) { return sendJson(req, res, error.status || 400, { error: error.message }); }
        if (!body || Array.isArray(body) || typeof body !== 'object' || !Object.keys(body).length ||
          Object.keys(body).some((key) => !['maxRooms', 'allowBots'].includes(key)))
          return sendJson(req, res, 400, { error: 'INVALID_ROOM_CONFIG' });
        if (Object.hasOwn(body, 'maxRooms') && (!Number.isSafeInteger(body.maxRooms) || body.maxRooms < 1 || body.maxRooms > 10000))
          return sendJson(req, res, 400, { error: 'INVALID_MAX_ROOMS', maxAllowed: 10000 });
        if (Object.hasOwn(body, 'allowBots') && typeof body.allowBots !== 'boolean')
          return sendJson(req, res, 400, { error: 'INVALID_ALLOW_BOTS' });
        const update = limitWrites.then(async () => {
          const previous = { maxRooms: lobby.opts.maxRooms, allowBots: lobby.opts.allowBots };
          const next = { ...previous, ...body };
          await saveRoomConfig(stateFile, next);
          Object.assign(lobby.opts, next);
          if (previous.maxRooms !== next.maxRooms)
            log.info('[audit] ' + JSON.stringify({ at: new Date().toISOString(), action: 'room.limit.changed', previous: previous.maxRooms, maxRooms: next.maxRooms }));
          if (previous.allowBots !== next.allowBots) {
            log.info('[audit] ' + JSON.stringify({ at: new Date().toISOString(), action: 'room.botPolicy.changed', previous: previous.allowBots, allowBots: next.allowBots }));
            for (const room of lobby.rooms.values()) if (!room.match) lobby.broadcastState(room);
          }
          return { ...next, roomCount: lobby.rooms.size, persisted: true };
        });
        limitWrites = update.catch(() => {});
        try { return sendJson(req, res, 200, await update); }
        catch (error) { log.error('[room-admin] failed to save room limit', error); return sendJson(req, res, 503, { error: 'ROOM_LIMIT_SAVE_FAILED' }); }
      }
    }

    const closeMatch = new RegExp(`^/api/rooms/([A-Z]{${ROOM_CODE_LEN}})/close$`, 'i').exec(url.pathname);
    if (closeMatch && req.method === 'POST') {
      let body;
      try { body = await readJson(req); } catch (error) { return sendJson(req, res, error.status || 400, { error: error.message }); }
      const room = lobby.getRoom(closeMatch[1]);
      if (!room || room.disposed) return sendJson(req, res, 404, { error: 'ROOM_NOT_FOUND' });
      if (!Number.isSafeInteger(body?.createdAt) || room.createdAt !== body.createdAt)
        return sendJson(req, res, 409, { error: 'ROOM_CHANGED' });
      const roomCode = room.code, createdAt = room.createdAt;
      lobby.disposeRoom(room, 'admin');
      lobby.onCheckpoint?.(roomCode, null);
      log.info('[audit] ' + JSON.stringify({ at: new Date().toISOString(), action: 'room.adminClosed', roomCode, roomCreatedAt: createdAt }));
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
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections?.();
    }) };
}
