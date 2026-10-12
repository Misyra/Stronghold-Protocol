// test/lobby-plugins.test.js — the room's plugins (DESIGN §32 P1a, server/lobby.js setPlugins; shared/protocol.js
// room.setPlugins): the host switches cosmetic plugins on before the match — room.state.content names the set (`vs`, the
// plugins, their warnings and size) while `cs` stays the vanilla one (art never changes a battle: the match and its
// BattleSpecs get the vanilla cs), the other humans are un-readied, the same set again changes nothing, an empty list
// brings back exactly the vanilla shape; refused: a player who is not the host, a running match, an unknown plugin, a
// plugin of another class or scope, a malformed message, a lobby given no visual sets. A plugin of the room's set that
// changes on disk: the host (only) is told once to apply the plugins again, and the same list then makes the set of the
// files as they are now. A real server in-process with a plugins folder of its own (art generated on the spot).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { png, writePlugin, cosmetic } from './helpers/pluginFixtures.js';
import { ERR } from '../shared/constants.js';
import { validateC2S } from '../shared/protocol.js';
import { layVisualOps, prepareVisualDoc } from '../shared/plugins/visual.js';

class RecordingStub extends StubMatch {
  static last = null;
  constructor(o) { super(o); RecordingStub.last = o; }
}

describe('room.setPlugins (P1a: cosmetic plugins)', () => {
  let srv;
  let tmp;
  const open = [];
  const player = async (name) => {
    const c = await TestClient.connect(srv.url.replace('http', 'ws') + '/ws');
    open.push(c);
    const w = await c.hello(name);
    c.id = w.playerId;
    c.welcome = w;
    return c;
  };
  const room = async (host, mode = 'coop') => {
    assert.equal((await host.request({ t: 'room.create', mode, difficulty: 'NORMAL' })).t, 'ok');
    return host.waitFor('room.state', (s) => s.hostId === host.id);
  };

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-lobby-plugins-'));
    const plugins = path.join(tmp, 'plugins');
    writePlugin(path.join(plugins, 'texas-red'), cosmetic({ assets: { chars: { char_102_texas: { avatar: 'a.png' } } } }), { 'a.png': png(4, 4) });
    writePlugin(path.join(plugins, 'texas-blue'), cosmetic({ assets: { chars: { char_102_texas: { avatar: 'b.png' } } } }), { 'b.png': png(4, 4, [0, 0, 255, 255]) });
    writePlugin(path.join(plugins, 'mine'), cosmetic({ scope: ['personal'], assets: { chars: { char_102_texas: { avatar: 'm.png' } } } }), { 'm.png': png(2, 2) });
    writePlugin(path.join(plugins, 'rules'), { manifest: 2, version: '1.0.0', app: '*', api: 1, class: 'content', permissions: ['data.patch'], data: ['d.json'] }, { 'd.json': { patch: 1, ops: [] } });
    writePlugin(path.join(plugins, 'base'), cosmetic({ assets: { chars: { char_112_siege: { avatar: 'b.png' } } } }), { 'b.png': png(2, 2) });
    writePlugin(path.join(plugins, 'top'), cosmetic({ requires: { base: '*' }, assets: { chars: { char_102_texas: { avatar: 't.png' } } } }), { 't.png': png(2, 2) });
    writePlugin(path.join(plugins, 'fresh'), cosmetic({ assets: { chars: { char_112_siege: { avatar: 'f.png' } } } }), { 'f.png': png(2, 2, [1, 1, 1, 255]) });
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, pluginsDir: plugins, MatchClass: RecordingStub, assetIndex: false });
  });
  after(async () => {
    await Promise.all(open.map((c) => c.terminate().catch(() => {})));
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('the host switches plugins on: room.state.content names the set, cs stays the vanilla one, the others are un-readied', async () => {
    const host = await player('Kal\'tsit');
    const guest = await player('Amiya');
    const s0 = await room(host);
    assert.deepEqual(s0.content, { cs: srv.content.cs, vanilla: true, plugins: [] }, 'a room without plugins: the vanilla shape of P0');
    assert.equal((await guest.request({ t: 'room.join', code: s0.code })).t, 'ok');
    assert.equal((await guest.request({ t: 'room.ready', ready: true })).t, 'ok');
    await host.waitFor('room.state', (s) => s.seats.some((x) => x && x.playerId === guest.id && x.ready));
    assert.equal((await host.request({ t: 'room.setPlugins', plugins: [{ id: 'texas-blue' }, { id: 'texas-red' }] })).t, 'ok');
    const s1 = await guest.waitFor('room.state', (s) => !!s.content?.vs);
    assert.equal(s1.content.cs, srv.content.cs, 'art never changes a battle: the vanilla cs');
    assert.equal(s1.content.vanilla, true);
    assert.match(s1.content.vs, /^[0-9a-f]{64}$/);
    assert.deepEqual(s1.content.plugins.map((p) => [p.id, p.version, p.class]), [['texas-blue', '1.0.0', 'cosmetic'], ['texas-red', '1.0.0', 'cosmetic']], 'in load order (by id)');
    assert.deepEqual(s1.content.warnings, [{ code: 'override', params: { path: 'chars.char_102_texas.avatar', plugins: ['texas-blue', 'texas-red'] } }]);
    assert.ok(s1.content.bytes > 0);
    assert.equal(s1.seats.find((x) => x && x.playerId === guest.id).ready, false, 'un-readied like a difficulty change');
    // the room's set is served: its composition is what room.state named, and a page composing it draws the later plugin
    const doc = await (await fetch(`${srv.url}/vs/${s1.content.vs.slice(0, 16)}/overlay.json`)).json();
    assert.equal(doc.visual.vs, s1.content.vs);
    const view = await (await fetch(`${srv.url}/data/assets.json`)).json();
    assert.match(layVisualOps(view, [prepareVisualDoc(doc)]).manifest.chars.char_102_texas.avatar, /^\/p\/texas-red\//, 'the later plugin applies');
    // the same set again: nothing changes, nobody is un-readied, no room.state
    assert.equal((await guest.request({ t: 'room.ready', ready: true })).t, 'ok');
    await host.waitFor('room.state', (s) => s.seats.some((x) => x && x.playerId === guest.id && x.ready));
    await guest.waitFor('room.state', (s) => s.seats.some((x) => x && x.playerId === guest.id && x.ready));
    guest.clearInbox();
    assert.equal((await host.request({ t: 'room.setPlugins', plugins: [{ id: 'texas-red' }, { id: 'texas-blue' }] })).t, 'ok');
    await guest.expectNone('room.state', () => true, 200);
    // the match gets the vanilla cs
    assert.equal((await host.request({ t: 'room.start' })).t, 'ok');
    await host.waitFor('room.state', (s) => s.inMatch === true);
    assert.equal(RecordingStub.last.cs, srv.content.cs, 'lobby → Match opts.cs: the vanilla one');
    // during the match: refused
    const busy = await host.request({ t: 'room.setPlugins', plugins: [] });
    assert.deepEqual([busy.t, busy.code], ['error', ERR.ROOM_STARTED]);
  });

  test('an empty list brings back exactly the vanilla shape; refused: not the host, unknown, another class or scope, malformed', async () => {
    const host = await player('Doctor');
    const guest = await player('Warfarin');
    const s0 = await room(host);
    assert.equal((await guest.request({ t: 'room.join', code: s0.code })).t, 'ok');
    assert.equal((await host.request({ t: 'room.setPlugins', plugins: [{ id: 'texas-red' }] })).t, 'ok');
    await host.waitFor('room.state', (s) => !!s.content?.vs);
    const refuse = async (c, msg, code) => { const r = await c.request(msg); assert.deepEqual([r.t, r.code], ['error', code], JSON.stringify(r)); return r; };
    await refuse(guest, { t: 'room.setPlugins', plugins: [] }, ERR.NOT_HOST);
    await refuse(host, { t: 'room.setPlugins', plugins: [{ id: 'absent' }] }, ERR.PLUGIN_UNKNOWN);
    await refuse(host, { t: 'room.setPlugins', plugins: [{ id: 'rules' }] }, ERR.PLUGIN_BLOCKED);
    const scope = await refuse(host, { t: 'room.setPlugins', plugins: [{ id: 'mine' }] }, ERR.PLUGIN_BLOCKED);
    assert.match(scope.detail, /scope room/);
    await refuse(host, { t: 'room.setPlugins', plugins: [{ id: 'Texas' }] }, ERR.BAD_MSG);
    await refuse(host, { t: 'room.setPlugins', plugins: 'texas-red' }, ERR.BAD_MSG);
    await refuse(host, { t: 'room.setPlugins' }, ERR.BAD_MSG);
    assert.equal((await host.request({ t: 'room.setPlugins', plugins: [] })).t, 'ok');
    const back = await guest.waitFor('room.state', (s) => !s.content?.vs);
    assert.deepEqual(back.content, { cs: srv.content.cs, vanilla: true, plugins: [] });
  });

  test('「自动」: a plugin switched on because another needs it; chosen later, the same set — broadcast, nobody un-readied', async () => {
    const host = await player('Texas');
    const guest = await player('Lappland');
    const s0 = await room(host);
    assert.equal((await guest.request({ t: 'room.join', code: s0.code })).t, 'ok');
    assert.equal((await host.request({ t: 'room.setPlugins', plugins: [{ id: 'top' }] })).t, 'ok');
    const s1 = await host.waitFor('room.state', (s) => !!s.content?.vs);
    assert.deepEqual(s1.content.plugins.map((p) => [p.id, !!p.auto]), [['base', true], ['top', false]]);
    assert.equal((await guest.request({ t: 'room.ready', ready: true })).t, 'ok');
    await host.waitFor('room.state', (s) => s.seats.some((x) => x && x.playerId === guest.id && x.ready));
    assert.equal((await host.request({ t: 'room.setPlugins', plugins: [{ id: 'top' }, { id: 'base' }] })).t, 'ok');
    const s2 = await host.waitFor('room.state', (s) => s.content?.plugins?.some((p) => p.id === 'base' && !p.auto));
    assert.equal(s2.content.vs, s1.content.vs, 'the same set');
    assert.equal(s2.seats.find((x) => x && x.playerId === guest.id).ready, true, 'nobody un-readied for a mark');
  });

  test('a plugin of the room\'s set changes on disk: the host is told once to apply again; the same list then makes the new set', async () => {
    const host = await player('Ifrit');
    const guest = await player('Saria');
    const s0 = await room(host);
    assert.equal((await guest.request({ t: 'room.join', code: s0.code })).t, 'ok');
    assert.equal((await host.request({ t: 'room.setPlugins', plugins: [{ id: 'fresh' }] })).t, 'ok');
    const s1 = await guest.waitFor('room.state', (s) => !!s.content?.vs);
    host.clearInbox();
    guest.clearInbox();
    fs.writeFileSync(path.join(tmp, 'plugins', 'fresh', 'f.png'), png(2, 2, [2, 2, 2, 255]));
    srv.packs.rescan();
    const toast = await host.waitFor('m.toast', (m) => m.msgid === '房间插件「{names}」的文件在服务器上变了，请在插件面板中点「重新应用」');
    assert.deepEqual([toast.kind, toast.params?.names], ['warn', 'fresh']);
    await guest.expectNone('m.toast', () => true, 150);
    srv.packs.rescan();
    await host.expectNone('m.toast', () => true, 150);
    // 「重新应用」: the same list → the set of the files as they are now
    assert.equal((await host.request({ t: 'room.setPlugins', plugins: [{ id: 'fresh' }] })).t, 'ok');
    const s2 = await guest.waitFor('room.state', (s) => !!s.content?.vs && s.content.vs !== s1.content.vs);
    assert.deepEqual(s2.content.plugins.map((p) => p.id), ['fresh']);
    assert.notEqual(s2.content.plugins[0].hash, s1.content.plugins[0].hash);
  });

  test('a room holds its visual set while it uses it: released when it changes and when the room goes', () => {
    const calls = [];
    const plugins = {
      resolve: (ids) => ({ ok: true, set: { vs: (ids.join('-').charCodeAt(0) % 16).toString(16).repeat(64), plugins: ids.map((id) => ({ id, version: '1.0.0', class: 'cosmetic', hash: '0'.repeat(16) })), warnings: [], bytes: 1 } }),
      hold: (vs) => calls.push(['hold', vs.slice(0, 2)]),
      release: (vs) => calls.push(['release', vs.slice(0, 2)]),
    };
    const lobby = new Lobby({ registry: new SessionRegistry(), content: { cs: 'ab'.repeat(32) }, plugins });
    const session = { playerId: 'p1', name: 'A', connected: true, roomCode: null, ws: null };
    assert.deepEqual(lobby.create(session, { mode: 'solo', difficulty: 'NORMAL' }), { ok: true });
    assert.deepEqual(lobby.setPlugins(session, { plugins: [{ id: 'a' }] }), { ok: true });   // 'a' → 1…
    assert.deepEqual(lobby.setPlugins(session, { plugins: [{ id: 'b' }] }), { ok: true });   // 'b' → 2…
    assert.deepEqual(lobby.setPlugins(session, { plugins: [] }), { ok: true });
    assert.deepEqual(lobby.setPlugins(session, { plugins: [{ id: 'a' }] }), { ok: true });
    lobby.leave(session);
    assert.deepEqual(calls, [['hold', '11'], ['hold', '22'], ['release', '11'], ['release', '22'], ['hold', '11'], ['release', '11']]);
    lobby.shutdown();
  });

  test('the host\'s result replay is dropped only when the set changes: the same set again, or a refused one, keeps it', () => {
    const plugins = {
      resolve: (ids) => (ids.includes('absent') ? { error: ERR.PLUGIN_UNKNOWN, detail: 'absent is not installed' }
        : { ok: true, set: { vs: (ids.join('-').charCodeAt(0) % 16).toString(16).repeat(64), plugins: ids.map((id) => ({ id, version: '1.0.0', class: 'cosmetic', hash: '0'.repeat(16) })), warnings: [], bytes: 1 } }),
      hold() {}, release() {},
    };
    const lobby = new Lobby({ registry: new SessionRegistry(), content: { cs: 'ab'.repeat(32) }, plugins });
    const session = { playerId: 'p1', name: 'A', connected: true, roomCode: null, ws: null };
    assert.deepEqual(lobby.create(session, { mode: 'solo', difficulty: 'NORMAL' }), { ok: true });
    const r = lobby.getRoom(session.roomCode);
    assert.deepEqual(lobby.setPlugins(session, { plugins: [{ id: 'a' }] }), { ok: true });
    // a settlement screen still open: the lobby replays its result until the player acts (dropReplay)
    r.replay = { pending: new Set(['p1']), frames: new Map([['p1', { t: 'm.result' }]]), publicFrame: { t: 'm.public' } };
    assert.deepEqual(lobby.setPlugins(session, { plugins: [{ id: 'a' }] }), { ok: true });
    assert.ok(r.replay?.pending.has('p1'), 'the same set again: kept');
    assert.equal(lobby.setPlugins(session, { plugins: [{ id: 'absent' }] }).error, ERR.PLUGIN_UNKNOWN);
    assert.ok(r.replay?.pending.has('p1'), 'a refused set: kept');
    assert.deepEqual(lobby.setPlugins(session, { plugins: [{ id: 'b' }] }), { ok: true });
    assert.equal(r.replay, null, 'another set: the host moved on');
    lobby.shutdown();
  });

  test('the protocol: room.setPlugins { plugins: [{ id, settings? }] } — plugin ids, ≤ 32, scalar settings', () => {
    assert.equal(validateC2S({ t: 'room.setPlugins', plugins: [] }), null);
    assert.equal(validateC2S({ t: 'room.setPlugins', plugins: [{ id: 'texas-red', settings: { a: 1, b: 'x', c: true } }] }), null);
    for (const plugins of [[{ id: 'A' }], [{ id: 'x' }], [{}], [{ id: 'ok-id', settings: { a: {} } }], Array.from({ length: 33 }, (_, i) => ({ id: `p${i}x` })), null]) {
      assert.equal(validateC2S({ t: 'room.setPlugins', plugins }), 'bad field plugins', JSON.stringify(plugins).slice(0, 60));
    }
  });

  test('a lobby given no visual sets refuses any plugin; an empty list is fine', () => {
    const lobby = new Lobby({ registry: new SessionRegistry(), content: { cs: 'ab'.repeat(32) } });
    const session = { playerId: 'p1', name: 'A', connected: true, roomCode: null, ws: null };
    lobby.registry.add?.(session);
    assert.deepEqual(lobby.create(session, { mode: 'solo', difficulty: 'NORMAL' }), { ok: true });
    assert.equal(lobby.setPlugins(session, { plugins: [{ id: 'texas-red' }] }).error, ERR.PLUGIN_UNKNOWN);
    assert.deepEqual(lobby.setPlugins(session, { plugins: [] }), { ok: true });
    assert.deepEqual(lobby.getRoom(session.roomCode).toState().content, { cs: 'ab'.repeat(32), vanilla: true, plugins: [] });
    lobby.shutdown();
  });
});
