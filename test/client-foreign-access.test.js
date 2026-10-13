import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Net } from '../public/js/net.js';

for (const delivery of ['error frame', 'close code']) test(`foreign refusal via ${delivery} shows the policy and never retries`, (t) => {
  const sockets = [], errors = [];
  class Socket {
    constructor() { this.readyState = 0; sockets.push(this); }
    send() {}
    close(code) { this.readyState = 3; this.onclose?.({ code }); }
  }
  const net = new Net({ WebSocket: Socket });
  t.after(() => net.close());
  net.on('helloError', error => errors.push(error));
  net.setName('Player');
  const ws = sockets[0]; ws.readyState = 1; ws.onopen();
  if (delivery === 'error frame') ws.onmessage({ data: JSON.stringify({ t: 'error', code: 'FOREIGN_CONNECTIONS_DISABLED', msg: '本服务器暂时仅对中国大陆服务' }) });
  else ws.onclose({ code: 4003 });
  assert.equal(net.status, 'closed');
  assert.equal(net.lastError.code, 'FOREIGN_CONNECTIONS_DISABLED');
  assert.equal(net.lastError.message, '本服务器暂时仅对中国大陆服务');
  assert.equal(errors.length, 1);
  assert.equal(net.retryAt, 0);
  assert.equal(net._reconnectTimer, null); assert.equal(net._pingTimer, null); assert.equal(net._helloTimer, null);
  net.retryNow(); net.reconnectNow(); net.setName('Again');
  assert.equal(sockets.length, 1);
});
