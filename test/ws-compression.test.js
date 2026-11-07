// WebSocket permessage-deflate with the per-type allowlist (server/wsCompression.js, DESIGN §37.138): SP_WS_COMPRESSION=on
// negotiates a shared 32 KiB server context (browsers offer no parameters) and only allowlisted frames — the state
// frames and the battle stream — enter it, chosen by the message's `t` at the send paths (net.js sendRaw / send).
// welcome (credentials), error/ok/pong and unknown types go out plain even when they are large; a client that offers
// server_no_context_takeover gets its frames compressed per message (degrade as asked); an offer that caps the server
// window below the full 15 bits gets no compression at all (narrowDeflateOffer drops the header).
// Frame sizes come from a raw client that parses the frames itself (test/helpers/wsRawClient.js): a socket byte counter
// merges frames that TCP coalesces, so it cannot answer "how big was that frame".
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { attachWebSocket, narrowDeflateOffer, WS_DEFLATE, WS_DEFLATE_SERVER_WINDOW_BITS } from '../server/http/websocket.js';
import { resolveWsCompression, isCompressibleType } from '../server/wsCompression.js';
import { send, sendRaw } from '../server/net.js';
import { startServer } from '../server/index.js';
import { rawClient } from './helpers/wsRawClient.js';

const BIG_PUBLIC = JSON.stringify({ t: 'm.public', players: Array.from({ length: 200 }, (_, i) => ({ playerId: `p_${i % 4}`, name: '阿米娅', lp: 30, phase: 'PREP' })) });
const BIG_WELCOME = JSON.stringify({ t: 'welcome', playerId: 'p_0', token: 'secret-credential-'.repeat(180), name: '博士', serverNow: 1 });
const SMALL_PONG = JSON.stringify({ t: 'pong', at: 12345 });

/** A bare http server whose /ws hands the socket to the test (a stand-in for net.js Network). */
async function fakeServer(opts = {}) {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const peers = [];
  const network = { admission: () => null, handleConnection: (ws) => { peers.push(ws); } };
  const wss = attachWebSocket(server, { network, log: { error() {} }, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    get peer() { return peers[peers.length - 1]; },
    peers,
    close: () => new Promise((r) => { wss.close(); server.close(() => r()); }),
  };
}

/** Connect, run `steps(peer)` (pushing frames), collect `n` frames and close. */
async function collect(srv, steps, n, opts = {}) {
  const before = srv.peers.length;
  const client = await rawClient({ port: srv.port, ...opts });
  try {
    // the client's handshake answer can arrive before the server's 'connection' event: wait for this socket, not the
    // previous one (a second exchange would otherwise send into a closed socket)
    while (srv.peers.length <= before) await new Promise((r) => setTimeout(r, 5));
    const peer = srv.peers[before];
    steps(peer);
    const frames = [];
    for (let i = 0; i < n; i++) frames.push(await client.next());
    return { response: client.response, frames };
  } finally { client.close(); }
}

/** How much the second copy of a frame costs relative to the first: below 1 when the window is reused. */
const repeatRatio = (frames) => frames[1].bytes / frames[0].bytes;

describe('wsCompression.js', () => {
  test('allowlist: state and battle frames yes; welcome/error/ok/pong/unknown no', () => {
    for (const t of ['m.public', 'm.private', 'm.state', 'm.unitStats', 'm.field', 'm.damage', 'b.damage', 'b.start', 'b.snap', 'b.ev', 'b.ext']) {
      assert.equal(isCompressibleType(t), true, t);
    }
    for (const t of ['welcome', 'error', 'ok', 'pong', 'ping', 'hello', 'room.state', 'room.loadout', 'm.result', 'm.toast', 'm.ticker', 'p2p.config', '', 'M.PUBLIC', null, undefined, 42, {}]) {
      assert.equal(isCompressibleType(t), false, String(t));
    }
  });

  test('resolveWsCompression: on → preset, off → false, anything else throws', () => {
    const on = resolveWsCompression('on');
    assert.equal(on.threshold, 0);
    assert.equal(on.clientNoContextTakeover, true);
    assert.equal(on.concurrencyLimit, 8);
    assert.deepEqual(on.zlibDeflateOptions, { level: 6, memLevel: 5 });
    // the preset must not pin the server window: pinning 15 makes ws refuse smaller-window offers with HTTP 400
    assert.equal('serverMaxWindowBits' in on, false);
    assert.equal('serverNoContextTakeover' in on, false);
    assert.equal(resolveWsCompression('off'), false);
    for (const bad of ['yes', '1', 'ON', '', null, undefined, true, 0]) {
      assert.throws(() => resolveWsCompression(bad), TypeError);
    }
    assert.equal(WS_DEFLATE, resolveWsCompression('on'), 'websocket.js exports the on-preset');
  });
});

describe('WebSocket permessage-deflate (allowlist preset)', () => {
  let srv;
  before(async () => { srv = await fakeServer(); });
  after(async () => { await srv.close(); });

  test('negotiated with the shared context: client_no_context_takeover advertised, no server window pin', async () => {
    const { response, frames } = await collect(srv, (peer) => { send(peer, JSON.parse(BIG_PUBLIC)); send(peer, JSON.parse(SMALL_PONG)); }, 2);
    assert.match(response, /sec-websocket-extensions: permessage-deflate/i);
    assert.match(response, /client_no_context_takeover/);
    assert.doesNotMatch(response, /server_no_context_takeover/);
    assert.doesNotMatch(response, /server_max_window_bits/);

    const [big, pong] = frames;
    assert.equal(big.text, BIG_PUBLIC, 'a large allowlisted frame arrives intact');
    assert.equal(big.rsv1, true, 'm.public: compressed');
    assert.ok(big.bytes < BIG_PUBLIC.length / 4, `compressed on the wire: ${big.bytes} B for ${BIG_PUBLIC.length} of payload`);
    assert.equal(pong.text, SMALL_PONG, 'a control reply arrives intact');
    assert.equal(pong.rsv1, false, 'pong is not allowlisted: plain, though the context is kept');
  });

  test('welcome never enters the deflate context: a large welcome with credentials goes out plain', async () => {
    assert.ok(BIG_WELCOME.length > 3000);
    const { frames } = await collect(srv, (peer) => { send(peer, JSON.parse(BIG_WELCOME)); send(peer, JSON.parse(BIG_PUBLIC)); }, 2);
    const [welcome, big] = frames;
    assert.equal(welcome.text, BIG_WELCOME);
    assert.equal(welcome.rsv1, false, 'welcome: no compressed bit, whatever its size');
    assert.ok(welcome.bytes > BIG_WELCOME.length, `sent as-is (${welcome.bytes} B for ${BIG_WELCOME.length} of payload)`);
    assert.equal(big.rsv1, true, 'the allowlisted frame right after it still compresses');
  });

  test('large non-allowlisted frames stay plain too (the allowlist is the only gate)', async () => {
    const bigResult = JSON.stringify({ t: 'm.result', summary: 'x'.repeat(8000) });
    const { frames } = await collect(srv, (peer) => send(peer, JSON.parse(bigResult)), 1);
    assert.equal(frames[0].text, bigResult);
    assert.equal(frames[0].rsv1, false, 'm.result is not allowlisted: plain');
  });

  test('the window is kept across allowlisted frames: the same frame twice costs less the second time', async () => {
    const { frames } = await collect(srv, (peer) => { send(peer, JSON.parse(BIG_PUBLIC)); send(peer, JSON.parse(BIG_PUBLIC)); }, 2);
    assert.equal(frames[0].text, BIG_PUBLIC);
    assert.equal(frames[1].text, BIG_PUBLIC);
    // The stated comparison is against the same frame with the window reset (next test): there the repeat costs what
    // the first copy did, here it is a fraction. 0.75 is far from both sides of that gap.
    const r = repeatRatio(frames);
    assert.ok(r < 0.75, `the repeated frame reuses the window: ${frames[0].bytes} B then ${frames[1].bytes} B (ratio ${r.toFixed(2)})`);
  });

  test('a client that requires server_no_context_takeover gets per-message frames, still compressed', async () => {
    const kept = await collect(srv, (peer) => { send(peer, JSON.parse(BIG_PUBLIC)); send(peer, JSON.parse(BIG_PUBLIC)); }, 2);
    const reset = await collect(srv, (peer) => { send(peer, JSON.parse(BIG_PUBLIC)); send(peer, JSON.parse(BIG_PUBLIC)); }, 2,
      { extensions: 'permessage-deflate; client_max_window_bits; server_no_context_takeover' });
    assert.match(reset.response, /server_no_context_takeover/);
    assert.equal(reset.frames[0].rsv1, true, 'large frames are still compressed, each on its own');
    const rReset = repeatRatio(reset.frames);
    assert.ok(rReset > 0.9, `no window to reuse: ${reset.frames[0].bytes} B then ${reset.frames[1].bytes} B (ratio ${rReset.toFixed(2)})`);
    assert.ok(repeatRatio(kept.frames) < rReset - 0.15, 'keeping the window is what the saving comes from');
  });

  test('each connection has its own window: a second client pays the first frame in full', async () => {
    const a = await collect(srv, (peer) => send(peer, JSON.parse(BIG_PUBLIC)), 1);
    const b = await collect(srv, (peer) => send(peer, JSON.parse(BIG_PUBLIC)), 1);
    assert.ok(b.frames[0].bytes > a.frames[0].bytes * 0.8,
      `no cross-connection savings: ${a.frames[0].bytes} B vs ${b.frames[0].bytes} B`);
  });

  test('a client without the extension gets the same messages uncompressed', async () => {
    const { response, frames } = await collect(srv, (peer) => { send(peer, JSON.parse(BIG_PUBLIC)); send(peer, JSON.parse(SMALL_PONG)); }, 2, { extensions: '' });
    assert.doesNotMatch(response, /sec-websocket-extensions/i);
    assert.deepEqual(frames.map((f) => f.text), [BIG_PUBLIC, SMALL_PONG]);
    assert.equal(frames[0].rsv1, false);
    assert.ok(frames[0].bytes > BIG_PUBLIC.length, `plain frame: ${frames[0].bytes} B for ${BIG_PUBLIC.length}`);
  });

  test('sendRaw without the compress flag stays plain even for allowlisted types (bare callers opt in explicitly)', async () => {
    const { frames } = await collect(srv, (peer) => { sendRaw(peer, BIG_PUBLIC); sendRaw(peer, BIG_PUBLIC, { compress: true }); }, 2);
    assert.equal(frames[0].rsv1, false, 'no compress flag: plain');
    assert.equal(frames[1].rsv1, true, 'compress: true: compressed');
  });
});

describe('narrowDeflateOffer (reference window 15)', () => {
  test('an offer capping the server window below 15 connects uncompressed instead of a degraded context', async () => {
    const srv9 = await fakeServer();
    try {
      const { response, frames } = await collect(srv9, (peer) => send(peer, JSON.parse(BIG_PUBLIC)), 1,
        { extensions: 'permessage-deflate; server_max_window_bits=9' });
      assert.doesNotMatch(response, /sec-websocket-extensions: permessage/i, 'the header is dropped at the upgrade');
      assert.equal(frames[0].text, BIG_PUBLIC);
      assert.equal(frames[0].rsv1, false);
    } finally { await srv9.close(); }
  });

  test('decision table', () => {
    assert.equal(narrowDeflateOffer('permessage-deflate; server_max_window_bits=9'), true);
    assert.equal(narrowDeflateOffer('permessage-deflate; server_max_window_bits=14; client_max_window_bits'), true);
    assert.equal(narrowDeflateOffer(`permessage-deflate; server_max_window_bits=${WS_DEFLATE_SERVER_WINDOW_BITS}`), false, 'the full window itself is fine');
    assert.equal(narrowDeflateOffer('permessage-deflate; client_max_window_bits'), false, 'what browsers send');
    assert.equal(narrowDeflateOffer('permessage-deflate; server_max_window_bits=9, permessage-deflate'), false, 'another offer is acceptable');
    assert.equal(narrowDeflateOffer(undefined), false);
    assert.equal(narrowDeflateOffer(''), false);
  });
});

test('SP_WS_COMPRESSION=off serves plain connections', async () => {
  const srv = await fakeServer({ wsCompression: false });
  try {
    const { response, frames } = await collect(srv, (peer) => send(peer, JSON.parse(BIG_PUBLIC)), 1);
    assert.doesNotMatch(response, /sec-websocket-extensions/i);
    assert.equal(frames[0].rsv1, false);
    assert.ok(frames[0].bytes > BIG_PUBLIC.length, `plain frame: ${frames[0].bytes} B for ${BIG_PUBLIC.length}`);
  } finally { await srv.close(); }
});

describe('the real server (SP_WS_COMPRESSION)', () => {
  test('on by default: /ws negotiates compression, the welcome frame with its credentials goes out plain', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    try {
      const client = await rawClient({ port: srv.port });
      try {
        assert.match(client.response, /permessage-deflate/);
        assert.match(client.response, /client_no_context_takeover/);
        client.send(JSON.stringify({ t: 'hello', name: '博士' }));
        const welcome = await client.next();
        assert.equal(JSON.parse(welcome.text).t, 'welcome');
        assert.equal(welcome.rsv1, false, 'credentials never enter the shared deflate context');
        // an unknown type answers with an error frame — plain as well
        client.send(JSON.stringify({ t: 'no.such.type' }));
        const err = await client.next();
        assert.equal(JSON.parse(err.text).t, 'error');
        assert.equal(err.rsv1, false);
      } finally { client.close(); }
    } finally { await srv.close(); }
  });

  test('SP_WS_COMPRESSION=off: no extension negotiated', async () => {
    process.env.SP_WS_COMPRESSION = 'off';
    try {
      const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
      try {
        const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
        await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        assert.equal(ws.extensions, '');
        ws.close();
      } finally { await srv.close(); }
    } finally { delete process.env.SP_WS_COMPRESSION; }
  });

  test('an invalid SP_WS_COMPRESSION refuses to boot', async () => {
    process.env.SP_WS_COMPRESSION = 'maybe';
    try {
      await assert.rejects(startServer({ port: 0, host: '127.0.0.1', quiet: true }), /SP_WS_COMPRESSION must be on or off/);
    } finally { delete process.env.SP_WS_COMPRESSION; }
  });

  test('the real server keeps the 64 KB inflated frame limit', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      assert.match(ws.extensions, /permessage-deflate/);
      // a compressed client frame whose inflated size is over the limit closes the socket (1009), like a plain one
      const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
      ws.send(JSON.stringify({ t: 'hello', name: 'x'.repeat(70 * 1024) }));
      assert.equal(await closed, 1009);
    } finally {
      await srv.close();
    }
  });
});
