import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskSensitiveText, hasSensitiveNickname } from '../server/moderation/nickname.js';
import { chatEnabled, moderateChat, CHAT_MUTE_MS } from '../server/moderation/chat.js';
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

test('consecutive hits reset on clean messages; fifth hit mutes exactly 12 hours without extending on retries', () => {
  const s = newSession(); let now = 1000;
  for (let i = 0; i < 4; i++, now += 1000) assert.equal(moderateChat(s, abuse, now).hit, true);
  assert.equal(moderateChat(s, '队友好', now).hit, false); now += 1000;
  assert.equal(s.chatStrikes, 0);
  for (let i = 0; i < 5; i++, now += 1000) assert.equal(moderateChat(s, abuse, now).text, '****');
  const until = now - 1000 + CHAT_MUTE_MS;
  assert.equal(s.chatMutedUntil, until);
  assert.equal(moderateChat(s, '队友好', now).error, ERR.CHAT_MUTED);
  assert.equal(s.chatMutedUntil, until);
  assert.equal(moderateChat(s, '队友好', until).hit, false);
  assert.equal(s.chatMutedUntil, 0);
});

test('length is Unicode characters, invalid and rapid messages neither count nor reset the streak', () => {
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

test('environment defaults off and rejects misspellings', () => {
  assert.equal(chatEnabled(''), false); assert.equal(chatEnabled('off'), false); assert.equal(chatEnabled('on'), true);
  assert.equal(chatEnabled(true), true); assert.throws(() => chatEnabled('onn'), /SP_CHAT_ENABLED/);
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
  for (let i = 0; i < 4; i++) assert.equal((await send(abuse)).t, 'ok');
  const s = server.registry.byToken(a.welcome.token), until = s.chatMutedUntil;
  assert.equal(until, now + CHAT_MUTE_MS);
  assert.equal((await send('队友好')).code, ERR.CHAT_MUTED);
  await a.hello('博士甲', a.welcome.token);
  const state = await a.waitFor('m.chatState', m => m.mutedUntil === until && Array.isArray(m.messages));
  assert.equal(state.messages.length, 5);
  assert.ok(state.messages.every(m => !m.text.includes(abuse)));
  assert.equal((await a.request({ t: 'room.leave' })).t, 'ok');
  assert.equal(s.chatMutedUntil, until, 'leaving does not clear mute');
});

test('disabled server rejects a custom client chat intent', async t => {
  const { a, b } = await setup(t, false);
  assert.equal((await a.request({ t: 'g.chat', text: '队友好' })).code, ERR.CHAT_DISABLED);
  await b.expectNone('m.chat');
});
