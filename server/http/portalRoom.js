import { createHmac, randomBytes } from 'node:crypto';
import { TokenBucket } from '../net.js';
import { createStatusLimiter } from '../roomStatus.js';
import { readJsonBody } from './readJson.js';
import { sendJson } from './common.js';
import { N_ } from '../../shared/i18n.js';

/** Opt-in server relay. Neither the destination nor room identity comes from the browser. */
export function createPortalRoomHandler({ registry, lobby, trustProxy = 'auto',
  url = process.env.SP_PORTAL_URL, siteId = process.env.SP_PORTAL_SITE_ID,
  key = process.env.SP_PORTAL_ROOM_KEY, now = Date.now, fetchImpl = fetch } = {}) {
  const enabled = !!(url && siteId && key);
  let endpoint;
  if (url || siteId || key) {
    if (!enabled || !/^[a-z0-9-]{1,40}$/.test(siteId) || !/^[a-f0-9]{64}$/.test(key))
      throw new Error('SP_PORTAL_URL / SP_PORTAL_SITE_ID / SP_PORTAL_ROOM_KEY configuration invalid');
    const base = new URL(url);
    if (base.username || base.password || base.search || base.hash ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))))
      throw new Error('SP_PORTAL_URL must use HTTPS (HTTP allowed on loopback only)');
    endpoint = new URL('/api/rooms/from-game', base);
  }
  const allow = createStatusLimiter({ trustProxy, now });
  const global = new TokenBucket(0.2, 4, now());
  const submitted = new WeakMap();
  let active = 0;
  return async (req, res) => {
    const reply = (status, data) => {
      // Rejected bodies must not hold a keep-alive connection open while they trickle in.
      if (status >= 400) res.setHeader('Connection', 'close');
      return sendJson(req, res, status, data);
    };
    if (req.method === 'GET' || req.method === 'HEAD') return reply(200, { enabled });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, HEAD, POST');
      return reply(405, { error: N_('请求方法无效') });
    }
    if (!enabled) return reply(503, { error: N_('本站尚未配置联机站提交接口') });
    if (!allow(req)) return reply(429, { error: N_('提交过于频繁，请稍后重试') });
    if (req.headers['sec-fetch-site'] === 'cross-site' ||
      (req.headers.origin && (() => { try { return new URL(req.headers.origin).host !== req.headers.host; } catch { return true; } })()))
      return reply(403, { error: N_('不允许跨站提交') });
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
      const body = JSON.stringify({ code: room.code });
      const timestamp = String(now()), nonce = randomBytes(16).toString('hex');
      const signature = createHmac('sha256', key).update(`POST\n/api/rooms/from-game\n${siteId}\n${timestamp}\n${nonce}\n${body}`).digest('hex');
      const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json',
          'X-Portal-Site': siteId, 'X-Portal-Timestamp': timestamp, 'X-Portal-Nonce': nonce, 'X-Portal-Signature': signature }, body });
      // No remote response content (or ownership token) reaches the browser; do not buffer it.
      await response.body?.cancel();
      if (!response.ok) return reply(response.status === 429 ? 429 : 502, { error: N_('联机站暂未收录，请稍后重试') });
      return reply(200, { ok: true });
    } catch (error) {
      return reply(error.status || 502, { error: error.status ? N_('提交请求无效或超时') : N_('联机站连接失败，请稍后重试') });
    } finally { active--; }
  };
}
