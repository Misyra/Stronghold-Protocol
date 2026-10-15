// 房间分享的浏览器入口：GET 报告功能状态，POST 提交当前房间，GET /status 查登记结果。
//
// 这个文件有两种显式模式（docs/design/portal-agent-wss.md §45.1、§46.3、§47.3）：
//
//   off          —— 没配就是不开放：浏览器拿 enabled:false，界面隐藏分享。
//   legacy-http  —— 游戏自己带 HMAC 签名直连中央的老路（第三方站继续用它）。旧配置（完整的 HMAC 三项）
//                   不写模式也按它处理，所以升级这个文件不会让已上线的站点忽然停止分享。
//   agent        —— 分享**不**出游戏：提交到本机 Agent 的桥接口（独立桥接 Token），由 Agent 用自己的
//                   中央连接去登记。游戏因此不需要中央的凭据，也不需要能被中央从公网访问。
//
// 三个入口都不改动「谁能提交」的判断（在线会话、当前房主、协力待机空位、同源、限流），那是游戏私有的
// 业务规则；这里新增的只有「提交之后怎么知道成没成」：agent 模式下登记结果可能是**未知**（回执在路上丢了），
// 于是回 202 + opId，界面必须去查，而不能把 response.ok 当成已收录。
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { TokenBucket } from '../net.js';
import { createStatusLimiter } from '../roomStatus.js';
import { readJsonBody } from './readJson.js';
import { sendJson } from './common.js';
import { N_ } from '../../shared/i18n.js';

/** 分享模式（§47.3）。 */
export const PORTAL_ROOM_MODES = Object.freeze(['off', 'legacy-http', 'agent']);

/** Agent 桥接路径（lib/game-bridge.mjs 的 BRIDGE_BASE_PATH，相对 Agent 的根路径）。 */
export const PORTAL_ROOM_BRIDGE_PATH = 'internal/game/v1/publications';

/** 全链路预算，与桥那边的 shareMs 一致：浏览器等 10 秒，这里 8 秒必须放弃（§39.4）。 */
export const PORTAL_ROOM_SHARE_MS = 8000;
/** 结果查询的预算。比提交短：它只是问一句「上次那次成了吗」。 */
export const PORTAL_ROOM_QUERY_MS = 5000;
/** 登记的有效期（中央十分钟），用于判断还记得的那个 opId 是否还值得复用。 */
export const PORTAL_ROOM_TTL_MS = 600_000;

// 「分享现在能不能用」的本机短期缓存（§45.5）：每个浏览器探测都去打一次 Agent 是不能接受的，而 Agent
// 的可用性本来也不该按浏览器的刷新频率去问。
const AVAILABILITY_TTL_MS = 15_000;
const AVAILABILITY_TIMEOUT_MS = 1_000;

/** 公开功能探测的路径与认证入口。 */
export const PORTAL_ROOM_PATH = '/api/portal-room';
export const PORTAL_ROOM_STATUS_PATH = '/api/portal-room/status';

// 桥接回执（业务状态，§45.1）→ 浏览器看到的 HTTP 处置。**不能**把「结果未知」和「被拒」混起来：前者要留
// opId 去查，后者可以直接当失败显示。没有列进来的码一律 502 + 连接失败，绝不猜一个「大概算成功」。
// 表里的文案是模块级字面量，按 i18n 的约定包 N_() 标记（它们在这里就被定下，之后由浏览器按语言渲染）。
const SHARE_FAILURES = Object.freeze({
  ROOM_NOT_FOUND: [409, N_('房间状态已变化，请刷新后重试')],
  ROOM_NOT_JOINABLE: [409, N_('仅可提交尚有空位的待机同盟')],
  ROOM_CHANGED: [409, N_('房间状态已变化，请刷新后重试')],
  PUBLICATION_ENDED: [409, N_('房间状态已变化，请刷新后重试')],
  OP_ID_CONFLICT: [409, N_('房间状态已变化，请刷新后重试')],
  LISTING_LIMIT: [429, N_('提交过于频繁，请稍后重试')],
  BUSY: [429, N_('提交过于频繁，请稍后重试')],
  SHARE_UNAVAILABLE: [503, N_('联机站暂不可用，请稍后重试')],
  ROOM_CHECK_BACKOFF: [503, N_('联机站暂不可用，请稍后重试')],
  STORAGE_WRITE_FAILED: [503, N_('联机站暂不可用，请稍后重试')],
  STORAGE_UNCERTAIN: [503, N_('联机站暂不可用，请稍后重试')],
  CLOCK_SKEW: [503, N_('联机站暂不可用，请稍后重试')],
  AGENT_OFFLINE: [503, N_('联机站暂不可用，请稍后重试')],
  NOT_READY: [503, N_('联机站暂不可用，请稍后重试')],
  BRIDGE_NOT_CONFIGURED: [503, N_('联机站暂不可用，请稍后重试')],
});

/** 这些码说明「链路/本机 Agent 这一侧」不可用，公开探测要立刻转成「暂不可用」，别等下一次缓存过期。 */
const UNAVAILABLE_CODES = new Set(['AGENT_OFFLINE', 'NOT_READY', 'BRIDGE_NOT_CONFIGURED', 'INTERNAL_ERROR']);

const sameOrigin = (req) => req.headers['sec-fetch-site'] !== 'cross-site' &&
  (!req.headers.origin || (() => { try { return new URL(req.headers.origin).host === req.headers.host; } catch { return true; } })());

/**
 * `POST` / `GET /status` 都要能分辨「问的是什么」。
 * @param {import('node:http').IncomingMessage} req
 */
function parseTarget(req) {
  try { const url = new URL(req.url || '/', 'http://127.0.0.1'); return { pathname: url.pathname, query: url.searchParams }; }
  catch { return null; }
}

/**
 * Opt-in server relay. Neither the destination nor room identity comes from the browser.
 * @param {{ registry: object, lobby: object, trustProxy?: 'auto' | boolean, mode?: string | null,
 *   url?: string | null, siteId?: string | null, key?: string | null, agentUrl?: string | null,
 *   bridgeToken?: string | null, now?: () => number, fetchImpl?: typeof fetch, log?: object }} [options]
 */
export function createPortalRoomHandler({ registry, lobby, trustProxy = 'auto',
  mode = null, url = null, siteId = null, key = null, agentUrl = null, bridgeToken = null,
  now = Date.now, fetchImpl = fetch, log = { warn() {} } } = {}) {
  // 没写模式的旧配置按完整的 HMAC 三项判定（§47.3）：三项齐全就是 legacy-http，什么都没有就是 off。
  const resolved = mode ?? (url || siteId || key ? 'legacy-http' : 'off');
  if (!PORTAL_ROOM_MODES.includes(resolved))
    throw new RangeError('SP_PORTAL_ROOM_MODE must be off, legacy-http or agent');
  const enabled = resolved !== 'off';
  let endpoint = null, bridge = null;
  if (resolved === 'legacy-http') {
    if (!url || !siteId || !key || !/^[a-z0-9-]{1,40}$/.test(siteId) || !/^[a-f0-9]{64}$/.test(key))
      throw new Error('SP_PORTAL_URL / SP_PORTAL_SITE_ID / SP_PORTAL_ROOM_KEY configuration invalid');
    const base = new URL(url);
    if (base.username || base.password || base.search || base.hash ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))))
      throw new Error('SP_PORTAL_URL must use HTTPS (HTTP allowed on loopback only)');
    endpoint = new URL('/api/rooms/from-game', base);
  }
  if (resolved === 'agent') {
    if (!agentUrl || !bridgeToken) throw new Error('SP_PORTAL_AGENT_URL / SP_PORTAL_BRIDGE_TOKEN configuration invalid');
    bridge = new URL(PORTAL_ROOM_BRIDGE_PATH, new URL(agentUrl));
  }
  const allow = createStatusLimiter({ trustProxy, now });
  const global = new TokenBucket(0.2, 4, now());
  const submitted = new WeakMap();
  // 每间房「最近一次还没定论的申请」。**只有结果未知时才留着**：同 opId 同实例重发是同一件事（中央会回原
  // 结果，不延长有效期），而换一个新 opId 重发就是第二次申请。定了论（已收录 / 被拒）就删掉，下一次点击
  // 生成新 opId —— 这正是「新点击重发必须生成新 opId」。
  const attempts = new WeakMap();
  let active = 0, activeReads = 0;
  let availability = { at: 0, value: enabled, reason: enabled ? null : 'OFF' };
  let probing = false;

  function mark(unavailable, code) {
    if (!unavailable) { availability = { at: now(), value: true, reason: null }; return; }
    if (resolved !== 'agent') return;
    availability = { at: now(), value: false, reason: code };
  }

  // 「Agent 现在能不能连上」的短期缓存。探测打到 Agent 的根路径：任何 HTTP 回应（哪怕是 401/403）都证明
  // 那个进程在监听，而不需要桥接的那些凭据、也不产生一次中央往返。它不是「分享一定能成功」的证明 ——
  // 真正的结论只能来自一次真实提交，所以下面每次真实提交都会立刻修正这里的判断。
  async function probeAvailability() {
    if (resolved !== 'agent') return availability.value;
    if (now() - availability.at < AVAILABILITY_TTL_MS) return availability.value;
    if (probing) return availability.value;
    probing = true;
    availability = { at: now(), value: availability.value, reason: availability.reason };
    try {
      const response = await fetchImpl(new URL('/', new URL(agentUrl)), { method: 'GET', redirect: 'error',
        signal: AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS) });
      await response.body?.cancel();
      mark(false);
    } catch { mark(true, 'AGENT_UNREACHABLE'); }
    finally { probing = false; }
    return availability.value;
  }

  async function bridgeCall(path, { method = 'GET', body = null, timeoutMs = PORTAL_ROOM_QUERY_MS } = {}) {
    // 桥接基准路径不带结尾斜杠（lib/game-bridge.mjs 的 BRIDGE_BASE_PATH），所以「按 opId 查」那条子路径必须
    // 手工拼 —— `new URL(opId, base)` 会把最后一个路径段整个换掉。只带 query 时连斜杠都不加。
    const target = new URL(path ? `${bridge.href.replace(/\/$/, '')}${path.startsWith('?') ? '' : '/'}${path}` : bridge);
    const response = await fetchImpl(target, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${bridgeToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const payload = await response.json().catch(() => null);
    // 桥的每个回执都带 status（registered/pending/rejected/withdrawn/ended/absent），没有它就没法判读 ——
    // 拿一个不是桥在说的东西当结论，比直接说「这个回应我不认识」危险得多。
    if (!payload || typeof payload !== 'object' || typeof payload.status !== 'string')
      throw Object.assign(new Error('BRIDGE_INVALID_RESPONSE'), { code: 'INTERNAL_ERROR' });
    return payload;
  }

  return async (req, res) => {
    const reply = (status, data) => {
      // Rejected bodies must not hold a keep-alive connection open while they trickle in.
      if (status >= 400) res.setHeader('Connection', 'close');
      return sendJson(req, res, status, data);
    };
    const target = parseTarget(req);
    if (!target) return reply(400, { error: N_('请求无效') });

    // ─── 登记结果查询（§45.1）─────────────────────────────────────────────────────────────────────
    if (target.pathname === PORTAL_ROOM_STATUS_PATH) {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('Allow', 'GET, HEAD');
        return reply(405, { error: N_('请求方法无效') });
      }
      if (!sameOrigin(req)) return reply(403, { error: N_('不允许跨站提交') });
      if (!enabled) return reply(503, { error: N_('本站尚未配置联机站提交接口'), enabled: false });
      // legacy-http 的中央没有「按房间查登记结果」这个读接口，游戏这边无从回答。**不要**编一个「没登记」：
      // 老路径的界面本来就用旧的成功/失败语义，谎报一个状态只会让它把已收录的房间显示成未收录。
      if (resolved !== 'agent') return reply(501, { error: N_('本站不支持登记状态查询'), mode: resolved, enabled: true });
      if (activeReads >= 4) { res.setHeader('Retry-After', '5'); return reply(429, { error: N_('请稍后重试') }); }
      const token = /^Bearer ([a-f0-9]{32,64})$/.exec(req.headers.authorization || '')?.[1];
      const session = token ? registry.byToken(token) : null;
      if (!session?.connected) return reply(401, { error: N_('请重新连接后提交') });
      const room = lobby.roomOf(session);
      const code = String(target.query.get('code') || '').trim().toUpperCase();
      if (!room || room.hostId !== session.playerId) return reply(403, { error: N_('只有当前房主可以提交房间') });
      if (!/^[A-Z]{4}$/.test(code) || code !== room.code) return reply(409, { error: N_('房间状态已变化，请刷新后重试') });
      const attempt = attempts.get(room);
      // 房主刚打开页面时手里可能还没有 opId，所以按 code 查（桥那条路两种都能回答）。
      const query = attempt?.opId ? `${attempt.opId}?code=${room.code}` : `?code=${room.code}`;
      activeReads++;
      try {
        const payload = await bridgeCall(query);
        if (payload.status === 'registered') {
          mark(false);
          attempts.delete(room);
          const expiresAt = Number.isSafeInteger(payload.expiresAt) ? payload.expiresAt : null;
          return reply(200, { enabled: true, state: 'registered', registered: true, code: room.code,
            listingId: payload.listingId ?? null, roomId: payload.roomId ?? room.roomId,
            expiresAt, remainingMs: expiresAt === null ? null : Math.max(0, expiresAt - now()) });
        }
        if (payload.status === 'ended' || payload.status === 'absent') {
          mark(false);
          // 「查不到」是**确定没登记**：还留着的那个 opId 已经没有意义，下一次点击该是新申请。
          attempts.delete(room);
          return reply(200, { enabled: true, state: payload.status, registered: false, code: room.code });
        }
        // pending / rejected：结果还没定论。保留 opId 供下一次查询，界面继续显示待确认。
        mark(payload.status === 'pending' ? false : true, payload.code);
        return reply(200, { enabled: true, state: 'pending', registered: false, code: room.code,
          opId: payload.opId ?? attempt?.opId ?? null, reason: payload.code ?? null, retryable: payload.retryable === true });
      } catch (error) {
        mark(true, error.code ?? 'BRIDGE_UNREACHABLE');
        log.warn?.('[portal-room] 登记结果查询失败', error.message);
        return reply(503, { enabled: true, state: 'unknown', error: N_('联机站暂不可用，请稍后重试'), code: error.code ?? null });
      } finally { activeReads--; }
    }

    if (target.pathname !== PORTAL_ROOM_PATH) return reply(404, { error: N_('请求无效') });

    // ─── 公开的功能探测 ──────────────────────────────────────────────────────────────────────────
    if (req.method === 'GET' || req.method === 'HEAD') {
      const available = enabled ? await probeAvailability() : false;
      return reply(200, { enabled, mode: resolved, available,
        ...(resolved === 'agent' && !available && availability.reason ? { reason: availability.reason } : {}) });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, HEAD, POST');
      return reply(405, { error: N_('请求方法无效') });
    }

    // ─── 提交当前房间 ────────────────────────────────────────────────────────────────────────────
    if (!enabled) return reply(503, { error: N_('本站尚未配置联机站提交接口') });
    if (!allow(req)) return reply(429, { error: N_('提交过于频繁，请稍后重试') });
    if (!sameOrigin(req)) return reply(403, { error: N_('不允许跨站提交') });
    const token = /^Bearer ([a-f0-9]{32,64})$/.exec(req.headers.authorization || '')?.[1];
    const session = token ? registry.byToken(token) : null;
    if (!session?.connected) return reply(401, { error: N_('请重新连接后提交') });
    const room = lobby.roomOf(session);
    if (!room || room.hostId !== session.playerId) return reply(403, { error: N_('只有当前房主可以提交房间') });
    if (!lobby.getRoomStatus(room.code)?.joinable) return reply(409, { error: N_('仅可提交尚有空位的待机同盟') });
    if (active >= 4 || now() - (submitted.get(room) ?? -Infinity) < 60_000 || !global.take(now())) {
      res.setHeader('Retry-After', '60');
      return reply(429, { error: N_('请稍候再提交（同一房间间隔一分钟）') });
    }
    // Reserve before any await; failed attempts also consume cooldown to bound retry storms.
    submitted.set(room, now()); active++;
    try {
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
        return reply(415, { error: N_('请使用 JSON 请求') });
      const data = await readJsonBody(req, { maxBytes: 128, timeoutMs: 3000 });
      // Bind the click to the room on screen; a late request must not publish a newly joined room.
      if (data?.code !== room.code || lobby.roomOf(session) !== room || room.hostId !== session.playerId ||
        !session.connected || !lobby.getRoomStatus(room.code)?.joinable)
        return reply(409, { error: N_('房间状态已变化，请刷新后重试') });
      // 房间实例在**动手之前**绑定：晚回执要用它判断「这间房还是刚才那间吗」（§45.1）。
      const roomId = room.roomId;

      if (resolved === 'legacy-http') {
        const body = JSON.stringify({ code: room.code });
        const timestamp = String(now()), nonce = randomBytes(16).toString('hex');
        const signature = createHmac('sha256', key).update(`POST\n/api/rooms/from-game\n${siteId}\n${timestamp}\n${nonce}\n${body}`).digest('hex');
        const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error',
          signal: AbortSignal.timeout(PORTAL_ROOM_SHARE_MS), headers: { 'Content-Type': 'application/json',
            'X-Portal-Site': siteId, 'X-Portal-Timestamp': timestamp, 'X-Portal-Nonce': nonce, 'X-Portal-Signature': signature }, body });
        // No remote response content (or ownership token) reaches the browser; do not buffer it.
        await response.body?.cancel();
        if (!response.ok) return reply(response.status === 429 ? 429 : 502, { error: N_('联机站暂未收录，请稍后重试') });
        return reply(200, { ok: true, status: 'registered', registered: true, mode: resolved });
      }

      // agent：失败过的申请要能原样再问一次，所以 opId 只在「结果未知」时复用（见 attempts 的注释）。
      const previous = attempts.get(room);
      const opId = previous?.opId && now() - previous.at < PORTAL_ROOM_TTL_MS ? previous.opId : randomUUID();
      let payload;
      try {
        payload = await bridgeCall('', { method: 'POST', timeoutMs: PORTAL_ROOM_SHARE_MS,
          body: { code: room.code, roomId, opId, expiresInMs: PORTAL_ROOM_SHARE_MS } });
      } catch (error) {
        // 连桥都没走通：**不**报失败 —— agent 可能已经收到并转给了中央，只是回应没回来。留着 opId，
        // 让房主能在状态查询里问到真实结果；下一次点击会用同一个 opId 重放，而不是变成第二次申请。
        attempts.set(room, { opId, at: now(), state: 'pending' });
        mark(true, error.code ?? 'BRIDGE_UNREACHABLE');
        log.warn?.('[portal-room] 分享桥接失败', error.message);
        res.setHeader('Retry-After', '5');
        return reply(202, { ok: false, status: 'pending', registered: false, opId, code: error.code ?? null, retryable: true });
      }

      if (payload.status === 'registered') {
        mark(false);
        attempts.delete(room);
        const expiresAt = Number.isSafeInteger(payload.expiresAt) ? payload.expiresAt : null;
        // 晚回执（§45.1）：这中间房间可能已经换了一间、或者房主已经不在了。中央那边登记的是**旧实例**，
        // 所以不能把「A 房已收录」回给一个正在看 B 房的页面 —— 那会让它显示一个不属于当前房间的结果。
        if (lobby.roomOf(session) !== room || room.disposed || room.roomId !== roomId || !session.connected)
          return reply(409, { ok: false, status: 'stale', registered: false, opId, code: 'ROOM_CHANGED',
            error: N_('房间状态已变化，请刷新后重试'), listingId: payload.listingId ?? null, expiresAt });
        return reply(200, { ok: true, status: 'registered', registered: true, opId, mode: resolved,
          listingId: payload.listingId ?? null, roomId: payload.roomId ?? roomId, code: room.code,
          expiresAt, remainingMs: expiresAt === null ? null : Math.max(0, expiresAt - now()),
          owned: payload.owned === true, replayed: payload.replayed === true });
      }

      if (payload.status === 'pending') {
        mark(false);
        attempts.set(room, { opId, at: now(), state: 'pending' });
        // 「发出去了但不知道结果」：界面进待确认，之后用状态查询收尾。
        return reply(202, { ok: false, status: 'pending', registered: false, opId,
          code: payload.code ?? null, retryable: false });
      }

      // 确定被拒：留着的 opId 没有意义了（不同内容再用同一个 opId 会被中央判冲突）。
      attempts.delete(room);
      const [status, message] = SHARE_FAILURES[payload.code] ?? [502, N_('联机站连接失败，请稍后重试')];
      mark(UNAVAILABLE_CODES.has(payload.code), payload.code);
      return reply(status, { ok: false, status: 'rejected', registered: false, opId,
        code: payload.code ?? null, retryable: payload.retryable === true, error: message });
    } catch (error) {
      return reply(error.status || 502, { error: error.status ? N_('提交请求无效或超时') : N_('联机站连接失败，请稍后重试') });
    } finally { active--; }
  };
}
