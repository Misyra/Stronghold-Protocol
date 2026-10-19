import http from 'node:http';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { ROOM_CODE_LEN } from '../shared/constants.js';
import { roomStatus } from './roomStatus.js';
import { sendJson } from './http/common.js';
import { readJsonBody } from './http/readJson.js';
import { roomConfigDocument, roomConfigMutation, roomConfigReadDocument, saveRoomConfigDocument, validateRoomConfig } from './roomConfig.js';
export { loadRoomConfig, loadRoomConfigDocument } from './roomConfig.js';

const hashSecret = (value) => createHash('sha256').update(value).digest();

const configView = (lobby) => ({ ...lobby.getRoomConfig(), foreignSessionGeoipAvailable: !!lobby.botPopulation.countryLookup });

// 联机站（Agent）一批最多问二十个房间（docs/design/portal-agent-wss.md §45.4）。上限写在这里而不是让调用方
// 自觉：一条请求就能让游戏把整张大厅表算一遍，而那正是这个端点要避免的事。
export const MAX_STATUS_BATCH = 20;

// 版本化配置写（POST/PUT /api/room-config）允许的请求键（§43.2）。多一个键就说明两边对「这次写是什么」
// 的理解已经不一致：猜着办比直接说不认识这个字段危险得多，所以这里整份拒掉。
const ROOM_CONFIG_WRITE_FIELDS = Object.freeze(['expectedRevision', 'patch', 'opId', 'expiresAt']);

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

// 面板问「这间房说过什么」。答案有两个来源：审计日志（已经落盘的那部分）与房间自己的环形缓冲（还没落盘、
// 或者刚落盘但仍在缓冲里的那几条）。日志读不出来不算故障，只说明更早的那段读不到（partial）—— 这间房现在
// 还在内存里的聊天照样能交差，把一次读盘失败变成 5xx 才是真的把信息丢了。
async function roomChatHistory(chatLog, room, limit, now) {
  const since = room.createdAt;
  // 没有 ChatLog 实例（测试、或者日志被关掉）：只有内存这一段，如实标 partial。
  let log = { messages: [], truncated: false, partial: true };
  if (chatLog && typeof chatLog.roomRecords === 'function') {
    try { log = await chatLog.roomRecords({ code: room.code, since, limit, now }); }
    // 契约上 roomRecords 不抛，但这是跨文件系统的调用：兜一层比让面板看到一个 500 便宜。
    catch { log = { messages: [], truncated: false, partial: true }; }
  }
  const seen = new Set();
  const merged = [];
  const take = (message) => {
    // 两条来源会重叠：一条消息落盘之后仍然待在那 50 条环形缓冲里，两边都算就会重复。
    const key = `${message.playerId}\u0000${message.at}\u0000${message.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(message);
  };
  for (const message of log.messages) take(message);
  // 环形缓冲里没有 IP（那份记录只有审计日志有），所以这里如实给 null，而不是去猜一个。
  for (const message of room.chatMessages || []) {
    if (!Number.isFinite(message?.at) || message.at < since) continue;
    take({ at: message.at, ip: null, playerId: message.playerId, name: message.name, text: message.text });
  }
  merged.sort((a, b) => a.at - b.at);
  // 日志那边已经截过一次，这里再截一次：合并之后超出的只会是更早的那些。
  return { messages: merged.slice(-limit), truncated: log.truncated || merged.length > limit, partial: log.partial };
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

export async function listenRoomAdmin({ lobby, registry, token, port = 3001, stateFile, gameBootId = randomUUID(),
  roomConfig = null, chatLog = lobby.chatLog ?? null, log = console }) {
  if (!token) return null;
  const expected = hashSecret(token);
  // 配置文档的当前版本（§43.2）。调用方（index.js）已经把它读出来了，因为启动时要用它覆盖环境默认值 ——
  // 再读一次就会读到两个可能不同的版本号。没有文件时就是「第 1 版」，值与进程当前生效的一致。
  let configState = roomConfig ?? { values: lobby.getRoomConfig(), revision: 1, lastMutation: null };
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
    // 路由白名单。`/api/portal/rooms*` 是联机站 Agent 的私有入口（§46.3）：少了这一行，新端点会被顶层
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
        // 配置版本（§43.2）。页面拿它去当下一次写的 expectedRevision，中央靠它判「过时页面」；values 是
        // **已落盘**的那一份，平铺在顶层只是为了过渡期兼容旧面板/旧脚本。读取不给 persisted/applied：
        // 那两个字段描述的是「这一次写有没有落地」，读响应上没有它们的含义。
        ...roomConfigReadDocument(configState),
        // 游戏启动号（§46.3）：Agent 把它随 sync.report / 房间观测一路报给中央，中央据此判「这台游戏进程
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
        // `null` / 数组 / 非对象都是「参数错」（400），不是「服务内部错误」（500）：把形状收口放在这里，
        // 下面就可以放心 `Object.hasOwn` 了。
        if (!body || typeof body !== 'object' || Array.isArray(body))
          return sendJson(req, res, 400, { error: 'INVALID_ROOM_CONFIG' });
        // 两种形状：中央来的版本化写（expectedRevision + patch）与迁移期保留的旧写（直接给字段）。旧写也要
        // 走同一个串行入口并递增 revision（§43.2），否则它会成为绕过版本控制的那条暗路。
        const versioned = Object.hasOwn(body, 'expectedRevision') || Object.hasOwn(body, 'patch');
        let patch = body;
        if (versioned) {
          const unknown = Object.keys(body).filter((key) => !ROOM_CONFIG_WRITE_FIELDS.includes(key));
          if (unknown.length || !Number.isSafeInteger(body.expectedRevision) ||
            !body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch))
            return sendJson(req, res, 400, { error: 'INVALID_ROOM_CONFIG' });
          if (body.opId != null && !UUID_RE.test(String(body.opId)))
            return sendJson(req, res, 400, { error: 'INVALID_OP_ID' });
          patch = body.patch;
        }
        const error = validateRoomConfig(patch, { partial: true });
        if (error) return sendJson(req, res, 400, { error, ...(error === 'INVALID_MAX_ROOMS' ? { maxAllowed: 10000 } : {}) });
        // 写响应的公共尾巴：房间数（旧面板在显示）与 GeoIP 可用性（决定那条策略能不能真的生效）。
        const written = (options = {}) => roomConfigDocument(configState, { ...options,
          extra: { roomCount: lobby.rooms.size, foreignSessionGeoipAvailable: !!lobby.botPopulation.countryLookup, ...options.extra } });
        const conflict = (code, extra) => Object.assign(new Error(code), { status: 409, payload: { error: code, ...extra } });
        // 版本判定必须发生在队列**内部**：入队前比一次 revision，两个同时到达的写就都会看到同一个旧版本，
        // 两个都通过 —— 那正是「两个人同时改配置，后写的那份悄悄盖掉前一份」。
        const update = limitWrites.then(async () => {
          const expiresAt = Number.isSafeInteger(body.expiresAt) ? body.expiresAt : null;
          const decision = roomConfigMutation(configState, { patch,
            expectedRevision: versioned ? body.expectedRevision : null,
            opId: versioned && body.opId ? body.opId : null, expiresAt, now: Date.now() });
          if (decision.error === 'CONFIG_CONFLICT')
            // 冲突时把**实际值**一起回去：过时的页面要能直接显示「现在是什么」，再由管理员决定重不重发（§43.3）。
            throw conflict('CONFIG_CONFLICT', { revision: configState.revision,
              values: { ...configState.values }, lastMutation: configState.lastMutation });
          if (decision.error === 'OP_ID_CONFLICT') throw conflict('OP_ID_CONFLICT', { revision: configState.revision });
          if (decision.error === 'DEADLINE_EXCEEDED')
            return written({ extra: { expired: true } });
          if (decision.error) throw conflict(decision.error);
          // 重放（回执丢了、中央重发）：不落盘、不递增 revision，回报原来那个版本号。
          if (decision.replayed)
            return written({ persisted: true, applied: true,
              extra: { replayed: true, originalResultRevision: decision.originalResultRevision } });
          // 先落盘，再改内存。顺序反了的话，一次写失败会让运行值已经变了而磁盘上没有，重启后「悄悄变回去」。
          await saveRoomConfigDocument(stateFile, decision);
          configState = { values: decision.values, revision: decision.revision, lastMutation: decision.lastMutation };
          let applied = true;
          try { lobby.applyRoomConfig(decision.values); } catch (error) {
            // 落盘成功但应用失败：如实分开报（persisted=true / applied=false），让操作者知道磁盘已经变了 ——
            // 报「整体失败」会让他以为磁盘也没改，于是再改一次，反而把两次改动叠加起来。
            applied = false;
            log.error('[room-admin] saved room config could not be applied; restart will load it', error);
          }
          return written({ persisted: true, applied });
        });
        limitWrites = update.catch(() => {});
        try { return sendJson(req, res, 200, await update); }
        catch (error) {
          if (error.status) return sendJson(req, res, error.status, error.payload);
          log.error('[room-admin] failed to save room limit', error);
          return sendJson(req, res, 503, { error: 'ROOM_LIMIT_SAVE_FAILED' });
        }
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
      // 过期命令不执行（§11）：中央那边可能已经放弃、已经超时，再关掉一个「它以为早就关了」的房间只会
      // 让现场与它的记录对不上。回 200 + closed:false 而不是错误码 —— 这是「确定没执行」，不是故障。
      if (Number.isSafeInteger(body?.expiresAt) && body.expiresAt > 0 && Date.now() > body.expiresAt)
        return sendJson(req, res, 200, { closed: false, code: 'DEADLINE_EXCEEDED',
          roomCode: room.code, roomId: room.roomId, createdAt: room.createdAt });
      // 实例校验（§11）：房间码会被复用，光凭码关房等于「关掉同码的下一间房」。roomId 是主判据（跨机那条路
      // 带的就是它），createdAt 保留给旧调用方；两个都得对，而且至少要有一个 —— 什么凭据都不给就不执行。
      if (body?.roomId != null && body.roomId !== room.roomId) return sendJson(req, res, 409, { error: 'ROOM_CHANGED' });
      const hasInstance = body?.roomId != null || Number.isSafeInteger(body?.createdAt);
      if (!hasInstance || (Number.isSafeInteger(body?.createdAt) && room.createdAt !== body.createdAt))
        return sendJson(req, res, 409, { error: 'ROOM_CHANGED' });
      const roomCode = room.code, createdAt = room.createdAt, roomId = room.roomId;
      lobby.disposeRoom(room, 'admin');
      lobby.checkpoint(roomCode, null);
      lobby.audit('room.adminClosed', null, room);
      // closed 只在这一个条件下是 true —— 中央拿它当「明确说成了」的依据（§43.3），其余一律转读回自证。
      return sendJson(req, res, 200, { closed: true, roomCode, roomId, createdAt });
    }

    // 单间房的聊天回看（运维面板 → 本机探针）。只读，房间码的形状、大小写处理与关房那条完全一致：
    // 面板手里的码可能来自别处，大小写不该让同一个码变成两种结果。
    const chatMatch = new RegExp(`^/api/rooms/([A-Z]{${ROOM_CODE_LEN}})/chat$`, 'i').exec(url.pathname);
    if (chatMatch && ['GET', 'HEAD'].includes(req.method)) {
      const raw = url.searchParams.get('limit');
      const limit = raw === null ? 100 : Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200)
        return sendJson(req, res, 400, { error: 'INVALID_LIMIT', min: 1, max: 200 });
      const room = lobby.getRoom(chatMatch[1].toUpperCase());
      // 这里的 404 只表示「真没有这间房 / 已经销毁」。读日志失败走的是 200 + partial:true，绝不能混在一起：
      // 一次读盘抖动让面板把房间显示成已消失，比少给几条聊天记录严重得多。
      if (!room || room.disposed) return sendJson(req, res, 404, { error: 'ROOM_NOT_FOUND' });
      const now = Date.now();
      const history = await roomChatHistory(chatLog, room, limit, now);
      return sendJson(req, res, 200, { code: room.code, roomId: room.roomId, createdAt: room.createdAt,
        serverNow: now, limit, truncated: history.truncated, partial: history.partial, messages: history.messages });
    }

    if (url.pathname === '/api/rooms' || url.pathname === '/api/room-config' || closeMatch || portalStatusMatch || chatMatch)
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
