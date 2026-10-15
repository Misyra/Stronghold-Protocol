// 游戏环境的分享配置（docs/design/portal-agent-wss.md §45.3）。
//
// 这些校验的价值全在「启动时就说出来」：填错的模式、指向别的机器的本机地址、或者两个不一样的站点 ID，
// 如果拖到玩家点分享那一刻才炸，症状会变成「分享功能坏了」，而真相是配置里少了一个字符。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { announcementOptionsFrom, localAgentUrlFrom, portalRoomOptionsFrom, siteIdFrom } from '../server/http/config.js';

const KEY = 'a'.repeat(64);
const BRIDGE = 'b'.repeat(48);
const ADMIN = 'c'.repeat(48);

test('站点 ID：统一 SP_SITE_ID，旧别名只在一致时兼容', () => {
  assert.equal(siteIdFrom({}, {}), null);
  assert.equal(siteIdFrom({}, { SP_SITE_ID: 'hongkong' }), 'hongkong');
  assert.equal(siteIdFrom({}, { SP_PORTAL_SITE_ID: 'hongkong' }), 'hongkong');
  assert.equal(siteIdFrom({}, { SP_SITE_ID: 'hongkong', SP_PORTAL_SITE_ID: 'hongkong' }), 'hongkong');
  // 两个不一样的 ID 意味着「公告写到 A 站、房间登记到 B 站」，而且两边都不会报错 —— 只有拒绝启动能防住。
  assert.throws(() => siteIdFrom({}, { SP_SITE_ID: 'hongkong', SP_PORTAL_SITE_ID: 'shiyan' }), /SP_PORTAL_SITE_ID/);
  for (const bad of ['../other', 'HongKong', 'a'.repeat(41)])
    assert.throws(() => siteIdFrom({}, { SP_SITE_ID: bad }), RangeError, bad);
  assert.equal(siteIdFrom({}, { SP_SITE_ID: '' }), null);
  // 显式的程序配置优先，不与环境变量对账。
  assert.equal(siteIdFrom({ siteId: 'shiyan' }, { SP_SITE_ID: 'hongkong' }), 'shiyan');
  assert.equal(siteIdFrom({ announcementSiteId: 'shiyan' }, {}), 'shiyan');
});

test('公告的 panel 源也用同一个站点 ID（别名与冲突都走同一条判定）', () => {
  const env = { SP_ANNOUNCEMENT_SOURCE: 'panel', SP_PORTAL_URL: 'https://panel.example/', SP_PORTAL_SITE_ID: 'aliyun' };
  assert.equal(announcementOptionsFrom({}, env).announcementUrl, 'https://panel.example/api/announce/v1/aliyun');
  assert.throws(() => announcementOptionsFrom({}, { ...env, SP_SITE_ID: 'hongkong' }), /one site id/);
});

test('本机 Agent 地址：只要回环 HTTP 根路径', () => {
  assert.equal(localAgentUrlFrom('http://127.0.0.1:3900/'), 'http://127.0.0.1:3900/');
  assert.equal(localAgentUrlFrom('http://127.0.0.1:3900'), 'http://127.0.0.1:3900/');
  assert.equal(localAgentUrlFrom('http://localhost:3900/'), 'http://localhost:3900/');
  for (const bad of ['https://127.0.0.1:3900/', 'http://10.0.0.7:3900/', 'http://agent.example/',
    'http://user:pass@127.0.0.1:3900/', 'http://127.0.0.1:3900/api', 'http://127.0.0.1:3900/?x=1', 'not a url'])
    assert.throws(() => localAgentUrlFrom(bad), RangeError, bad);
});

test('分享模式：off / legacy-http / agent，以及旧配置的默认判定', () => {
  // 什么都没有就是 off；旧的 HMAC 三项齐全时不写模式也照旧走 legacy-http（升级不改行为）。
  assert.equal(portalRoomOptionsFrom({}, {}).mode, 'off');
  assert.equal(portalRoomOptionsFrom({}, { SP_PORTAL_URL: 'https://portal.example/', SP_SITE_ID: 'test', SP_PORTAL_ROOM_KEY: KEY }).mode, 'legacy-http');
  // 只配了公告（panel 源要的 SP_PORTAL_URL / SP_SITE_ID）不等于配了分享：不能因此拒绝启动。
  assert.equal(portalRoomOptionsFrom({}, { SP_PORTAL_URL: 'https://panel.example/', SP_SITE_ID: 'test' }).mode, 'off');
  assert.equal(portalRoomOptionsFrom({ announcementSiteId: 'new-domestic', announcementPortalUrl: 'https://panel.example/' }).mode, 'off');
  // 反过来，写了那个只为分享存在的旧别名却不给密钥：这是真的配错了，启动时就该说。
  assert.throws(() => portalRoomOptionsFrom({}, { SP_PORTAL_URL: 'https://portal.example/', SP_PORTAL_SITE_ID: 'test' }), /requires SP_PORTAL_URL/);
  // 显式关掉：不因为还留着旧的密钥就报「配置无效」。
  const off = portalRoomOptionsFrom({}, { SP_PORTAL_ROOM_MODE: 'off', SP_PORTAL_URL: 'https://portal.example/', SP_SITE_ID: 'test', SP_PORTAL_ROOM_KEY: KEY });
  assert.deepEqual(off, { mode: 'off', url: null, siteId: null, key: null, agentUrl: null, bridgeToken: null });
  assert.throws(() => portalRoomOptionsFrom({}, { SP_PORTAL_ROOM_MODE: 'agenth' }), /must be off, legacy-http or agent/);
  // legacy-http 的完整性：URL、站点 ID、64 位十六进制密钥，一个都不能少。
  for (const env of [{ SP_PORTAL_ROOM_MODE: 'legacy-http' },
    { SP_PORTAL_ROOM_MODE: 'legacy-http', SP_PORTAL_URL: 'https://portal.example/', SP_SITE_ID: 'test' },
    { SP_PORTAL_ROOM_MODE: 'legacy-http', SP_PORTAL_URL: 'https://portal.example/', SP_SITE_ID: 'test', SP_PORTAL_ROOM_KEY: 'short' },
    { SP_PORTAL_ROOM_MODE: 'legacy-http', SP_PORTAL_URL: 'http://portal.example/', SP_SITE_ID: 'test', SP_PORTAL_ROOM_KEY: KEY },
    { SP_PORTAL_ROOM_MODE: 'legacy-http', SP_PORTAL_URL: 'https://portal.example/?x=1', SP_SITE_ID: 'test', SP_PORTAL_ROOM_KEY: KEY }])
    assert.throws(() => portalRoomOptionsFrom({}, env), RangeError, JSON.stringify(env));
  const legacy = portalRoomOptionsFrom({}, { SP_PORTAL_URL: 'https://portal.example/', SP_SITE_ID: 'test', SP_PORTAL_ROOM_KEY: KEY });
  assert.equal(legacy.siteId, 'test');
  assert.equal(legacy.key, KEY);
  // 旧站只写 SP_PORTAL_SITE_ID 的部署照旧工作：站点 ID 走别名，分享这三项齐全就进 legacy-http。
  assert.equal(portalRoomOptionsFrom({}, { SP_PORTAL_URL: 'https://portal.example/', SP_PORTAL_SITE_ID: 'test', SP_PORTAL_ROOM_KEY: KEY }).siteId, 'test');
});

test('agent 模式：不需要中央地址，只需要本机地址与一把独立凭据', () => {
  const env = { SP_PORTAL_ROOM_MODE: 'agent', SP_SITE_ID: 'hongkong',
    SP_PORTAL_AGENT_URL: 'http://127.0.0.1:3900/', SP_PORTAL_BRIDGE_TOKEN: BRIDGE };
  const options = portalRoomOptionsFrom({}, env);
  assert.deepEqual(options, { mode: 'agent', url: null, siteId: 'hongkong', key: null,
    agentUrl: 'http://127.0.0.1:3900/', bridgeToken: BRIDGE });
  // agent 模式不要求也不使用旧的 HMAC 密钥：游戏不再持有能代表本站改写公告/配置的东西（§36.2）。
  assert.equal(portalRoomOptionsFrom({}, { ...env, SP_PORTAL_ROOM_KEY: 'not-even-hex' }).mode, 'agent');
  assert.throws(() => portalRoomOptionsFrom({}, { SP_PORTAL_ROOM_MODE: 'agent', SP_SITE_ID: 'hongkong' }), /requires SP_PORTAL_AGENT_URL/);
  assert.throws(() => portalRoomOptionsFrom({}, { ...env, SP_PORTAL_BRIDGE_TOKEN: 'short' }), /32\.\.256/);
  assert.throws(() => portalRoomOptionsFrom({}, { ...env, SP_PORTAL_AGENT_URL: 'http://10.0.0.7:3900/' }), /loopback/);
  // 桥接凭据必须与游戏自己的管理令牌分开：相同等于「拿到分享凭据就能关房、改配置」。
  assert.throws(() => portalRoomOptionsFrom({}, { ...env, SP_ROOM_ADMIN_TOKEN: BRIDGE }), /separate credentials/);
  assert.equal(portalRoomOptionsFrom({}, { ...env, SP_ROOM_ADMIN_TOKEN: ADMIN }).bridgeToken, BRIDGE);
});
