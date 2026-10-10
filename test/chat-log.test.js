import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatLog } from '../server/chatLog.js';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { ERR } from '../shared/constants.js';
import { TestClient } from './helpers/wsClient.js';

function temporary(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sp-chat-log-')), dispose = [];
  t.after(async () => {
    try { for (const close of dispose.reverse()) await close(); } finally {
      assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir()));
      assert.ok(path.basename(dir).startsWith('sp-chat-log-'));
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return { dir, dispose };
}

function records(dir) {
  return readdirSync(dir).filter(file => file.endsWith('.jsonl')).sort()
    .flatMap(file => readFileSync(path.join(dir, file), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line)));
}

test('local chat log preserves original Unicode and quoting, appends across restarts and rotates by UTC day', async t => {
  const { dir, dispose } = temporary(t), logDir = path.join(dir, 'logs');
  const logger = new ChatLog({ dir: logDir }); dispose.push(() => logger.close());
  const base = { at: Date.parse('2026-10-10T23:59:59Z'), ip: '2001:db8::1234', playerId: 'p_one', name: '哥哥', roomCode: 'ABCD', text: '  逗比 "😀"\n换行  ' };
  assert.equal(existsSync(logDir), false, 'no directory before the first message');
  for (let i = 0; i < 205; i++) logger.record({ ...base, playerId: `p_${i}` });
  logger.record({ ...base, at: base.at + 1000, text: '新的一天' });
  await logger.close();
  assert.deepEqual(readdirSync(logDir).sort(), ['2026-10-10.jsonl', '2026-10-11.jsonl']);
  const rows = records(logDir);
  assert.equal(rows.length, 206);
  assert.deepEqual(rows[0], { ...base, at: '2026-10-10T23:59:59.000Z', playerId: 'p_0' });
  assert.equal(rows[204].playerId, 'p_204', 'serialized batches preserve message order');
  const next = new ChatLog({ dir: logDir }); dispose.push(() => next.close());
  next.record({ ...base, text: '重启后' }); await next.close();
  assert.equal(records(logDir).length, 207, 'restart appends rather than overwriting');
});

test('write failures are reported without leaking message or identity; a later write can recover', async t => {
  const { dir, dispose } = temporary(t), logDir = path.join(dir, 'blocked');
  writeFileSync(logDir, 'not a directory');
  const errors = [];
  const logger = new ChatLog({ dir: logDir, log: { error: text => errors.push(text) } }); dispose.push(() => logger.close());
  const record = { at: Date.now(), ip: '203.0.113.7', playerId: 'p_private', name: '私有昵称', roomCode: 'ABCD', text: '私有原始消息' };
  logger.record(record); await logger.flush();
  assert.equal(logger.failed, 1); assert.equal(errors.length, 1);
  for (const value of [record.ip, record.name, record.text]) assert.ok(!errors[0].includes(value));
  rmSync(logDir); mkdirSync(logDir);
  logger.record(record); await logger.close();
  assert.equal(records(logDir)[0].text, record.text);
});

test('chat log configuration refuses public directories, including directory links', async t => {
  const { dir } = temporary(t), publicDir = path.join(dir, 'public'), alias = path.join(dir, 'alias');
  mkdirSync(publicDir);
  symlinkSync(publicDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const logDir of [publicDir, path.join(publicDir, 'logs'), path.join(alias, 'logs')]) {
    assert.throws(() => new ChatLog({ dir: logDir, publicDirs: [publicDir] }), /SP_CHAT_LOG_DIR/);
  }
  for (const served of ['public', 'data', 'shared', 'packs']) {
    await assert.rejects(startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, chatLogDir: path.resolve(served, 'chat-logs') }), /SP_CHAT_LOG_DIR/);
  }
});

test('real chat logs server-confirmed IP and nickname with original text, while broadcasts and resync stay masked', async t => {
  const { dir, dispose } = temporary(t), logDir = path.join(dir, 'logs');
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, stateFile: 'off',
    MatchClass: StubMatch, chatEnabled: true, chatLogDir: logDir, trustProxy: true });
  dispose.push(() => server.close());
  const connect = async (name, ip) => {
    const client = await TestClient.connect(server.url.replace('http:', 'ws:') + '/ws', { wsOptions: { headers: { 'x-real-ip': ip } } });
    dispose.push(() => client.close()); client.welcome = await client.hello(name); return client;
  };
  const a = await connect('博士甲', '203.0.113.19'), b = await connect('博士乙', '2001:db8::1234');
  await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' }); const room = await a.waitFor('room.state');
  await b.request({ t: 'room.join', code: room.code }); await b.request({ t: 'room.ready', ready: true });
  await a.request({ t: 'room.start' });
  let now = Date.parse('2026-10-10T10:00:00Z'); server.lobby.now = () => now;
  const abuse = Buffer.from('ZnVjaw==', 'base64').toString(), original = ` 你好 "${abuse}" 😀 `;
  assert.equal((await a.request({ t: 'g.chat', text: original, ip: 'spoofed', name: '冒名', playerId: 'spoofed', token: 'secret' })).t, 'ok');
  const broadcast = await b.waitFor('m.chat');
  assert.equal(broadcast.text, '你好 "****" 😀'); assert.equal(broadcast.name, '博士甲');
  assert.ok(!JSON.stringify(broadcast).includes(abuse)); assert.equal(broadcast.ip, undefined);
  assert.equal((await b.request({ t: 'g.chat', text: '逗比' })).t, 'ok');
  assert.equal((await a.request({ t: 'g.chat', text: '😀'.repeat(31) })).code, ERR.BAD_MSG);
  assert.equal((await a.request({ t: 'g.chat', text: '频繁发送' })).code, ERR.RATE);
  for (let i = 0; i < 4; i++) { now += 1100; assert.equal((await a.request({ t: 'g.chat', text: abuse })).t, 'ok'); }
  now += 1100;
  assert.equal((await a.request({ t: 'g.chat', text: '禁言期间的拒绝消息' })).code, ERR.CHAT_MUTED);
  await a.request({ t: 'state.resync' });
  const history = await a.waitFor('m.chatState', msg => msg.messages?.length === 6);
  assert.ok(!JSON.stringify(history).includes(abuse)); assert.ok(history.messages.every(msg => msg.ip === undefined));
  await server.chatLog.flush();
  const rows = records(logDir);
  assert.equal(rows.length, 6, 'only accepted messages, including the fifth hit, are logged once');
  assert.deepEqual(rows[0], { at: '2026-10-10T10:00:00.000Z', ip: '203.0.113.19', playerId: a.welcome.playerId, name: '博士甲', roomCode: room.code, text: original });
  assert.equal(rows[1].ip, '2001:db8::1234'); assert.equal(rows[1].name, '博士乙'); assert.equal(rows[1].text, '逗比');
  assert.equal(rows.at(-1).text, abuse);
  assert.ok(rows.every(row => !Object.hasOwn(row, 'token')));
  for (const url of ['/.state/chat-logs/2026-10-10.jsonl', '/chat-logs/2026-10-10.jsonl', '/api/chat-logs']) {
    const response = await fetch(server.url + url);
    assert.equal(response.status, 404); assert.ok(!(await response.text()).includes(original));
  }
  now = server.registry.byToken(b.welcome.token).chatLastSentAt + 1100;
  await b.request({ t: 'g.chat', text: '退出前' });
  await server.close();
  assert.equal(records(logDir).length, 7, 'server close flushes the final append');
});

test('direct clients cannot forge proxy IPs when trust is off; disabled chat creates no log files', async t => {
  const { dir, dispose } = temporary(t);
  for (const enabled of [true, false]) {
    const logDir = path.join(dir, String(enabled));
    const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, stateFile: 'off',
      MatchClass: StubMatch, chatEnabled: enabled, chatLogDir: logDir, trustProxy: false });
    dispose.push(() => server.close());
    const client = await TestClient.connect(server.url.replace('http:', 'ws:') + '/ws', { wsOptions: { headers: { 'x-real-ip': '203.0.113.5' } } });
    dispose.push(() => client.close()); await client.hello('博士');
    await client.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' }); await client.request({ t: 'room.start' });
    const response = await client.request({ t: 'g.chat', text: '你好' });
    await server.close();
    if (enabled) {
      assert.equal(response.t, 'ok'); assert.equal(records(logDir)[0].ip, '127.0.0.1');
    } else {
      assert.equal(response.code, ERR.CHAT_DISABLED); assert.equal(existsSync(logDir), false);
    }
  }
});
