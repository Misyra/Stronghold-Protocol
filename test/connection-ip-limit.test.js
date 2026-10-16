import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import WebSocket from 'ws';
import { Network, SessionRegistry } from '../server/net.js';
import { netOptionsFrom } from '../server/http/config.js';
import { attachWebSocket } from '../server/http/websocket.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const req = (ip) => ({ socket: { remoteAddress: ip }, headers: {} });
function network(t, options = {}) {
  const net = new Network({ registry: new SessionRegistry(), handler: {}, log: quiet,
    options: { maxConnectionsPerIp: 1, ...options } });
  t.after(() => net.close());
  return net;
}
function socket(net, ip) {
  const ws = new EventEmitter();
  ws.readyState = 1; ws.bufferedAmount = 0;
  ws.close = ws.terminate = () => { ws.readyState = 3; ws.emit('close'); };
  net.handleConnection(ws, req(ip));
  return ws;
}

test('exact-IP limits include public, loopback, LAN and equivalent IPv4/IPv6 spellings', async (t) => {
  for (const [first, same, other] of [
    ['203.0.113.8', '::ffff:203.0.113.8', '203.0.113.9'],
    ['127.0.0.1', '::ffff:127.0.0.1', '127.0.0.2'],
    ['192.168.1.8', '192.168.1.8', '192.168.1.9'],
    ['2001:db8:a:b::1', '2001:0db8:000a:000b:0:0:0:1', '2001:db8:a:b::2'],
  ]) await t.test(first, (t) => {
    const net = network(t);
    assert.equal(net.admission(req(first)), null);
    const ws = socket(net, first);
    assert.equal(net.admission(req(same)), 'per-address');
    assert.equal(net.admission(req(other)), null, 'distinct IPs in one IPv6 /64 have independent slots');
    ws.close(); ws.emit('close');
    assert.equal(net.admission(req(same)), null);
    assert.equal(net.connsPerIp.size, 0, 'duplicate close events do not leak or double-release slots');
  });
});

test('IP cap config validates environment values and explicit options take precedence', () => {
  assert.equal(netOptionsFrom({}, { SP_MAX_CONNECTIONS_PER_IP: '1' }).maxConnectionsPerIp, 1);
  assert.equal(netOptionsFrom({ maxConnectionsPerIp: 2 }, { SP_MAX_CONNECTIONS_PER_IP: '1' }).maxConnectionsPerIp, 2);
  assert.equal(netOptionsFrom({}, { SP_MAX_CONNECTIONS_PER_IP: '0' }).maxConnectionsPerIp, 0);
  for (const value of ['-1', '1.5', 'invalid']) assert.throws(() => netOptionsFrom({}, { SP_MAX_CONNECTIONS_PER_IP: value }), RangeError);
});

test('trusted proxy IPs are capped before upgrade and a closed connection releases the slot', async (t) => {
  const net = network(t, { trustProxy: true });
  const server = http.createServer();
  const wss = attachWebSocket(server, { network: net, log: quiet });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const peers = [];
  t.after(async () => {
    for (const ws of peers) ws.terminate();
    net.close(); wss.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const open = async (ip) => {
    const ws = new WebSocket(url, { headers: { 'X-Real-IP': ip } });
    peers.push(ws); await once(ws, 'open'); return ws;
  };
  const first = await open('203.0.113.8');
  const refused = new WebSocket(url, { headers: { 'X-Real-IP': '203.0.113.8' } });
  refused.on('error', () => {});
  const status = await new Promise((resolve) => refused.on('unexpected-response', (_, response) => {
    response.resume(); resolve(response.statusCode); refused.terminate();
  }));
  assert.equal(status, 429);
  await open('203.0.113.9');
  const closed = once(first, 'close'); first.close(); await closed;
  await new Promise((resolve) => setImmediate(resolve));
  await open('203.0.113.8');
  assert.equal(net.connectionCount, 2);
});
