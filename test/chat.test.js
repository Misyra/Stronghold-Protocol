import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { maskSensitiveText, hasSensitiveNickname } from '../server/moderation/nickname.js';
import { chatEnabled, moderateChat, CHAT_MUTE_LADDER, CHAT_MUTE_MAX_MS, CHAT_WINDOW_MS } from '../server/moderation/chat.js';
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

test('a flagged message is refused outright; first three violations warn before the relaxed mute ladder', () => {
  assert.deepEqual(CHAT_MUTE_LADDER, [0, 0, 0, 5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000]);
  assert.equal(CHAT_MUTE_MAX_MS, 6 * 60 * 60 * 1000);
  const s = newSession(); let now = 1000;
  // Each mute has to be served before the next violation can count.
  for (let i = 1; i <= 7; i++) {
    if (s.chatMutedUntil > now) now = s.chatMutedUntil;
    assert.deepEqual(moderateChat(s, abuse, now), { error: ERR.CHAT_BLOCKED }, `violation ${i}`);
    assert.equal(s.chatStrikes, i);
    const mute = CHAT_MUTE_LADDER[Math.min(i, CHAT_MUTE_LADDER.length) - 1];
    assert.equal(s.chatMutedUntil, mute ? now + mute : 0, `mute duration after violation ${i}`);
    now += 1000;
  }
});

test('the ladder restarts at a warning once 30 minutes pass without a violation; clean messages never reset it', () => {
  const s = newSession(); let now = 1000;
  assert.deepEqual(moderateChat(s, abuse, now), { error: ERR.CHAT_BLOCKED });
  assert.equal(s.chatStrikes, 1); assert.equal(s.chatMutedUntil, 0, 'the first violation is a warning only');
  now += 1000;
  assert.equal(moderateChat(s, '队友好', now).text, '队友好');
  assert.equal(s.chatStrikes, 1, 'a clean message does not reset the ladder');
  now += CHAT_WINDOW_MS - 2000;
  assert.deepEqual(moderateChat(s, abuse, now), { error: ERR.CHAT_BLOCKED }, 'just inside the window');
  assert.equal(s.chatStrikes, 2); assert.equal(s.chatMutedUntil, 0, 'second violation is still a warning');
  now += 1000;
  assert.deepEqual(moderateChat(s, abuse, now), { error: ERR.CHAT_BLOCKED }, 'third violation is still a warning');
  assert.equal(s.chatStrikes, 3); assert.equal(s.chatMutedUntil, 0);
  now += 1000;
  assert.deepEqual(moderateChat(s, abuse, now), { error: ERR.CHAT_BLOCKED }, 'fourth violation starts the first mute');
  assert.equal(s.chatStrikes, 4); assert.equal(s.chatMutedUntil, now + CHAT_MUTE_LADDER[3]);
  now = s.chatMutedUntil;
  assert.equal(moderateChat(s, '队友好', now).text, '队友好', 'the mute has just ended; the strikes live on');
  assert.equal(s.chatStrikes, 4);
  now += CHAT_WINDOW_MS;
  assert.deepEqual(moderateChat(s, abuse, now), { error: ERR.CHAT_BLOCKED });
  assert.equal(s.chatStrikes, 1, 'one quiet hour after the served mute restarts the ladder at a warning');
  assert.ok(s.chatMutedUntil <= now, 'the warning re-mutes nothing');
});

test('ordinary game conversation is sent unchanged and adds no moderation strikes', () => {
  const s = newSession(); let now = 1000;
  for (const text of ['哥哥你好', '第一次玩卫戍', '土豆和苹果', '初音未来', '服务器没有问题', '逗比']) {
    assert.deepEqual(moderateChat(s, text, now), { text });
    now += 1000;
  }
  assert.equal(s.chatStrikes, 0);
  assert.equal(s.chatMutedUntil, 0);
});

test('active violations and mutes survive checkpoints, reconnect expiry and eviction pressure', () => {
  let now = 1000;
  const registry = new SessionRegistry({ reconnectWindowMs: 100, maxSessions: 1, now: () => now });
  const s = registry.create('博士');
  for (let i = 0; i < 4; i++) { moderateChat(s, abuse, now); now += 1000; }
  assert.equal(s.chatMutedUntil, 4000 + CHAT_MUTE_LADDER[3], 'the fourth violation mutes for five minutes');
  const lobby = new Lobby({ registry, now: () => now });
  const doc = snapshotServer({ registry, lobby, now });
  now += 5 * 60 * 1000;
  assert.equal(registry.sweep().length, 0, 'the mute and the live strikes keep the session resumable');
  assert.equal(registry.create('队友'), null);
  const restored = new SessionRegistry({ reconnectWindowMs: 100, now: () => now });
  const restoredLobby = new Lobby({ registry: restored, now: () => now });
  assert.equal(restoreServer({ doc, registry: restored, lobby: restoredLobby, now }).sessions, 1);
  const copy = restored.byToken(s.token);
  assert.equal(copy.chatStrikes, s.chatStrikes);
  assert.equal(copy.chatLastHitAt, s.chatLastHitAt);
  assert.equal(copy.chatMutedUntil, s.chatMutedUntil);
  moderateChat(copy, '队友好', copy.chatMutedUntil); now = copy.chatMutedUntil + 1000;
  assert.deepEqual(moderateChat(copy, abuse, now), { error: ERR.CHAT_BLOCKED });
  assert.equal(copy.chatMutedUntil, now + CHAT_MUTE_LADDER[4], 'the restored strikes climb to the second mute');
  lobby.shutdown(); restoredLobby.shutdown();
});

test('documents of the old timestamp policy migrate their hit count and newest timestamp', () => {
  const registry = new SessionRegistry({ reconnectWindowMs: 1000, now: () => 60 * 60 * 1000 });
  const adopted = registry.adopt({ playerId: 'p_old', token: '01234567890123456789012345678901', name: '博士',
    disconnectedAt: 59 * 60 * 1000, connected: false,
    chatHitTimes: [57 * 60 * 1000, 58 * 60 * 1000, 59 * 60 * 1000], chatStrikes: 3, chatMutedUntil: 0 });
  assert.equal(adopted.chatStrikes, 3);
  assert.equal(adopted.chatLastHitAt, 59 * 60 * 1000);
  assert.deepEqual(moderateChat(adopted, Buffer.from('ZnVjaw==', 'base64').toString(), 60 * 60 * 1000), { error: ERR.CHAT_BLOCKED });
  assert.equal(adopted.chatStrikes, 4, 'migrated strikes keep climbing the same ladder');
  assert.equal(adopted.chatMutedUntil, 60 * 60 * 1000 + CHAT_MUTE_LADDER[3]);
});

test('length is Unicode characters; invalid and rapid messages neither count nor reset the violation ladder', () => {
  const s = newSession();
  assert.equal(moderateChat(s, '😀'.repeat(30), 1000).error, undefined);
  assert.equal(moderateChat(s, '😀'.repeat(31), 2000).error, ERR.BAD_MSG);
  assert.deepEqual(moderateChat(s, abuse, 2000), { error: ERR.CHAT_BLOCKED });
  for (const value of ['', '  ', 'a\n', 'a\ud800']) assert.equal(moderateChat(s, value, 3000).error, ERR.BAD_MSG);
  assert.equal(moderateChat(s, '队友好', 2500).error, ERR.RATE);
  assert.equal(s.chatStrikes, 1);
});

test('mute survives persistence, disconnected-session expiry and registry pressure', () => {
  let now = 1000;
  const registry = new SessionRegistry({ reconnectWindowMs: 100, maxSessions: 1, now: () => now });
  const s = registry.create('博士'); s.chatMutedUntil = now + CHAT_MUTE_MAX_MS; s.chatStrikes = 0;
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
  const chatLogDir = mkdtempSync(path.join(tmpdir(), 'sp-chat-test-'));
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, chatEnabled: enabled, chatLogDir, MatchClass: StubMatch, workers: 0 });
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(c => c.close())); await server.close();
    assert.equal(path.dirname(path.resolve(chatLogDir)), path.resolve(tmpdir()));
    assert.ok(path.basename(chatLogDir).startsWith('sp-chat-test-'));
    rmSync(chatLogDir, { recursive: true, force: true });
  });
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

test('real WebSocket: flagged messages are refused and never broadcast, spectator refusal, ladder mute and reconnect', async t => {
  const { server, a, b, outsider, room } = await setup(t);
  let now = Date.now(); server.lobby.now = () => now;
  const send = async (text, expected) => { now += 1100; return assert.equal((await a.request({ t: 'g.chat', text })).code ?? 'ok', expected); };
  await send(`你好 ${abuse}`, ERR.CHAT_BLOCKED);
  await b.expectNone('m.chat', () => true, 150); // a refused message never broadcasts
  await send('队友好', 'ok');
  const msg = await b.waitFor('m.chat');
  assert.equal(msg.text, '队友好'); assert.equal(msg.playerId, a.welcome.playerId); assert.equal(msg.name, '博士甲');
  assert.equal(JSON.stringify(msg).includes(abuse), false);
  await outsider.expectNone('m.chat');
  assert.equal((await outsider.request({ t: 'g.chat', text: '队友好' })).code, ERR.NOT_IN_ROOM);
  assert.equal((await outsider.request({ t: 'room.spectate', code: room.code })).t, 'ok');
  assert.equal((await outsider.request({ t: 'g.chat', text: '队友好' })).code, ERR.SPECTATOR);
  await send(abuse, ERR.CHAT_BLOCKED);
  const s = server.registry.byToken(a.welcome.token);
  assert.equal(s.chatStrikes, 2);
  await send(abuse, ERR.CHAT_BLOCKED); assert.equal(s.chatStrikes, 3);
  await send(abuse, ERR.CHAT_BLOCKED); assert.equal(s.chatStrikes, 4);
  assert.equal(s.chatMutedUntil, now + CHAT_MUTE_LADDER[3]);
  now = s.chatMutedUntil; await send(abuse, ERR.CHAT_BLOCKED); assert.equal(s.chatStrikes, 5);
  assert.equal(s.chatMutedUntil, now + CHAT_MUTE_LADDER[4]);
  now = s.chatMutedUntil; await send(abuse, ERR.CHAT_BLOCKED); assert.equal(s.chatStrikes, 6);
  assert.equal(s.chatMutedUntil, now + CHAT_MUTE_LADDER[5]);
  now = s.chatMutedUntil; await send(abuse, ERR.CHAT_BLOCKED); assert.equal(s.chatStrikes, 7);
  const until = s.chatMutedUntil;
  assert.equal(until, now + CHAT_MUTE_LADDER[6], 'the seventh and later violations cap at six hours');
  await send('队友好', ERR.CHAT_MUTED);
  await a.hello('博士甲', a.welcome.token);
  const state = await a.waitFor('m.chatState', m => m.mutedUntil === until && Array.isArray(m.messages));
  assert.equal(state.messages.length, 1, 'only the clean message made it into history');
  assert.ok(state.messages.every(m => !m.text.includes(abuse)));
  assert.equal((await a.request({ t: 'room.leave' })).t, 'ok');
  assert.equal(s.chatMutedUntil, until, 'leaving does not clear mute');
});

test('disabled server rejects a custom client chat intent', async t => {
  const { a, b } = await setup(t, false);
  assert.equal((await a.request({ t: 'g.chat', text: '队友好' })).code, ERR.CHAT_DISABLED);
  await b.expectNone('m.chat');
});
