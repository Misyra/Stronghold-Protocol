import http from 'node:http';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { ROOM_CODE_LEN } from '../shared/constants.js';
import { roomStatus } from './roomStatus.js';
import { sendJson } from './http/common.js';
import { readJsonBody } from './http/readJson.js';
import { saveRoomConfig, validateRoomConfig } from './roomConfig.js';
export { loadRoomConfig } from './roomConfig.js';

const hashSecret = (value) => createHash('sha256').update(value).digest();

const configView = (lobby) => ({ ...lobby.getRoomConfig(), foreignSessionGeoipAvailable: !!lobby.botPopulation.countryLookup });

// 联机站（Agent）一批最多问二十个房间（docs/design/portal-agent-wss.md §12.4）。上限写在这里而不是让调用方
// 自觉：一条请求就能让游戏把整张大厅表算一遍，而那正是这个端点要避免的事。
export const MAX_STATUS_BATCH = 20;

const CODE_RE = new RegExp(`^[A-Z]{${ROOM_CODE_LEN}}$`);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The projection the 联机站 (and only it) sees. Deliberately NOT roomStatus(): that one carries seat names, ready
 * flags and the host name for the lobby page of that same room. This one crosses machines, lands in the central
 * panel, in its public room list and in history archives, so it is limited to what a room card needs — counts,
 * mode, difficulty, phase, and the instance id. No seat names, no player ids, no IPs, no loadouts.
 */
function portalRoomView(room, now = Date.now()) {
  const s = roomStatus(room, now);
  return {
    code: s.code, roomId: s.roomId, mode: s.mode,
    difficulty: s.difficulty, difficultyName: s.difficultyName,
    capacity: s.capacity, occupied: s.occupied, humans: s.humans,
    inMatch: s.inMatch, joinable: s.joinable, phase: s.phase, round: s.round,
  };
}

// 「这个码现在指着哪间房、现在长什么样」的唯一答案。房间不在时是 state:'closed' 而不是 404：调用方要能区分
// 「问过了，没有」与「没问成」（后者是 4xx/5xx/超时），混起来会让 Agent 把一次查询失败当成房间被销毁。
function portalStatus(room, { now = Date.now(), gameBootId = null } = {}) {
  if (!room || room.disposed) return { state: 'closed', roomId: null };
  return { state: 'ok', roomId: room.roomId, createdAt: room.createdAt, gameBootId, room: portalRoomView(room, now) };
}

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

export async function listenRoomAdmin({ lobby, registry, token, port = 3001, stateFile, gameBootId = randomUUID(), log = console }) {
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
    // 路由白名单。`/api/portal/rooms*` 是联机站 Agent 的私有入口（§13.3）：少了这一行，新端点会被顶层
    // 404 截掉，而症状是「Agent 说游戏不支持这个功能」——排查方向整个错。
    if (!url.pathname.startsWith('/api/rooms') && url.pathname !== '/api/room-config'
      && !url.pathname.startsWith('/api/portal/rooms')) return sendJson(req, res, 404, { error: 'NOT_FOUND' });
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
        // 游戏启动号（§13.3）：Agent 把它随 sync.report / 房间观测一路报给中央，中央据此判「这台游戏进程
        // 重启过，它上一次说过的一切都不再成立」。放在同一个响应里是因为探针就是从这里读配置版本的。
        gameBootId,
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

    // ─── 联机站（Agent）私有入口 ───────────────────────────────────────────────────────────────────
    // 只有本机 Agent 用得上，而且只回答两件事：「这个房间码现在是不是那间房」（实例号）与「它现在长什么样」
    // （能不能加入、几个人、什么阶段）。房间不在时回 state:'closed'（问过了，没有），**不是** 404 ——
    // 调用方必须能区分「确认不存在」和「没问成」，后者只能算未知，否则一次抖动就会让中央删掉登记。
    const portalStatusMatch = new RegExp(`^/api/portal/rooms/([A-Z]{${ROOM_CODE_LEN}})/status$`, 'i').exec(url.pathname);
    if (portalStatusMatch && ['GET', 'HEAD'].includes(req.method)) {
      const room = lobby.getRoom(portalStatusMatch[1].toUpperCase());
      return sendJson(req, res, 200, portalStatus(room, { now: Date.now(), gameBootId }));
    }

    if (url.pathname === '/api/portal/rooms/status-batch') {
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return sendJson(req, res, 405, { error: 'METHOD_NOT_ALLOWED' }); }
      let body;
      try { body = await readJsonBody(req, { maxBytes: 8192 }); } catch (error) {
        if (res.destroyed) return;
        if (!req.complete) res.setHeader('Connection', 'close');
        return sendJson(req, res, error.status || 400, { error: error.code });
      }
      const items = body?.items;
      // 整批拒而不是「跳过这一条」：条目形状不对说明对面和我们说的不是同一件事（或者有人在手工构造请求），
      // 悄悄少答一条会让对面把「本机确认不存在」和「你没问我」混在一起。
      if (!Array.isArray(items) || items.length < 1 || items.length > MAX_STATUS_BATCH)
        return sendJson(req, res, 400, { error: 'INVALID_ITEMS', maxItems: MAX_STATUS_BATCH });
      const seen = new Set();
      for (const item of items) {
        const listingId = item?.listingId, code = typeof item?.code === 'string' ? item.code.toUpperCase() : '';
        if (typeof listingId !== 'string' || !UUID_RE.test(listingId) || !CODE_RE.test(code) || seen.has(listingId))
          return sendJson(req, res, 400, { error: 'INVALID_ITEMS', maxItems: MAX_STATUS_BATCH });
        seen.add(listingId);
      }
      const now = Date.now();
      // 只回答问题里问到的那些码，从不枚举其它房间：这个端点的用途是「盯着几间房」，不是「列出所有房间」。
      return sendJson(req, res, 200, { serverNow: now, gameBootId,
        rooms: items.map((item) => ({ listingId: item.listingId, ...portalStatus(lobby.getRoom(item.code.toUpperCase()), { now, gameBootId }) })) });
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

    if (url.pathname === '/api/rooms' || url.pathname === '/api/room-config' || closeMatch || portalStatusMatch)
      res.setHeader('Allow', url.pathname === '/api/rooms' ? 'GET, HEAD'
        : url.pathname === '/api/room-config' ? 'GET, HEAD, PUT' : closeMatch ? 'POST' : 'GET, HEAD');
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
