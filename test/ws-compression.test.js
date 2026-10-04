import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { startServer, WS_MAX_PAYLOAD } from '../server/index.js';
import { sendRaw } from '../server/net.js';
import { TestClient } from './helpers/wsClient.js';

async function connect(t, serverOptions = {}, wsOptions = {}) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, ...serverOptions });
  t.after(() => srv.close());
  const connection = once(srv.wss, 'connection');
  const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`, { wsOptions });
  t.after(() => client.close());
  const [socket] = await connection;
  return { srv, client, socket };
}

test('default compression reduces large JSON frames, skips small frames and preserves gameplay messages', async (t) => {
  const saved = process.env.SP_WS_COMPRESSION;
  delete process.env.SP_WS_COMPRESSION;
  t.after(() => { if (saved == null) delete process.env.SP_WS_COMPRESSION; else process.env.SP_WS_COMPRESSION = saved; });
  const { client, socket } = await connect(t);
  assert.equal(client.ws.extensions, 'permessage-deflate');
  assert.equal(socket.extensions, 'permessage-deflate');

  for (const text of ['small', 'repeated public state '.repeat(500)]) {
    const msg = { t: 'm.ticker', text };
    const data = JSON.stringify(msg);
    const before = socket._socket.bytesWritten;
    assert.equal(sendRaw(socket, data), true);
    assert.deepEqual(await client.waitFor('m.ticker'), msg);
    const sentBytes = socket._socket.bytesWritten - before;
    const rawBytes = Buffer.byteLength(data);
    if (text === 'small') assert.equal(sentBytes, rawBytes + 2, 'small frame stays uncompressed');
    else assert.ok(sentBytes < rawBytes / 3, 'large frame is compressed on the wire');
  }

  const welcome = await client.hello('压缩测试');
  assert.ok(welcome.token);
  assert.equal((await client.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' })).t, 'ok');
  const room = await client.waitFor('room.state');
  assert.equal(room.seats[0].name, '压缩测试');
});

test('environment switch and explicit override enable or disable negotiation', async (t) => {
  const saved = process.env.SP_WS_COMPRESSION;
  t.after(() => { if (saved == null) delete process.env.SP_WS_COMPRESSION; else process.env.SP_WS_COMPRESSION = saved; });
  for (const { env, options, enabled } of [
    { env: 'off', options: {}, enabled: false },
    { env: 'on', options: {}, enabled: true },
    { env: 'off', options: { wsCompression: true }, enabled: true },
    { env: 'on', options: { wsCompression: false }, enabled: false },
  ]) {
    await t.test(`${env}, override ${options.wsCompression ?? 'unset'}`, async (t) => {
      process.env.SP_WS_COMPRESSION = env;
      const { client } = await connect(t, options);
      assert.equal(client.ws.extensions, enabled ? 'permessage-deflate' : '');
      assert.ok((await client.hello('开关测试')).playerId);
    });
  }
  process.env.SP_WS_COMPRESSION = 'unexpected';
  await assert.rejects(startServer({ port: 0, quiet: true }), /invalid SP_WS_COMPRESSION/);
});

test('clients without compression support still create and resume a room', async (t) => {
  const { srv, client } = await connect(t, { wsCompression: true }, { perMessageDeflate: false });
  assert.equal(client.ws.extensions, '');
  const welcome = await client.hello('不压缩客户端');
  await client.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
  const room = await client.waitFor('room.state');
  await client.close();
  const resumed = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`, { wsOptions: { perMessageDeflate: false } });
  t.after(() => resumed.close());
  const nextWelcome = await resumed.hello('不压缩客户端', welcome.token);
  assert.equal(nextWelcome.playerId, welcome.playerId);
  assert.equal((await resumed.waitFor('room.state')).code, room.code);
});

test('compressed inbound messages still obey the decompressed payload limit', async (t) => {
  const { client } = await connect(t, { wsCompression: true });
  assert.equal(client.ws.extensions, 'permessage-deflate');
  const pong = await client.request({ t: 'ping', c: 12345, padding: 'x'.repeat(WS_MAX_PAYLOAD / 2) });
  assert.equal(pong.t, 'pong', 'valid compressed inbound frame is decoded and handled');
  assert.equal(pong.c, 12345);
  client.ws.send(JSON.stringify({ t: 'ping', c: 12345, rid: 2, padding: 'x'.repeat(WS_MAX_PAYLOAD) }));
  const closed = await client.closed;
  assert.equal(closed.code, 1009);
});
