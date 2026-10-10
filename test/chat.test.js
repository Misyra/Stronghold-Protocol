import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskSensitiveText, hasSensitiveNickname } from '../server/moderation/nickname.js';
import { chatEnabled, moderateChat, CHAT_MUTE_MS, CHAT_WINDOW_MS } from '../server/moderation/chat.js';
import { Session, SessionRegistry } from '../server/net.js';
import { sessionDoc, snapshotServer, restoreServer } from '../server/persist.js';
import { Lobby } from '../server/lobby.js';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR } from '../shared/constants.js';
const abuse = Buffer.from('ZnVjaw==', 'base64').toString();
const newSession = () => new Session({ playerId: 'p_chat', token: '01234567890123456789012345678901', name: '博士', now: 0 });

test('mask only offending spans, with Unicode offsets, separators, overlapping matches and safe names', () => {
  for (const [input, output] of [[`你好😀 ${abuse} 队友`, '你好😀 **** 队友'], [abuse.toUpperCase(), '****'], ['ｆｕｃｋ', '****'], ['f.u.c.k', '*******'], ['fu\u0301ck', '*****'], [`${abuse} ${abuse}`, '**** ****'], ['Scunthorpe Assassin 189640', 'Scunthorpe Assassin 189640']]) {
    assert.equal(maskSensitiveText(input).text, output);
    assert.equal(maskSensitiveText(input).hit, hasSensitiveNickname(input));
  }
  assert.equal(maskSensitiveText(null).hit, false);
});

test('five hits within 10 minutes mute for 12 hours despite clean messages between them; retries do not extend the mute', () => {
  assert.equal(CHAT_WINDOW_MS, 10 * 60 * 1000);
  assert.equal(CHAT_MUTE_MS, 12 * 60 * 60 * 1000);
  const s = newSession(); let now = 1000;
  for (let i = 0; i < 4; i++, now += 1000) assert.equal(moderateChat(s, abuse, now).hit, true);
  assert.equal(moderateChat(s, '队友好', now).hit, false); now += 1000;
  assert.equal(s.chatStrikes, 4);
  now += 5 * 60 * 1000;
  assert.equal(moderateChat(s, abuse, now).text, '****');
  const until = now + CHAT_MUTE_MS;
  assert.equal(s.chatMutedUntil, until);
  assert.equal(moderateChat(s, '队友好', now).error, ERR.CHAT_MUTED);
  assert.equal(s.chatMutedUntil, until);
  assert.equal(moderateChat(s, '队友好', until).hit, false);
  assert.equal(s.chatMutedUntil, 0);
  assert.equal(s.chatHitTimes.length, 0);
});

test('ordinary game conversation neither masks text nor adds moderation strikes', () => {
  const s = newSession(); let now = 1000;
  for (const text of ['哥哥你好', '第一次玩卫戍', '土豆和苹果', '初音未来', '服务器没有问题', '逗比']) {
    assert.deepEqual(moderateChat(s, text, now), { text, hit: false });
    now += 1000;
  }
  assert.equal(s.chatStrikes, 0);
  assert.equal(s.chatMutedUntil, 0);
});

test('rolling window drops expired hits at the 10-minute boundary and counts one hit per message', () => {
  const s = newSession();
  assert.equal(moderateChat(s, `${abuse} ${abuse}`, 1000).hit, true);
  assert.equal(s.chatStrikes, 1);
  for (let i = 1; i <= 3; i++) moderateChat(s, abuse, 1000 + i * 60 * 1000);
  assert.equal(s.chatStrikes, 4);
  moderateChat(s, abuse, 1000 + CHAT_WINDOW_MS);
  assert.equal(s.chatMutedUntil, 0, 'the first hit has just expired');
  assert.equal(s.chatStrikes, 4);
  moderateChat(s, '队友好', 2000 + CHAT_WINDOW_MS);
  assert.equal(s.chatStrikes, 4, 'a clean message does not reset the window');
  moderateChat(s, abuse, 3000 + CHAT_WINDOW_MS);
  assert.equal(s.chatMutedUntil, 3000 + CHAT_WINDOW_MS + CHAT_MUTE_MS);
});

test('partial hit history survives checkpoints, reconnect expiry and eviction pressure', () => {
  let now = 1000;
  const registry = new SessionRegistry({ reconnectWindowMs: 100, maxSessions: 1, now: () => now });
  const s = registry.create('博士');
  for (let i = 0; i < 4; i++) { moderateChat(s, abuse, now); now += 1000; }
  const lobby = new Lobby({ registry, now: () => now });
  const doc = snapshotServer({ registry, lobby, now });
  now += 5 * 60 * 1000;
  assert.equal(registry.sweep().length, 0);
  assert.equal(registry.create('队友'), null);
  const restored = new SessionRegistry({ reconnectWindowMs: 100, now: () => now });
  const restoredLobby = new Lobby({ registry: restored, now: () => now });
  assert.equal(restoreServer({ doc, registry: restored, lobby: restoredLobby, now }).sessions, 1);
  const copy = restored.byToken(s.token);
  assert.deepEqual(copy.chatHitTimes, s.chatHitTimes);
  moderateChat(copy, '队友好', now); now += 1000;
  moderateChat(copy, abuse, now);
  assert.equal(copy.chatMutedUntil, now + CHAT_MUTE_MS);
  lobby.shutdown(); restoredLobby.shutdown();
});

test('length is Unicode characters, invalid and rapid messages neither count nor reset the hit history', () => {
  const s = newSession();
  assert.equal(moderateChat(s, '😀'.repeat(30), 1000).error, undefined);
  assert.equal(moderateChat(s, '😀'.repeat(31), 2000).error, ERR.BAD_MSG);
  assert.equal(moderateChat(s, abuse, 2000).hit, true);
  for (const value of ['', '  ', 'a\n', 'a\ud800']) assert.equal(moderateChat(s, value, 3000).error, ERR.BAD_MSG);
  assert.equal(moderateChat(s, '队友好', 2500).error, ERR.RATE);
  assert.equal(s.chatStrikes, 1);
});

test('mute survives persistence, disconnected-session expiry and registry pressure', () => {
  let now = 1000;
  const registry = new SessionRegistry({ reconnectWindowMs: 100, maxSessions: 1, now: () => now });
  const s = registry.create('博士'); s.chatMutedUntil = now + CHAT_MUTE_MS; s.chatStrikes = 0;
  const lobby = new Lobby({ registry, now: () => now });
  const doc = snapshotServer({ registry, lobby, now });
  now += 1000;
  assert.equal(registry.sweep().length, 0);
  assert.equal(registry.create('队友'), null);
  const restored = new SessionRegistry({ reconnectWindowMs: 100, now: () => now });
  const restoredLobby = new Lobby({ registry: restored, now: () => now });
  assert.equal(restoreServer({ doc, registry: restored, lobby: restoredLobby, now }).sessions, 1);
  assert.equal(restored.byToken(s.token).chatMutedUntil, s.chatMutedUntil);
  assert.equal(sessionDoc(restored.byToken(s.token), now).chatMutedUntil, s.chatMutedUntil);
  now = s.chatMutedUntil + 1; assert.equal(restored.sweep().length, 1);
  lobby.shutdown(); restoredLobby.shutdown();
});

test('environment defaults off, controls the real server welcome, and rejects misspellings', async () => {
  assert.equal(chatEnabled(''), false); assert.equal(chatEnabled('off'), false); assert.equal(chatEnabled('on'), true);
  assert.equal(chatEnabled(true), true); assert.throws(() => chatEnabled('onn'), /SP_CHAT_ENABLED/);
  const previous = process.env.SP_CHAT_ENABLED;
  try {
    for (const value of [undefined, 'off', 'on']) {
      if (value === undefined) delete process.env.SP_CHAT_ENABLED;
      else process.env.SP_CHAT_ENABLED = value;
      const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, stateFile: 'off' });
      let client;
      try {
        client = await TestClient.connect(server.url.replace('http:', 'ws:') + '/ws');
        const welcome = await client.hello('博士');
        assert.equal(welcome.chatEnabled, value === 'on', `SP_CHAT_ENABLED=${value ?? '(unset)'}`);
      } finally { await client?.close(); await server.close(); }
    }
  } finally {
    if (previous === undefined) delete process.env.SP_CHAT_ENABLED;
    else process.env.SP_CHAT_ENABLED = previous;
  }
});

async function setup(t, enabled = true) {
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, chatEnabled: enabled, MatchClass: StubMatch, workers: 0 });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map(c => c.close())); await server.close(); });
  const player = async name => {
    const c = await TestClient.connect(server.url.replace('http:', 'ws:') + '/ws'); clients.push(c);
    c.welcome = await c.hello(name); return c;
  };
  const a = await player('博士甲'), b = await player('博士乙'), outsider = await player('博士丙');
  assert.equal(a.welcome.chatEnabled, enabled);
  await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  const room = await a.waitFor('room.state');
  await b.request({ t: 'room.join', code: room.code }); await b.request({ t: 'room.ready', ready: true });
  assert.equal((await a.request({ t: 'room.start' })).t, 'ok');
  return { server, a, b, outsider, room, player };
}

test('real WebSocket: masked room-only broadcast, history resync, spectator refusal, strike mute and reconnect', async t => {
  const { server, a, b, outsider, room } = await setup(t);
  let now = Date.now(); server.lobby.now = () => now;
  const send = async text => { now += 1100; return a.request({ t: 'g.chat', text }); };
  assert.equal((await send(`你好 ${abuse}`)).t, 'ok');
  const msg = await b.waitFor('m.chat');
  assert.equal(msg.text, '你好 ****'); assert.equal(msg.playerId, a.welcome.playerId); assert.equal(msg.name, '博士甲');
  assert.equal(JSON.stringify(msg).includes(abuse), false);
  await outsider.expectNone('m.chat');
  assert.equal((await outsider.request({ t: 'g.chat', text: '队友好' })).code, ERR.NOT_IN_ROOM);
  assert.equal((await outsider.request({ t: 'room.spectate', code: room.code })).t, 'ok');
  assert.equal((await outsider.request({ t: 'g.chat', text: '队友好' })).code, ERR.SPECTATOR);
  for (let i = 0; i < 4; i++) {
    assert.equal((await send('队友好')).t, 'ok');
    assert.equal((await send(abuse)).t, 'ok');
  }
  const s = server.registry.byToken(a.welcome.token), until = s.chatMutedUntil;
  assert.equal(until, now + CHAT_MUTE_MS);
  assert.equal((await send('队友好')).code, ERR.CHAT_MUTED);
  await a.hello('博士甲', a.welcome.token);
  const state = await a.waitFor('m.chatState', m => m.mutedUntil === until && Array.isArray(m.messages));
  assert.equal(state.messages.length, 9);
  assert.ok(state.messages.every(m => !m.text.includes(abuse)));
  assert.equal((await a.request({ t: 'room.leave' })).t, 'ok');
  assert.equal(s.chatMutedUntil, until, 'leaving does not clear mute');
});

test('disabled server rejects a custom client chat intent', async t => {
  const { a, b } = await setup(t, false);
  assert.equal((await a.request({ t: 'g.chat', text: '队友好' })).code, ERR.CHAT_DISABLED);
  await b.expectNone('m.chat');
});
