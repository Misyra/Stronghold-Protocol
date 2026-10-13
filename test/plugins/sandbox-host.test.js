import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createMatchHosts } from '../../server/match/host/index.js';
import { contentHashOf } from '../../shared/plugins/identity.js';
import { sha256Hex } from '../../shared/sha256.js';
import { getData } from '../../server/data.js';
import { scriptPlugin } from '../helpers/simHostFixture.js';

function composition(source, data = { bonds: {} }) {
  const script = scriptPlugin(source);
  const files = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(JSON.stringify(v))]));
  const hashInput = { app: '0.3.0-dev', sim: 'a'.repeat(64), data: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha256Hex(v)])),
    plugins: [{ id: script.id, version: '1.0.0', files: { 'main.js': script.files['main.js'].sha256 } }], settings: {} };
  const cs = contentHashOf(hashInput);
  const set = { cs, hashInput, plugins: hashInput.plugins, scripts: [script] };
  return { cs, contents: { get: () => set, dataBytes: () => files } };
}
test('sandbox gate is off by default, rejects trusted; script hosts force permission child, watchdog ends matches', { timeout: 10000 }, async t => {
  const old = process.env.SP_PLUGIN_SCRIPTS;
  t.after(() => { if (old === undefined) delete process.env.SP_PLUGIN_SCRIPTS; else process.env.SP_PLUGIN_SCRIPTS = old; });
  delete process.env.SP_PLUGIN_SCRIPTS;
  const set = composition('export default function(){ while(true){} }');
  const opts = { transport: 'worker', heartbeatMs: 50, watchdogMs: 1500,
    matchModule: fileURLToPath(new URL('../../server/match/StubMatch.js', import.meta.url)),
    scriptSdkModule: fileURLToPath(new URL('../helpers/scriptSdkStub.js', import.meta.url)) };
  const hosts = createMatchHosts({ contents: set.contents, options: opts }); t.after(() => hosts.close());
  assert.throws(() => hosts.create(set.cs, {}), e => e.code === 'PLUGIN_SANDBOX_DISABLED');
  process.env.SP_PLUGIN_SCRIPTS = 'sandbox';
  set.contents.get().scripts[0].class = 'trusted';
  assert.throws(() => hosts.create(set.cs, {}), e => e.code === 'PLUGIN_SANDBOX_CLASS');
  set.contents.get().scripts[0].class = 'script';
  let finish;
  const ended = new Promise(resolve => { finish = resolve; });
  const messages = [];
  const proxy = hosts.create(set.cs, { roomCode: 'TEST', cs: set.cs, requireCs: true,
    send: () => {}, broadcast: m => messages.push(m), onEnd: finish });
  assert.equal(hosts._host(set.cs).transport, 'process');
  assert.ok(hosts._host(set.cs).child.spawnargs.includes('--permission'));
  proxy.start();
  const timer = setTimeout(() => finish({ reason: 'test-timeout' }), 7000);
  const result = await ended; clearTimeout(timer);
  assert.equal(result.reason, 'plugin-hang');
  assert.ok(messages.some(m => m.t === 'm.toast'));
  assert.equal(proxy.ended, true, 'onEnd is the lobby return path');
  assert.equal(hosts.stats().workers, 0);
});


test('SES child boots the real Match and finishes an all-bot game without engine errors', { timeout: 90000 }, async t => {
  const old = process.env.SP_PLUGIN_SCRIPTS;
  process.env.SP_PLUGIN_SCRIPTS = 'sandbox';
  t.after(() => { if (old === undefined) delete process.env.SP_PLUGIN_SCRIPTS; else process.env.SP_PLUGIN_SCRIPTS = old; });
  const set = composition('export default function setup() {}', getData());
  const hosts = createMatchHosts({ contents: set.contents, options: { virtualTime: true, matchOptions: { botRehearsal: 0 },
    scriptSdkModule: fileURLToPath(new URL('../helpers/scriptSdkStub.js', import.meta.url)) } });
  t.after(() => hosts.close());
  let done;
  const end = new Promise(resolve => { done = resolve; });
  const match = hosts.create(set.cs, { cs: set.cs, requireCs: true, roomCode: 'TEST', mode: 'coop', difficulty: 'NORMAL',
    modeId: 'mode_multi_normal', seed: 7, matchNo: 1, spectators: [],
    seats: Array.from({ length: 4 }, (_, seat) => ({ seat, playerId: 'bot_' + seat, name: 'Bot', isBot: true, connected: true })),
    send: () => {}, broadcast: () => {}, onEnd: done });
  match.start();
  const result = await end;
  assert.equal(typeof result.victory, 'boolean', JSON.stringify(result));
  const d = await match.diag();
  assert.equal(d.errorCount, 0, JSON.stringify(d.errors));
  assert.equal(d.cs, set.cs);
});
