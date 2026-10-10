import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, mkdirSync, writeFileSync, symlinkSync, statSync, utimesSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
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

test('archive streams ended UTC days losslessly, retains today/future days, and reports bytes without private fields', async t => {
  const { dir, dispose } = temporary(t), now = Date.parse('2026-10-10T12:00:00Z');
  const body = (JSON.stringify({ ip: '203.0.113.1', name: '博士', text: ' 原文 😀 "换行"\n ' }) + '\n').repeat(20000);
  for (const day of ['08', '09', '10', '11']) writeFileSync(path.join(dir, `2026-10-${day}.jsonl`), body);
  const logger = new ChatLog({ dir, now: () => now }); dispose.push(() => logger.close());
  const stats = await logger.maintain();
  for (const day of ['08', '09']) {
    assert.equal(existsSync(path.join(dir, `2026-10-${day}.jsonl`)), false);
    assert.equal(gunzipSync(readFileSync(path.join(dir, `2026-10-${day}.jsonl.gz`))).toString(), body);
  }
  for (const day of ['10', '11']) assert.equal(readFileSync(path.join(dir, `2026-10-${day}.jsonl`), 'utf8'), body);
  assert.equal(stats.files, 4); assert.equal(stats.plainFiles, 2); assert.equal(stats.archiveFiles, 2);
  assert.equal(stats.plainBytes, Buffer.byteLength(body) * 2); assert.ok(stats.archiveBytes < stats.plainBytes / 5);
  assert.equal(stats.totalBytes, readdirSync(dir).reduce((sum, name) => sum + statSync(path.join(dir, name)).size, 0));
  assert.equal(stats.retentionDays, 0); assert.equal(stats.maintenanceFailures, 0);
  assert.ok(!JSON.stringify(stats).includes('203.0.113.1')); assert.ok(!JSON.stringify(stats).includes(dir));
  assert.deepEqual(await logger.maintain(), stats, 'a second sweep does not duplicate or recompress archives');
});

test('explicit retention keeps N UTC calendar days, removes expired plain/archived logs, and leaves unrelated paths alone', async t => {
  const { dir, dispose } = temporary(t), logs = path.join(dir, 'logs'), outside = path.join(dir, 'outside');
  mkdirSync(logs); mkdirSync(outside); writeFileSync(path.join(outside, 'keep'), 'outside');
  symlinkSync(outside, path.join(logs, '2026-10-01.jsonl'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const day of ['03', '04', '10', '11']) writeFileSync(path.join(logs, `2026-10-${day}.jsonl`), day);
  writeFileSync(path.join(logs, '2026-10-03.jsonl.gz'), gzipSync('03'));
  writeFileSync(path.join(logs, '2026-02-30.jsonl'), 'invalid date');
  writeFileSync(path.join(logs, 'notes.txt'), 'notes');
  const logger = new ChatLog({ dir: logs, retentionDays: 7, now: () => Date.parse('2026-10-10T23:59:59Z') });
  dispose.push(() => logger.close()); await logger.maintain();
  assert.equal(existsSync(path.join(logs, '2026-10-03.jsonl')), false);
  assert.equal(existsSync(path.join(logs, '2026-10-03.jsonl.gz')), false);
  assert.equal(gunzipSync(readFileSync(path.join(logs, '2026-10-04.jsonl.gz'))).toString(), '04');
  for (const day of ['10', '11']) assert.equal(readFileSync(path.join(logs, `2026-10-${day}.jsonl`), 'utf8'), day);
  assert.equal(readFileSync(path.join(logs, '2026-02-30.jsonl'), 'utf8'), 'invalid date');
  assert.equal(readFileSync(path.join(logs, 'notes.txt'), 'utf8'), 'notes');
  assert.equal(readFileSync(path.join(outside, 'keep'), 'utf8'), 'outside');
  assert.equal(logger.stats().files, 3);
});

test('compression and expiration can both be disabled; hourly sweeps honor a UTC day rollover', async t => {
  const { dir, dispose } = temporary(t);
  writeFileSync(path.join(dir, '2026-10-09.jsonl'), 'yesterday');
  writeFileSync(path.join(dir, '2026-10-10.jsonl'), 'today');
  const disabled = new ChatLog({ dir, compressAfterDays: 0, retentionDays: 0, now: () => Date.parse('2026-10-10T12:00Z') });
  dispose.push(() => disabled.close()); await disabled.maintain();
  assert.equal(disabled.stats().plainFiles, 2); assert.equal(disabled.stats().archiveFiles, 0);
  let now = Date.parse('2026-10-10T12:00Z');
  const logger = new ChatLog({ dir, retentionDays: 2, now: () => now }); dispose.push(() => logger.close());
  await logger.maintain(); assert.equal(logger.stats().archiveFiles, 1);
  now += 86400000; await logger.maintain();
  assert.equal(existsSync(path.join(dir, '2026-10-09.jsonl.gz')), false);
  assert.equal(gunzipSync(readFileSync(path.join(dir, '2026-10-10.jsonl.gz'))).toString(), 'today');
  assert.equal(logger.stats().files, 1);
});

test('interrupted publication recovers only identical bytes; conflicting/corrupt archives keep original files and report safe errors', async t => {
  const { dir, dispose } = temporary(t), errors = [], secret = '原始私有消息 203.0.113.1 博士';
  for (const day of ['07', '08', '09']) writeFileSync(path.join(dir, `2026-10-${day}.jsonl`), secret);
  writeFileSync(path.join(dir, '2026-10-07.jsonl.gz'), gzipSync(secret));
  writeFileSync(path.join(dir, '2026-10-08.jsonl.gz'), gzipSync('different'));
  writeFileSync(path.join(dir, '2026-10-09.jsonl.gz'), 'broken archive');
  const logger = new ChatLog({ dir, now: () => Date.parse('2026-10-10T12:00Z'), log: { error: value => errors.push(value) } });
  dispose.push(() => logger.close()); await logger.maintain();
  assert.equal(existsSync(path.join(dir, '2026-10-07.jsonl')), false);
  for (const day of ['08', '09']) assert.equal(readFileSync(path.join(dir, `2026-10-${day}.jsonl`), 'utf8'), secret);
  assert.equal(gunzipSync(readFileSync(path.join(dir, '2026-10-08.jsonl.gz'))).toString(), 'different');
  assert.equal(logger.stats().maintenanceFailures, 2); assert.equal(errors.length, 1);
  assert.ok(!errors[0].includes(secret)); assert.ok(!errors[0].includes(dir));
});

test('messages arriving during maintenance stay queued, shutdown waits for archival and every accepted append', async t => {
  const { dir, dispose } = temporary(t), body = 'old log\n'.repeat(200000), now = Date.parse('2026-10-10T12:00Z');
  writeFileSync(path.join(dir, '2026-10-09.jsonl'), body);
  const logger = new ChatLog({ dir, now: () => now }); dispose.push(() => logger.close());
  const maintenance = logger.maintain();
  const simultaneous = logger.maintain();
  assert.equal(logger.record({ at: now, ip: '127.0.0.1', playerId: 'p1', name: '博士', roomCode: 'ABCD', text: ' 维护时的新消息 😀 ' }), true);
  assert.equal(logger.pending, null, 'append cannot overlap archive publication');
  await logger.close(); await maintenance;
  assert.equal((await simultaneous).archiveFiles, 1, 'coalesced maintenance callers also receive the aggregate result');
  assert.equal(gunzipSync(readFileSync(path.join(dir, '2026-10-09.jsonl.gz'))).toString(), body);
  assert.equal(records(dir)[0].text, ' 维护时的新消息 😀 ');
  assert.equal(logger.stats().pendingRecords, 0); assert.equal(logger.stats().droppedRecords, 0);
  assert.equal(logger.stats().totalBytes, readdirSync(dir).reduce((sum, name) => sum + statSync(path.join(dir, name)).size, 0));
});

test('invalid retention/compression settings fail early; health exposes aggregate log usage without path or contents', async t => {
  const { dir, dispose } = temporary(t);
  for (const value of [-1, 1.5, 'bad', 36501]) {
    assert.throws(() => new ChatLog({ dir, compressAfterDays: value }), /SP_CHAT_LOG_COMPRESS_AFTER_DAYS/);
    assert.throws(() => new ChatLog({ dir, retentionDays: value }), /SP_CHAT_LOG_RETENTION_DAYS/);
  }
  const now = Date.now(), oldDay = new Date(now - 4 * 86400000).toISOString().slice(0, 10), secret = '私有原文 203.0.113.55';
  writeFileSync(path.join(dir, oldDay + '.jsonl'), secret);
  const server = await startServer({ port: 0, host: '127.0.0.1', quiet: true, workers: 0, stateFile: 'off',
    chatLogDir: dir, chatLogCompressAfterDays: 2, chatLogRetentionDays: 30 });
  dispose.push(() => server.close()); await server.chatLog.maintain();
  for (const route of ['/healthz', '/metrics']) {
    const data = await (await fetch(server.url + route)).json();
    assert.equal(data.chatLog.archiveFiles, 1); assert.equal(data.chatLog.plainFiles, 0);
    assert.equal(data.chatLog.retentionDays, 30); assert.equal(data.chatLog.compressAfterDays, 2);
    assert.ok(data.chatLog.totalBytes > 0); assert.ok(data.chatLog.lastMaintenanceAt);
    const serialized = JSON.stringify(data);
    assert.ok(!serialized.includes(secret)); assert.ok(!serialized.includes(dir));
  }
});

test('maintenance recycles only its own stale temporary archives and leaves recent work untouched', async t => {
  const { dir, dispose } = temporary(t), now = Date.parse('2026-10-10T12:00Z');
  const stale = '.chat-archive-00000000-0000-0000-0000-000000000001.tmp';
  const recent = '.chat-archive-00000000-0000-0000-0000-000000000002.tmp';
  for (const name of [stale, recent, '.unrelated.tmp']) writeFileSync(path.join(dir, name), 'temporary');
  utimesSync(path.join(dir, stale), new Date(now - 2 * 86400000), new Date(now - 2 * 86400000));
  utimesSync(path.join(dir, recent), new Date(now), new Date(now));
  const logger = new ChatLog({ dir, now: () => now }); dispose.push(() => logger.close());
  await logger.maintain();
  assert.equal(existsSync(path.join(dir, stale)), false);
  for (const name of [recent, '.unrelated.tmp']) assert.equal(readFileSync(path.join(dir, name), 'utf8'), 'temporary');
  assert.equal(logger.stats().temporaryFiles, 1); assert.equal(logger.stats().temporaryBytes, 9);
});

test('compression delay keeps the configured number of dates, and missing/blocked directories do not crash maintenance', async t => {
  const { dir, dispose } = temporary(t), now = Date.parse('2026-10-10T12:00Z'), logs = path.join(dir, 'logs');
  const errors = [], logger = new ChatLog({ dir: logs, compressAfterDays: 3, now: () => now, log: { error: value => errors.push(value) } });
  dispose.push(() => logger.close());
  await logger.maintain(); assert.equal(logger.stats().files, 0); assert.equal(existsSync(logs), false);
  writeFileSync(logs, 'blocked'); await logger.maintain();
  assert.equal(logger.stats().maintenanceFailures, 1); assert.equal(errors.length, 1); assert.ok(!errors[0].includes(logs));
  rmSync(logs); mkdirSync(logs);
  for (const day of ['07', '08', '09', '10']) writeFileSync(path.join(logs, `2026-10-${day}.jsonl`), day);
  await logger.maintain(); assert.equal(logger.stats().archiveFiles, 1); assert.equal(logger.stats().plainFiles, 3);
  assert.equal(gunzipSync(readFileSync(path.join(logs, '2026-10-07.jsonl.gz'))).toString(), '07');
});
