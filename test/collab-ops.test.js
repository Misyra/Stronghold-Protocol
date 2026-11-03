// 联动干员 (the owner's decision of 2026-11-02): the room switch `experimental.collabOps` (shared/experimental.js), the
// 自选 rule it opens (shared/diy.js `collab`, the lobby's room.diy and match start, the match's own check), and the
// collab art pack (shared/collabAssets.js, data/assets-collab.json, the page's layer and fetch, the served view).
// The owner's two cuts for this repo: no copyright warning / hold (the host switches it directly) and a room with it on
// still enters the official matchmaking queue (the ROOM_MODDED guard stays for gameplay-plugin rooms only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/net.js';
import { ERR } from '../shared/constants.js';
import { validateC2S } from '../shared/protocol.js';
import { experimentalOptions, experimentalKey, sameExperimental, isExperimental, isCollabRoom } from '../shared/experimental.js';
import { COLLAB_ASSET_PREFIX, isCollabUrl, toCollabUrl, collabManifestProblems, mergeCollabManifest, collabManifestOf, manifestUrls } from '../shared/collabAssets.js';
import { collabPackProblems } from '../tools/collab-assets.mjs';
import { rewriteManifest } from '../server/http/assetViews.js';
import { KITTED_CHARS } from '../server/sim/content/kits/index.js';
import { hasGeneratedData } from '../server/sim/simdata.js';
import { createStore } from '../public/js/store.js';
import { createDataStore } from '../public/js/data.js';
import { createCosmeticLayers } from '../public/js/cosmetics.js';
import { installContent } from '../public/js/content.js';
import { makeMatch } from './match/harness.js';

const ROOT = resolve(import.meta.dirname, '..');
const json = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
const chess = json('data/chess.json');
const backups = json('data/backups.json');
const COLLAB = backups.diy.excluded;
const ASH = 'char_456_ash';
const T6A = 'chess_char_6_diy1_a', T5A = 'chess_char_5_diy1_a';
const ASH_PICK = { charId: ASH, skillIndex: 2, uniEquipId: null };
const rules = (o = {}) => ({ revivalEnabled: false, disableSharedPool: false, ...o });
const ON = rules({ collabOps: true });
const REAL = { skip: !hasGeneratedData() };

test('the switch: an optional strict boolean, absent when off; its own key', () => {
  assert.deepEqual(experimentalOptions(rules({ collabOps: false })), rules());
  assert.deepEqual(experimentalOptions(ON), ON);
  assert.equal(experimentalKey(ON), '00:collab');
  assert.equal(experimentalKey(rules()), '00');
  assert.equal(sameExperimental(ON, rules()), false);
  assert.equal(sameExperimental(ON, rules({ collabOps: true })), true);
  for (const bad of ['true', 1, null]) assert.equal(isExperimental(rules({ collabOps: bad })), false, String(bad));
  assert.equal(isCollabRoom(ON), true);
  assert.equal(isCollabRoom(rules()), false);
  assert.equal(isCollabRoom(null), false);
  assert.equal(validateC2S({ t: 'room.setExperimental', experimental: ON }), null);
});

function fixture(t) {
  const registry = new SessionRegistry();
  class RecordingMatch {
    constructor(options) { this.opts = options; }
    start() {}
    dispose() {}
    onLeave() {}
    onDisconnect() {}
  }
  const lobby = new Lobby({ registry, MatchClass: RecordingMatch, getData: () => ({ chess, backups }), seedFn: () => 7 });
  // the collab kits are other work: widen the registry for 灰烬
  lobby.kittedFor = () => [...KITTED_CHARS, ASH];
  t.after(() => lobby.shutdown());
  let n = 0;
  const player = () => {
    const s = registry.create(`Collab${++n}`);
    s.connected = true;
    s.ws = { readyState: 1, bufferedAmount: 0, send(data, cb) { cb?.(); } };
    return s;
  };
  const room = (size, mode = 'coop') => {
    const members = Array.from({ length: size }, player);
    assert.deepEqual(lobby.create(members[0], { mode, difficulty: 'NORMAL', experimental: rules() }), { ok: true });
    const owner = lobby.roomOf(members[0]);
    for (const m of members.slice(1)) {
      assert.deepEqual(lobby.join(m, { code: owner.code }), { ok: true });
      assert.deepEqual(lobby.ready(m, { ready: true }), { ok: true });
    }
    return { owner, members };
  };
  return { lobby, room, player };
}

test('lobby: the host of a private room only, never a matchmade room; it still queues (no ROOM_MODDED)', (t) => {
  const h = fixture(t);
  const { owner, members } = h.room(2);
  assert.equal(h.lobby.setExperimental(members[1], { experimental: ON }).error, ERR.NOT_HOST);
  assert.deepEqual(h.lobby.setExperimental(members[0], { experimental: ON }), { ok: true });
  assert.deepEqual(owner.toState().experimental, ON);
  assert.equal(owner.seatOf(members[1].playerId).ready, false, 'a rule change un-readies the teammates');
  // the owner's cut: a room with 联动干员 on is not modded, so the official queue still takes it
  assert.equal(owner.modded, false);
  assert.equal(h.lobby.collabOn(owner), true);
  assert.deepEqual(h.lobby.setExperimental(members[0], { experimental: rules() }), { ok: true }, 'off at once');
  assert.equal(h.lobby.collabOn(owner), false);
  // a matchmade room never has it
  const other = h.room(1);
  other.owner.source = 'matchmaking';
  assert.equal(h.lobby.setExperimental(other.members[0], { experimental: ON }).error, ERR.BAD_MSG);
  assert.equal(h.lobby.collabOn(other.owner), false);
  // room.state carries the switch only while it is on
  assert.equal(Object.hasOwn(other.owner.toState(), 'experimental'), false);
});

test('lobby: room.diy keeps a collab pick only while the room has it on; the match start drops it once the host turned it off', REAL, async (t) => {
  const h = fixture(t);
  const { owner, members } = h.room(1, 'solo');
  const picks = { [T5A]: { charId: 'char_609_acguad' }, [T6A]: ASH_PICK };
  assert.deepEqual(h.lobby.diy(members[0], { picks }), { ok: true });
  assert.equal(members[0].diy[T6A], undefined, 'off: dropped');
  assert.deepEqual(h.lobby.setExperimental(members[0], { experimental: ON }), { ok: true });
  assert.deepEqual(h.lobby.diy(members[0], { picks }), { ok: true });
  assert.deepEqual(members[0].diy[T6A], ASH_PICK, 'on: kept');
  assert.deepEqual(owner.seatOf(members[0].playerId).diy[T6A], ASH_PICK);
  // turned off before the start: the seat's collab pick does not reach the match
  assert.deepEqual(h.lobby.setExperimental(members[0], { experimental: rules() }), { ok: true });
  assert.deepEqual(await h.lobby.start(members[0]), { ok: true });
  const seat = owner.match.opts.seats[0];
  assert.equal(seat.diy[T6A], undefined);
  assert.ok(seat.diy[T5A], 'the other picks stay');
});

test('lobby: a room with it on hands the collab pick to the match, with the switch in its options', REAL, async (t) => {
  const h = fixture(t);
  const { owner, members } = h.room(1, 'solo');
  assert.deepEqual(h.lobby.setExperimental(members[0], { experimental: ON }), { ok: true });
  assert.deepEqual(h.lobby.diy(members[0], { picks: { [T6A]: ASH_PICK } }), { ok: true });
  assert.deepEqual(await h.lobby.start(members[0]), { ok: true });
  assert.deepEqual(owner.match.opts.seats[0].diy, { [T6A]: ASH_PICK });
  assert.deepEqual(owner.match.opts.experimental, ON);
});

test('match: the player fields a collab pick only in a match with the switch on (its own check)', REAL, () => {
  const seats = [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, diy: { [T6A]: ASH_PICK } }];
  const kitted = [...KITTED_CHARS, ASH];
  const on = makeMatch({ mode: 'solo', seats, seed: 3, experimental: ON, kitted }).start();
  assert.deepEqual(on.ps('p_0').diy, { [T6A]: ASH_PICK });
  on.m.dispose();
  const off = makeMatch({ mode: 'solo', seats, seed: 3, kitted }).start();
  assert.deepEqual(off.ps('p_0').diy, {});
  off.m.dispose();
});

test('collabAssets: the prefix (hashed too), the move of a URL, the checks, the add-only merge', () => {
  assert.equal(COLLAB_ASSET_PREFIX, '/assets/collab/');
  assert.equal(isCollabUrl('/assets/collab/char/avatar/x.png'), true);
  assert.equal(isCollabUrl('/assets/~0123456789abcdef/collab/char/avatar/x.png'), true);
  assert.equal(isCollabUrl('/assets/char/avatar/x.png'), false);
  assert.equal(toCollabUrl('/assets/char/avatar/x.png'), '/assets/collab/char/avatar/x.png');
  assert.equal(toCollabUrl('/assets/collab/x.png'), '/assets/collab/x.png');
  assert.equal(toCollabUrl('/fonts/x.woff2'), '/fonts/x.woff2');
  assert.deepEqual(collabManifestProblems({ chars: { a: { avatar: '/assets/collab/a.png' } } }), []);
  assert.match(collabManifestProblems({ chars: { a: { avatar: '/assets/a.png' } } })[0], /outside \/assets\/collab\//);
  assert.match(collabManifestProblems({ enemies: {} })[0], /normal pack's/);
  const base = { version: 1, chars: { b: { avatar: '/assets/b.png' } }, enemies: { e: {} }, audio: { voice: { b: ['/assets/audio/b.mp3'] } } };
  const pack = { chars: { a: { avatar: '/assets/collab/a.png' }, b: { avatar: '/assets/collab/evil.png' } }, audio: { voice: { a: ['/assets/collab/audio/a.mp3'] } } };
  const merged = mergeCollabManifest(base, pack);
  assert.deepEqual(merged.chars, { b: { avatar: '/assets/b.png' }, a: { avatar: '/assets/collab/a.png' } }, 'a base entry is never replaced');
  assert.deepEqual(merged.audio.voice, { b: ['/assets/audio/b.mp3'], a: ['/assets/collab/audio/a.mp3'] });
  assert.equal(merged.enemies, base.enemies);
  assert.equal(base.chars.a, undefined, 'the base object is not changed');
  assert.equal(mergeCollabManifest(base, null), base);
  assert.equal(mergeCollabManifest(base, { chars: { x: { avatar: '/assets/x.png' } } }), base, 'a pack naming a normal-pack file is not laid');
  const { doc, moves } = collabManifestOf({ chars: { a: { avatar: '/assets/char/avatar/a.png', spine: { front: { skel: '/assets/spine/op/a/front/a.skel', anims: { idle: 'Idle' } } } } }, enemies: { e: {} } });
  assert.deepEqual(doc, { chars: { a: { avatar: '/assets/collab/char/avatar/a.png', spine: { front: { skel: '/assets/collab/spine/op/a/front/a.skel', anims: { idle: 'Idle' } } } } } });
  assert.deepEqual(moves, [['/assets/char/avatar/a.png', '/assets/collab/char/avatar/a.png'], ['/assets/spine/op/a/front/a.skel', '/assets/collab/spine/op/a/front/a.skel']]);
});

test('data/assets-collab.json: the pack names only its own files, covers every collab 6★; data/assets.json names none of them', () => {
  const file = new URL('../data/assets-collab.json', import.meta.url);
  assert.ok(existsSync(file), 'data/assets-collab.json is committed');
  const collab = json('data/assets-collab.json');
  const assets = json('data/assets.json');
  assert.deepEqual(collabPackProblems({ collab, assets, backups, publicDir: '', files: false }), []);
  assert.equal(collab.kind, 'collab');
  for (const id of COLLAB) {
    assert.ok(collab.chars?.[id]?.avatar, `${id}: art in the pack`);
    assert.equal(assets.chars[id], undefined, `${id}: not in the normal pack`);
  }
  for (const url of manifestUrls(collab)) assert.ok(url.startsWith(COLLAB_ASSET_PREFIX), url);
});

test('the served view of the pack carries content hashes, one per Spine model', () => {
  const doc = { chars: { a: { avatar: '/assets/collab/char/avatar/a.png',
    spine: { front: { skel: '/assets/collab/spine/a/a.skel', atlas: '/assets/collab/spine/a/a.atlas', textures: ['/assets/collab/spine/a/a.png'] } } } } };
  const index = { hashOf: () => '0123456789abcdef', modelHash: () => 'fedcba9876543210' };
  const { doc: out } = rewriteManifest(doc, 'assets-collab.json', index);
  assert.equal(out.chars.a.avatar, '/assets/~0123456789abcdef/collab/char/avatar/a.png');
  assert.equal(out.chars.a.spine.front.skel, '/assets/~fedcba9876543210/collab/spine/a/a.skel');
  assert.deepEqual(collabManifestProblems(out), [], 'the hashed view still passes the page\'s check');
});

test('cosmetic layers: the pack lies beneath the plugin layers, add-only, only on a loaded manifest; off again takes it away', () => {
  const layers = createCosmeticLayers();
  const base = { chars: { b: { avatar: '/assets/b.png' } } };
  assert.equal(layers.apply(base), base);
  let told = 0;
  layers.subscribe(() => told++);
  layers.setCollab({ chars: { a: { avatar: '/assets/collab/a.png' } } });
  assert.equal(told, 1);
  const m = layers.apply(base);
  assert.deepEqual(Object.keys(m.chars), ['b', 'a']);
  assert.equal(layers.apply(base), m, 'memoised');
  assert.deepEqual(layers.apply(undefined), {}, 'no manifest loaded: nothing laid');
  layers.setCollab(null);
  assert.equal(layers.apply(base), base);
  assert.equal(told, 2);
});

test('content.js: the pack is fetched only in a room with the switch on, once per page, and laid there only', async () => {
  const urls = [];
  const pack = { kind: 'collab', chars: { [ASH]: { avatar: '/assets/collab/char/avatar/char_456_ash.png' } } };
  const fetch = async (url) => {
    urls.push(String(url));
    if (String(url) === '/data/assets-collab.json') return { ok: true, status: 200, text: async () => JSON.stringify(pack) };
    return { ok: false, status: 404, text: async () => '' };
  };
  const app = createStore({ room: null });
  const layers = createCosmeticLayers();
  const off = installContent({ store: app, data: createDataStore({ fetch }), layers, fetch, retryDelays: [] });
  const tick = () => new Promise((r) => setTimeout(r, 10));
  try {
    app.set({ room: { code: 'A', experimental: rules() } });
    await tick();
    assert.equal(urls.filter((u) => u.includes('assets-collab')).length, 0, 'a room without it fetches nothing');
    assert.equal(layers.collab, null);
    app.set({ room: { code: 'A', experimental: ON } });
    await tick();
    assert.deepEqual(layers.collab, pack);
    app.set({ room: null });
    await tick();
    assert.equal(layers.collab, null, 'leaving takes it away');
    app.set({ room: { code: 'B', experimental: ON } });
    await tick();
    assert.deepEqual(layers.collab, pack);
    assert.equal(urls.filter((u) => u.includes('assets-collab')).length, 1, 'fetched once per page');
  } finally { off(); }
  // a pack that names a normal-pack file is refused
  const bad = createCosmeticLayers();
  const badFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ chars: { x: { avatar: '/assets/x.png' } } }) });
  const toasts = [];
  const app2 = createStore({ room: { code: 'C', experimental: ON } });
  const off2 = installContent({ store: app2, data: createDataStore({ fetch: badFetch }), layers: bad, fetch: badFetch, retryDelays: [], toast: (text) => toasts.push(text) });
  await tick();
  off2();
  assert.equal(bad.collab, null);
  assert.equal(toasts.length, 1);
});

test('the room UI: the 联动干员 row is a private room\'s only, the host\'s to switch', async () => {
  const room = (o = {}) => ({ code: 'ABCD', hostId: 'h', mode: 'coop', difficulty: 'NORMAL', seats: [{ seat: 0, playerId: 'h', name: 'Host', isBot: false, ready: false, connected: true }, null, null, null], ...o });
  const { collabOption } = await import(pathToFileURL(resolve(ROOT, 'public/js/screens/room.js')).href);
  assert.deepEqual(collabOption(room(), 'h'), { on: false, editable: true });
  assert.deepEqual(collabOption(room({ experimental: ON }), 'h'), { on: true, editable: true });
  assert.deepEqual(collabOption(room({ experimental: ON }), 'g'), { on: true, editable: false });
  assert.equal(collabOption(room({ source: 'matchmaking' }), 'h'), null, 'matchmade: no row');
  assert.equal(collabOption(null, 'h'), null);
});

test('server: the collab files are presentation data — never loaded as game data, never in the content hash', async () => {
  const { UNLOADED_DATA } = await import('../server/data.js');
  const { PRESENTATION_DATA } = await import('../server/plugins/identity.js');
  assert.ok(UNLOADED_DATA.includes('local-fx-collab.json'));
  for (const k of ['assets-collab', 'local-fx-collab']) assert.ok(PRESENTATION_DATA.includes(k), k);
});

test('collab effects: list checks and add-only merges of the file list and the index', async () => {
  const { collabFxListProblems, mergeFxGroups, mergeFxIndex, COLLAB_FX_PREFIX } = await import('../shared/collabAssets.js');
  assert.equal(COLLAB_FX_PREFIX, '/assets/collab/local/fx/');
  const ok = { groups: { fx: { index: { path: '/assets/collab/local/fx/index.json' } },
    'fx/tex': { t: { path: '/assets/~0123456789abcdef/collab/local/fx/tex/t.webp', half: '/assets/collab/local/fx/tex/t_h.webp' } } } };
  assert.deepEqual(collabFxListProblems(ok), []);
  assert.match(collabFxListProblems({ groups: { 'fx/prefabs': { p: { path: '/assets/local/fx/prefabs/p.json' } } } })[0], /outside/);
  assert.match(collabFxListProblems({ groups: { spine: {} } })[0], /not an fx group/);
  assert.deepEqual(collabFxListProblems(null), ['not an fx file list']);
  const g = mergeFxGroups({ 'fx/prefabs': { a: { path: '/n/a' } } }, { 'fx/prefabs': { a: { path: '/c/a' }, b: { path: '/c/b' } }, fx: { index: { path: '/c/i' } } });
  assert.deepEqual(g['fx/prefabs'], { a: { path: '/n/a' }, b: { path: '/c/b' } }, 'the normal set wins a key both have');
  assert.equal(g.fx, undefined, 'the collab index never replaces the normal one');
  const idx = mergeFxIndex({ version: 3, units: { u: 1 }, generic: { keys: ['g'] } }, { units: { u: 2, c: 3 }, projectiles: { p: 4 }, generic: { keys: ['x'] } });
  assert.deepEqual(idx, { version: 3, units: { u: 1, c: 3 }, projectiles: { p: 4 }, generic: { keys: ['g'] } });
  assert.deepEqual(mergeFxIndex(null, { units: { c: 1 } }), { units: { c: 1 } });
});

test('FxLibrary: the collab effects are there only while the collab layer is on; a key both sets have stays the normal one', async () => {
  const { FxLibrary } = await import('../public/js/render/vfx/library.js');
  const files = {
    '/n/index.json': { format: 'fx-index', version: 3, units: { char_002_amiya: { skills: {} } }, projectiles: {}, skills: {}, skins: {}, prefabs: { shared_a: {} } },
    '/n/textures.json': { textures: { nt: { wrap: 1 } } },
    '/n/prefabs/shared_a.json': { key: 'shared_a', from: 'normal' },
    '/data/local-fx-collab.json': { groups: {
      fx: { index: { path: '/assets/collab/local/fx/index.json' }, textures: { path: '/assets/collab/local/fx/textures.json' } },
      'fx/prefabs': { ash_buff_01_hit: { path: '/assets/collab/local/fx/prefabs/ash_buff_01_hit.json' }, shared_a: { path: '/assets/collab/local/fx/prefabs/shared_a.json' } },
      'fx/tex': { ct: { path: '/assets/collab/local/fx/tex/ct.webp' } }, 'fx/mesh': {} } },
    '/assets/collab/local/fx/index.json': { units: { char_456_ash: { skills: {} } }, projectiles: { projectile_chr_ash_t1: {} }, prefabs: { ash_buff_01_hit: {} } },
    '/assets/collab/local/fx/textures.json': { textures: { ct: { wrap: 2 } } },
    '/assets/collab/local/fx/prefabs/ash_buff_01_hit.json': { key: 'ash_buff_01_hit', from: 'collab' },
  };
  const fetched = [];
  const fetch = async (url) => {
    fetched.push(url);
    const body = files[url];
    return body ? { ok: true, status: 200, json: async () => structuredClone(body) } : { ok: false, status: 404, json: async () => null };
  };
  const list = { groups: { fx: { index: { path: '/n/index.json' }, textures: { path: '/n/textures.json' } }, 'fx/prefabs': { shared_a: { path: '/n/prefabs/shared_a.json' } }, 'fx/tex': {}, 'fx/mesh': {} } };
  const layers = { collab: null };
  const lib = new FxLibrary({ fetch, list, layers });
  // off: nothing of the pack, nothing fetched of it; a lookup comes back empty
  assert.equal((await lib.index()).units.char_456_ash, undefined);
  assert.equal(lib.has('ash_buff_01_hit'), false);
  assert.equal(await lib.descriptor('ash_buff_01_hit'), null);
  assert.ok(!fetched.includes('/data/local-fx-collab.json'), 'not fetched while off');
  // on: merged, and the earlier empty lookup is forgotten
  layers.collab = { chars: {} };
  const idx = await lib.index();
  assert.ok(idx.units.char_456_ash && idx.units.char_002_amiya && idx.projectiles.projectile_chr_ash_t1);
  assert.equal(lib.has('ash_buff_01_hit'), true);
  assert.deepEqual(await lib.descriptor('ash_buff_01_hit'), { key: 'ash_buff_01_hit', from: 'collab' });
  assert.equal(lib.url('fx/prefabs', 'shared_a'), '/n/prefabs/shared_a.json', 'the normal set wins');
  assert.deepEqual(await lib.texInfo(), { ct: { wrap: 2 }, nt: { wrap: 1 } });
  // off again: dropped
  layers.collab = null;
  assert.equal(lib.has('ash_buff_01_hit'), false);
  assert.equal((await lib.index()).units.char_456_ash, undefined);
  assert.equal(fetched.filter((u) => u === '/data/local-fx-collab.json').length, 1, 'the list is fetched once per library');
  // a list naming a file outside the pack is refused
  const bad = new FxLibrary({ list, layers: { collab: {} }, fetch: async (url) => (url === '/data/local-fx-collab.json'
    ? { ok: true, json: async () => ({ groups: { 'fx/prefabs': { x: { path: '/assets/local/fx/prefabs/x.json' } } } }) } : fetch(url)) });
  await bad.index();
  assert.equal(bad.has('x'), false);
});
