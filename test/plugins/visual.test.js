// test/plugins/visual.test.js — the cosmetic plugins' format (DESIGN §32 P1a, shared/plugins/visual.js): an asset overlay
// read into ops (the containers and fields of data/assets.json, a plugin's own files by extension, Spine models next to
// their atlas, whole-record and field references to the installation's manifest — a missing one is a problem —, the
// permissions a write needs), plugin.lock.json and a model's clip data (a stale lock refused), resolution (a file's
// /p/<id>/<hash8>/ URL, one hash for every file of a model, a reference copied from the manifest it reads), applyOps
// (a value written whole, nothing changed in place), the merge of several plugins (the later one applies, an override
// warning), the visual hash `vs` (the same input → the same hash, one changed byte → another) and the check a browser
// runs on a served document.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ASSET_CONTAINERS, VISUAL_HASH_VERSION, VISUAL_LIMITS, applyOps, attachSpineMeta, checkVisualDoc, getPath, isAssetKey, mergePluginOps,
  modelHashOf, pluginFileUrl, readAssetOverlay, readPluginLock, resolveOps, visualHashInput, visualHashOf, vsUrlPart,
} from '../../shared/plugins/visual.js';
import { canonicalJson } from '../../shared/plugins/identity.js';
import { sha256Hex } from '../../shared/sha256.js';

const VANILLA = {
  version: 1, hash: 'abc',
  chars: {
    char_102_texas: { avatar: '/assets/~1111111111111111/char/avatar/texas.png', portrait: '/assets/char/portrait/texas_1.png',
      spine: { front: { skel: '/assets/~2222222222222222/spine/op/texas/front/t.skel', atlas: '/assets/~2222222222222222/spine/op/texas/front/t.atlas', textures: ['/assets/~2222222222222222/spine/op/texas/front/t.png'], pma: false, anims: { idle: 'Idle' } } } },
    char_112_siege: { avatar: '/assets/char/avatar/siege.png', avatarE2: '/assets/char/avatar/siege_2.png', portrait: '/assets/char/portrait/siege_1.png' },
  },
  ui: { 'hudPanel/icon_hp': '/assets/ui/hp.png', 'hudPanel/icon_lp': '/assets/ui/lp.png' },
  audio: { voice: { char_102_texas: { skill1: '/assets/audio/voice/cn/texas/s1.mp3' }, char_112_siege: { skill1: '/assets/audio/voice/cn/siege/s1.mp3', select: ['/a.mp3', '/b.mp3'] } },
    bgm: { lobby: { loop: '/assets/audio/bgm/lobby.mp3' } } },
};
const FILES = new Set(['art/a.png', 'art/b.webp', 'v/s1.mp3', 'v/s2.ogg', 'spine/front/t.skel', 'spine/front/t.atlas', 'spine/front/t.png', 'spine/front/t2.png', 'other/x.png', 'other/x.atlas']);
const has = (rel) => FILES.has(rel);
const sha = (rel) => sha256Hex(`bytes of ${rel}`);
const read = (assets, ctx = {}) => readAssetOverlay(assets, { vanilla: VANILLA, permissions: ['assets.override', 'assets.add'], has, ...ctx });

describe('reading an overlay', () => {
  test('the containers and fields of data/assets.json → ops in the plugin\'s order; its files and models', () => {
    const r = read({
      chars: { char_102_texas: { avatar: 'art/a.png', spine: { front: { skel: 'spine/front/t.skel', anims: 'auto' } } } },
      ui: { 'hudPanel/icon_hp': 'art/b.webp' },
      audio: { voice: { char_102_texas: { skill1: 'v/s1.mp3', select: ['v/s1.mp3', 'v/s2.ogg'] } }, bgm: { lobby: { loop: 'v/s2.ogg' } } },
      prof: { icon: { sniper: 'other/x.png' } },
    });
    assert.deepEqual([r.problems, r.warnings], [[], []]);
    assert.deepEqual(r.ops.map((o) => o.at.join('.')), [
      'chars.char_102_texas.avatar', 'chars.char_102_texas.spine.front', 'ui.hudPanel/icon_hp', 'audio.voice.char_102_texas.skill1',
      'audio.voice.char_102_texas.select', 'audio.bgm.lobby', 'prof.icon.sniper',
    ]);
    assert.deepEqual(r.ops[5].track, { loop: 'v/s2.ogg' }, 'a track is written whole');
    assert.deepEqual(r.ops[1].spine, { skel: 'spine/front/t.skel', atlas: 'spine/front/t.atlas', textures: ['spine/front/t.png'], pma: false }, 'the atlas and page by the skeleton\'s name');
    assert.deepEqual(r.ops[4].files, ['v/s1.mp3', 'v/s2.ogg']);
    assert.deepEqual(r.files, ['art/a.png', 'spine/front/t.skel', 'spine/front/t.atlas', 'spine/front/t.png', 'art/b.webp', 'v/s1.mp3', 'v/s2.ogg', 'other/x.png']);
    assert.deepEqual(r.models, [['spine/front/t.skel', 'spine/front/t.atlas', 'spine/front/t.png']]);
  });

  test('references: a whole record (replaced as a whole, other keys change fields of it) or one field — of the same container', () => {
    const r = read({ chars: {
      char_102_texas: { ref: 'char_112_siege', avatar: 'art/a.png' },
      char_x_new: { portrait: { ref: 'char_112_siege' } },
    }, audio: { voice: { char_102_texas: { select: { ref: 'char_112_siege' } } } }, ui: { 'hudPanel/icon_hp': { ref: 'hudPanel/icon_lp' } } });
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.ops.map((o) => [o.at.join('.'), o.ref ?? o.file, o.from?.join('.')]), [
      ['chars.char_102_texas', 'char_112_siege', 'chars.char_112_siege'],
      ['chars.char_102_texas.avatar', 'art/a.png', undefined],
      ['chars.char_x_new.portrait', 'char_112_siege', 'chars.char_112_siege.portrait'],
      ['audio.voice.char_102_texas.select', 'char_112_siege', 'audio.voice.char_112_siege.select'],
      ['ui.hudPanel/icon_hp', 'hudPanel/icon_lp', 'ui.hudPanel/icon_lp'],
    ]);
    assert.deepEqual(r.files, ['art/a.png'], 'a reference serves no file of the plugin');
  });

  test('a reference the installation\'s manifest does not have is a problem (unchecked without the manifest)', () => {
    const r = read({ chars: { char_102_texas: { ref: 'char_999_none' }, char_112_siege: { avatarE2: { ref: 'char_102_texas' } } } });
    assert.equal(r.problems.length, 2, r.problems.join('\n'));
    assert.match(r.problems[0], /assets\.chars\.char_102_texas: \{ "ref": "char_999_none" \} — this installation's art manifest \(data\/assets\.json\) has no chars\.char_999_none/);
    assert.match(r.problems[1], /has no chars\.char_102_texas\.avatarE2/, 'a field reference needs that field');
    assert.deepEqual(readAssetOverlay({ chars: { char_102_texas: { ref: 'char_999_none' } } }).problems, [], 'no manifest: not checked');
    assert.match(read({ chars: { char_102_texas: { avatar: { ref: '__proto__' } } } }).problems.join(), /does not name an entry/);
    assert.match(read({ ui: { 'hudPanel/icon_hp': { ref: 'hudPanel/icon_lp', extra: 1 } } }).problems.join(), /a reference to a image takes no other key/);
  });

  test('files: plain paths inside the folder, of the field\'s kind, present; Spine models side by side; no clip data by hand', () => {
    const bad = (assets) => read(assets).problems.join('\n');
    assert.match(bad({ chars: { char_102_texas: { avatar: '../a.png' } } }), /"\.\.\/a\.png" is not a path inside the plugin folder/);
    assert.match(bad({ chars: { char_102_texas: { avatar: '/assets/char/avatar/x.png' } } }), /is not a path inside the plugin folder/, 'never another URL of the server');
    assert.match(bad({ chars: { char_102_texas: { avatar: 'https://example.com/a.png' } } }), /is not a path inside the plugin folder/, 'never another host');
    assert.match(bad({ chars: { char_102_texas: { avatar: 'v/s1.mp3' } } }), /v\/s1\.mp3 is not \.png \/ \.jpg \/ \.webp/);
    assert.match(bad({ audio: { sfx: { ui: { click: 'art/a.png' } } } }), /art\/a\.png is not \.mp3 \/ \.ogg/);
    assert.match(bad({ chars: { char_102_texas: { avatar: 'art/missing.png' } } }), /art\/missing\.png is missing/);
    assert.match(bad({ chars: { char_102_texas: { avatar: 5 } } }), /5 is not a path/, 'never a number in the manifest');
    assert.match(bad({ chars: { char_102_texas: { spine: { front: { skel: 'spine/front/t.skel', atlas: 'other/x.atlas' } } } } }), /other\/x\.atlas — the atlas sits next to its skeleton with the same name \(spine\/front\/t\.atlas\)/);
    assert.match(bad({ chars: { char_102_texas: { spine: { front: { skel: 'spine/front/t.skel', textures: ['art/a.png'] } } } } }), /outside the atlas's folder/);
    assert.match(bad({ chars: { char_102_texas: { spine: { front: { skel: 'spine/front/t.skel', anims: { idle: 'Idle' } } } } } }), /come from plugin\.lock\.json/);
    assert.match(bad({ chars: { char_102_texas: { spine: { front: { skel: 'spine/front/t.skel', hits: {} } } } } }), /come from plugin\.lock\.json/);
    const ok = read({ chars: { char_102_texas: { spine: { front: { skel: 'spine/front/t.skel', textures: ['spine/front/t.png', 'spine/front/t2.png'], pma: true } } } } });
    assert.deepEqual([ok.problems, ok.ops[0].spine.textures, ok.ops[0].spine.pma], [[], ['spine/front/t.png', 'spine/front/t2.png'], true]);
    assert.match(bad({ audio: { voice: { char_102_texas: { select: Array.from({ length: VISUAL_LIMITS.listFiles + 1 }, () => 'v/s1.mp3') } } } }), /a list of 1–16/);
  });

  test('a track is written whole (a loop alone plays without the installation\'s intro); an enemy\'s or a token\'s model takes its local-client model away', () => {
    const vanilla = { ...VANILLA, enemies: { enemy_1305_mhslim: { icon: '/assets/e.png', spine: { skel: '/assets/e.skel' }, spineLocal: { group: 'spine/enemy/enemy_1305_mhslim' } },
      enemy_1007_slime: { icon: '/assets/s.png', spine: { skel: '/assets/s.skel' } } }, audio: { ...VANILLA.audio, bgm: { lobby: { intro: '/assets/i.mp3', loop: '/assets/l.mp3' } } } };
    const r = readAssetOverlay({
      audio: { bgm: { lobby: { loop: 'v/s1.mp3' }, prep: { intro: 'v/s1.mp3', loop: 'v/s2.ogg', extra: 'x' } } },
      enemies: { enemy_1305_mhslim: { spine: { skel: 'spine/front/t.skel' } }, enemy_1007_slime: { spine: { ref: 'enemy_1305_mhslim' } }, enemy_x: { ref: 'enemy_1305_mhslim' } },
    }, { vanilla, permissions: ['assets.override', 'assets.add'], has });
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.warnings, ['assets.audio.bgm.prep.extra is not a field of a track (ignored)']);
    assert.deepEqual(r.ops.map((o) => [o.at.join('.'), o.track ? 'track' : o.spine ? 'spine' : o.ref ? 'ref' : o.clear ? 'clear' : '?']), [
      ['audio.bgm.lobby', 'track'], ['audio.bgm.prep', 'track'],
      ['enemies.enemy_1305_mhslim.spine', 'spine'], ['enemies.enemy_1305_mhslim.spineLocal', 'clear'],
      ['enemies.enemy_1007_slime.spine', 'ref'], ['enemies.enemy_1007_slime.spineLocal', 'clear'],
      ['enemies.enemy_x', 'ref'],
    ], 'a whole-record reference takes the referenced record as it is');
    const lock = readPluginLock({ lock: 1, spine: { 'spine/front/t.skel': { sha256: sha('spine/front/t.skel'), anims: { idle: 'Idle' }, animations: { Idle: 1 }, events: [], hits: {}, bounds: null } } }).lock;
    const res = resolveOps(attachSpineMeta(r.ops, lock, sha).ops, { id: 'p', sha, base: vanilla });
    assert.deepEqual(res.problems, []);
    const { ops } = res;
    const out = applyOps(vanilla, ops);
    assert.deepEqual(out.audio.bgm.lobby, { loop: `/p/p/${sha('v/s1.mp3').slice(0, 8)}/v/s1.mp3` }, 'no intro left behind');
    assert.deepEqual(Object.keys(out.audio.bgm.prep), ['intro', 'loop']);
    assert.equal('spineLocal' in out.enemies.enemy_1305_mhslim, false, 'the plugin\'s model is drawn, not the local one');
    assert.equal(JSON.parse(JSON.stringify(out)).enemies.enemy_1305_mhslim.spineLocal, undefined);
    assert.deepEqual(out.enemies.enemy_x.spineLocal, vanilla.enemies.enemy_1305_mhslim.spineLocal);
    assert.equal(vanilla.enemies.enemy_1305_mhslim.spineLocal.group, 'spine/enemy/enemy_1305_mhslim', 'the base untouched');
    assert.match(readAssetOverlay({ audio: { bgm: { lobby: { intro: 'v/s1.mp3' } } } }).problems.join(), /not a track \{ "loop", "intro"\? \}/);
    // two plugins writing one model: one warning (the implied clear is no override of its own)
    const twice = mergePluginOps([{ id: 'a', ops: r.ops.slice(2, 4) }, { id: 'b', ops: r.ops.slice(2, 4) }]);
    assert.deepEqual(twice.warnings, [{ code: 'override', params: { path: 'enemies.enemy_1305_mhslim.spine', plugins: ['a', 'b'] } }]);
    assert.equal(twice.ops.length, 4);
  });

  test('what a cosmetic plugin does not change is a warning and left out', () => {
    const r = read({ fonts: { css: 'f.css' }, skillsById: { a: 'b' }, chars: { char_102_texas: { owner: 'x', avatar: 'art/a.png' } }, audio: { bgm: { combatAlts: [] } } });
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.ops.map((o) => o.at.join('.')), ['chars.char_102_texas.avatar']);
    assert.deepEqual(r.warnings, [
      'assets.fonts is not something a cosmetic plugin changes (ignored)',
      'assets.skillsById is not something a cosmetic plugin changes (ignored)',
      'assets.chars.char_102_texas.owner is not a field a cosmetic plugin changes (ignored)',
      'assets.audio.bgm.combatAlts is not one of lobby, prep, combat, unite, boss (ignored)',
    ]);
    assert.match(read({ chars: { 'bad key!': { avatar: 'art/a.png' } } }).problems.join(), /is not an entry key/);
    assert.match(read([]).problems.join(), /not an object in the shape of data\/assets\.json/);
  });

  test('what references copy out of the installation\'s manifest is counted and capped (2 MB a plugin)', () => {
    const big = { chars: Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`char_${i}`, { avatar: `/assets/${'x'.repeat(400 * 1024)}.png` }])) };
    const fine = readAssetOverlay({ chars: { char_new: { ref: 'char_0' } } }, { vanilla: big, permissions: ['assets.add'] });
    assert.deepEqual(fine.problems, []);
    assert.ok(fine.copyBytes > 400 * 1024 && fine.copyBytes < 410 * 1024, String(fine.copyBytes));
    const many = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`char_n${i}`, { ref: `char_${i % 3}` }]));
    const r = readAssetOverlay({ chars: many }, { vanilla: big, permissions: ['assets.add'] });
    assert.match(r.problems.join(), /its references copy 2\.\d MB of this installation's manifest, more than 2 MB/);
    assert.equal(readAssetOverlay({ chars: many }).copyBytes, 0, 'without the manifest nothing is counted');
  });

  test('permissions: changing an entry of the installation needs assets.override, a new one assets.add', () => {
    const assets = { chars: { char_102_texas: { avatar: 'art/a.png' }, char_x_new: { avatar: 'art/a.png' } } };
    assert.deepEqual(read(assets, { permissions: ['assets.override', 'assets.add'] }).problems, []);
    assert.match(read(assets, { permissions: ['assets.add'] }).problems.join(), /changes an entry of this installation's manifest — needs the permission "assets\.override"/);
    assert.match(read(assets, { permissions: ['assets.override'] }).problems.join(), /adds an entry — needs the permission "assets\.add"/);
  });

  test('the containers: every one is a path of data/assets.json\'s schema; keys are plain and never Object.prototype\'s', () => {
    assert.deepEqual(ASSET_CONTAINERS.map((c) => c.path.join('.')), ['chars', 'enemies', 'tokens', 'bonds', 'items', 'bands', 'skills', 'modules', 'ui',
      'prof.icon', 'prof.large', 'prof.battlecard', 'prof.sub', 'audio.bgm', 'audio.bossBgm', 'audio.voice', 'audio.voiceJp', 'audio.sfx.ui', 'audio.sfx.battle', 'audio.sfx.units']);
    for (const k of ['char_102_texas', 'hudPanel/icon_hp', 'sol-x', 'emoticon/basic/pic_happy_battle']) assert.ok(isAssetKey(k), k);
    for (const k of ['', '__proto__', 'constructor', 'a b', '/x', 'x'.repeat(129)]) assert.ok(!isAssetKey(k), k);
  });
});

describe('plugin.lock.json and the models\' clip data', () => {
  const meta = { anims: { idle: 'Idle', attack: { begin: null, loop: 'Attack', end: null } }, animations: { Idle: 1, Attack: 0.5 }, events: ['OnAttack'], hits: { Attack: [0.5] }, bounds: { x: 0, y: 0, width: 10, height: 10 } };
  const lockOf = (skelSha = sha('spine/front/t.skel')) => ({ lock: 1, id: 'p', version: '1.0.0', files: { 'art/a.png': { sha256: sha('art/a.png'), bytes: 9 } }, spine: { 'spine/front/t.skel': { sha256: skelSha, ...meta } } });
  const ops = read({ chars: { char_102_texas: { spine: { front: { skel: 'spine/front/t.skel' } } } } }).ops;

  test('a lock gives a model its clip data; a missing or stale one is a problem', () => {
    const { lock, problems } = readPluginLock(lockOf());
    assert.deepEqual(problems, []);
    const a = attachSpineMeta(ops, lock, sha);
    assert.deepEqual([a.problems, a.ops[0].spine.meta], [[], meta]);
    assert.notEqual(a.ops, ops, 'new ops, the old ones unchanged');
    assert.equal(ops[0].spine.meta, undefined);
    assert.match(attachSpineMeta(ops, null, sha).problems.join(), /plugin\.lock\.json has no clip data for spine\/front\/t\.skel — run node tools\/plugin\.mjs pack/);
    const stale = readPluginLock(lockOf('ff'.repeat(32))).lock;
    assert.match(attachSpineMeta(ops, stale, sha).problems.join(), /was made from another spine\/front\/t\.skel — run node tools\/plugin\.mjs pack again/);
  });

  test('a lock\'s clip data is rebuilt in the pack tool\'s shape: nothing a hand-made lock adds reaches a browser', () => {
    const good = { sha256: 'ab'.repeat(32), anims: { idle: 'Idle', deploy: null, attack: { begin: null, loop: 'Attack', end: null, via: 'attack' },
      skill: { begin: null, loop: 'Attack', end: null, index: 0, idle: null }, skills: { 1: { begin: null, loop: 'Skill', end: null, index: 1, idle: 'Idle' } } },
    animations: { Idle: 1, Attack: 0.5, Skill: 2 }, events: ['OnAttack'], hits: { Attack: [0.25] }, bounds: { x: 1, y: 2, width: 3, height: 4, extra: '<img>' } };
    const ok = readPluginLock({ lock: 1, spine: { 'm/t.skel': good } });
    assert.deepEqual(ok.problems, []);
    const meta = ok.lock.spine['m/t.skel'];
    assert.deepEqual(meta.bounds, { x: 1, y: 2, width: 3, height: 4 }, 'only the four numbers');
    assert.deepEqual(meta.anims.skills, { 1: { begin: null, loop: 'Skill', end: null, index: 1, idle: 'Idle' } });
    const refused = (patch, why) => {
      const r = readPluginLock({ lock: 1, spine: { 'm/t.skel': { ...good, ...patch } } });
      assert.equal(r.lock, null, why);
      assert.match(r.problems.join(), /is not the clip data of a skeleton/, why);
    };
    refused({ anims: { ...good.anims, '<img src=x onerror=alert(1)>': 'Idle' } }, 'an unknown role');
    refused({ anims: { ...good.anims, idle: 'Nope' } }, 'a clip the skeleton has not');
    refused({ anims: { ...good.anims, attack: 12345 } }, 'a role that is no clip');
    refused({ anims: { ...good.anims, attack: { loop: 'Attack', via: 'teleport' } } }, 'an unknown via');
    refused({ anims: { deploy: 'Idle' } }, 'no idle');
    refused({ events: ['x'.repeat(200000)] }, 'a huge event name');
    refused({ events: Array.from({ length: 65 }, (_, i) => `e${i}`) }, 'too many events');
    refused({ animations: { ['A'.repeat(100000)]: 1, Idle: 1, Attack: 1, Skill: 1 } }, 'a huge animation name');
    refused({ animations: { Idle: 1e6, Attack: 1, Skill: 1 } }, 'a duration beyond 600 s');
    refused({ hits: { Elsewhere: [0.1] } }, 'hits of a clip the skeleton has not');
    let deep = 'Idle';
    for (let i = 0; i < 20000; i++) deep = { loop: deep };
    refused({ anims: { idle: 'Idle', attack: deep } }, 'nesting');
    const proto = readPluginLock(JSON.parse('{"lock":1,"files":{"__proto__":{"sha256":"' + 'ab'.repeat(32) + '","bytes":1}}}'));
    assert.equal(proto.lock, null, 'a path through a name of Object.prototype');
    assert.equal(({}).sha256, undefined);
    assert.equal(Object.getPrototypeOf(ok.lock.spine), null, 'the maps have no prototype');
  });

  test('a broken lock is a problem', () => {
    for (const raw of [null, [], { lock: 2 }, { lock: 1, files: { '../x': { sha256: 'a', bytes: 1 } } }, { lock: 1, spine: { 'a.skel': { sha256: 'aa'.repeat(32), anims: 'x' } } }]) {
      const r = readPluginLock(raw);
      assert.equal(r.lock, null, JSON.stringify(raw));
      assert.match(r.problems.join(), /write it again with node tools\/plugin\.mjs pack/);
    }
  });
});

describe('resolution, merge, application', () => {
  test('a file → /p/<id>/<its first 8 hex>/<path>; every file of a model → the model\'s hash; a reference → a copy of the base\'s value', () => {
    const r0 = read({ chars: { char_102_texas: { avatar: 'art/a.png', spine: { front: { skel: 'spine/front/t.skel' } } }, char_112_siege: { ref: 'char_102_texas' } },
      audio: { voice: { char_102_texas: { select: ['v/s1.mp3', 'v/s2.ogg'] } } } });
    const lock = readPluginLock({ lock: 1, spine: { 'spine/front/t.skel': { sha256: sha('spine/front/t.skel'), anims: { idle: 'Idle' }, animations: { Idle: 1 }, events: [], hits: {}, bounds: null } } }).lock;
    const { ops } = attachSpineMeta(r0.ops, lock, sha);
    const { ops: out, problems } = resolveOps(ops, { id: 'my-skin', sha, base: VANILLA });
    assert.deepEqual(problems, []);
    assert.equal(out[0].value, `/p/my-skin/${sha('art/a.png').slice(0, 8)}/art/a.png`);
    const m = modelHashOf(['spine/front/t.skel', 'spine/front/t.atlas', 'spine/front/t.png'].map(sha)).slice(0, 8);
    assert.deepEqual(out[1].value, {
      skel: `/p/my-skin/${m}/spine/front/t.skel`, atlas: `/p/my-skin/${m}/spine/front/t.atlas`, textures: [`/p/my-skin/${m}/spine/front/t.png`], pma: false,
      anims: { idle: 'Idle' }, animations: { Idle: 1 }, events: [], hits: {}, bounds: null,
    }, 'pixi-spine finds the atlas next to the skeleton and the pages next to the atlas: one folder');
    assert.deepEqual(out[2].value, VANILLA.chars.char_102_texas);
    assert.notEqual(out[2].value, VANILLA.chars.char_102_texas, 'a copy');
    assert.deepEqual(out[3].value, [`/p/my-skin/${sha('v/s1.mp3').slice(0, 8)}/v/s1.mp3`, `/p/my-skin/${sha('v/s2.ogg').slice(0, 8)}/v/s2.ogg`]);
    assert.equal(pluginFileUrl('p', '01234567', 'a b/c.png'), '/p/p/01234567/a%20b/c.png', 'every segment encoded');
    const missing = resolveOps([{ at: ['chars', 'x'], ref: 'y', from: ['chars', 'y'] }], { id: 'p', sha, base: VANILLA });
    assert.deepEqual([missing.ops, missing.problems.length], [[], 1]);
  });

  test('applyOps: each value written whole at its path, the objects on the way copied — nothing changed in place', () => {
    const base = JSON.parse(JSON.stringify(VANILLA));
    const frozen = JSON.stringify(base);
    const whole = { avatar: '/x.png' };
    const out = applyOps(base, [
      { at: ['chars', 'char_102_texas'], value: whole },
      { at: ['chars', 'char_102_texas', 'portrait'], value: '/y.png' },
      { at: ['chars', 'char_x_new', 'spine', 'front'], value: { skel: '/n.skel' } },
      { at: ['__proto__', 'polluted'], value: true },
      { at: ['chars', 'constructor'], value: 1 },
    ]);
    assert.equal(JSON.stringify(base), frozen, 'the base is untouched');
    assert.deepEqual(whole, { avatar: '/x.png' }, 'an op\'s value is copied before a later op writes into it');
    assert.deepEqual(out.chars.char_102_texas, { avatar: '/x.png', portrait: '/y.png' }, 'the whole record replaced, then a field of it');
    assert.deepEqual(out.chars.char_x_new, { spine: { front: { skel: '/n.skel' } } });
    assert.equal(out.chars.char_112_siege, base.chars.char_112_siege, 'what no op touches is shared');
    assert.equal(out.ui, base.ui);
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.hasOwn(out.chars, 'constructor'), false);
  });

  test('merge: the later plugin applies; an override warning names the path and both plugins (also one inside the other)', () => {
    const a = [{ at: ['chars', 'char_102_texas', 'avatar'], value: '/a.png' }, { at: ['ui', 'hudPanel/icon_hp'], value: '/a-hp.png' }];
    const b = [{ at: ['chars', 'char_102_texas', 'avatar'], value: '/b.png' }];
    const c = [{ at: ['chars', 'char_102_texas'], value: { avatar: '/c.png' } }, { at: ['ui', 'hudPanel/icon_lp'], value: '/c-lp.png' }];
    const m = mergePluginOps([{ id: 'a', ops: a }, { id: 'b', ops: b }, { id: 'c', ops: c }]);
    assert.deepEqual(m.ops.map((o) => o.value), ['/a.png', '/a-hp.png', '/b.png', { avatar: '/c.png' }, '/c-lp.png'], 'in load order');
    assert.deepEqual(m.warnings, [
      { code: 'override', params: { path: 'chars.char_102_texas.avatar', plugins: ['a', 'b'] } },
      { code: 'override', params: { path: 'chars.char_102_texas', plugins: ['b', 'c'] } },
    ]);
    assert.equal(applyOps(VANILLA, mergePluginOps([{ id: 'a', ops: a }, { id: 'b', ops: b }]).ops).chars.char_102_texas.avatar, '/b.png');
    assert.deepEqual(mergePluginOps([{ id: 'a', ops: [...a, ...a] }]).warnings, [], 'a plugin never conflicts with itself');
    const many = Array.from({ length: 40 }, (_, i) => ({ at: ['ui', `k${i}`], value: '/x.png' }));
    assert.equal(mergePluginOps([{ id: 'a', ops: many }, { id: 'b', ops: many }]).warnings.length, VISUAL_LIMITS.warnings);
  });
});

describe('the visual hash vs', () => {
  const overlay = (files) => ({ id: 'texas-recolor', version: '1.0.0', files });
  const parts = { assets: 'aa'.repeat(32), overlays: [overlay({ 'plugin.json': 'bb'.repeat(32), 'art/a.png': 'cc'.repeat(32) })] };

  test('sha256 of the canonical { v, assets, overlays }; the same input → the same hash, in any key order', () => {
    const vs = visualHashOf(parts);
    assert.match(vs, /^[0-9a-f]{64}$/);
    assert.equal(vs, sha256Hex(canonicalJson({ v: VISUAL_HASH_VERSION, assets: parts.assets, overlays: parts.overlays })));
    assert.equal(vs, createHash('sha256').update(canonicalJson(visualHashInput(parts))).digest('hex'), 'node:crypto agrees');
    assert.equal(visualHashOf({ overlays: [overlay({ 'art/a.png': 'cc'.repeat(32), 'plugin.json': 'bb'.repeat(32) })], assets: parts.assets }), vs);
    assert.equal(vsUrlPart(vs), vs.slice(0, 16));
  });

  test('one changed byte of any part → another vs: a file, data/assets.json, a version, the load order', () => {
    const vs = visualHashOf(parts);
    const variants = [
      { ...parts, assets: 'ab'.repeat(32) },
      { ...parts, overlays: [overlay({ 'plugin.json': 'bb'.repeat(32), 'art/a.png': `c${'c'.repeat(62)}d` })] },
      { ...parts, overlays: [{ ...parts.overlays[0], version: '1.0.1' }] },
      { ...parts, overlays: [...parts.overlays, overlay({})] },
      { ...parts, overlays: [overlay({}), ...parts.overlays] },
      { ...parts, overlays: [] },
    ];
    for (const v of variants) assert.notEqual(visualHashOf(v), vs, JSON.stringify(v).slice(0, 120));
  });

  test('checkVisualDoc: the composition of a served document hashes to the vs the room named', () => {
    const vs = visualHashOf(parts);
    const doc = { chars: {}, visual: { v: 1, vs, assets: parts.assets, overlays: parts.overlays } };
    assert.equal(checkVisualDoc(doc, vs), null);
    assert.match(checkVisualDoc(doc, 'ee'.repeat(32)), /names another set/);
    assert.match(checkVisualDoc({ visual: { ...doc.visual, overlays: [] } }, vs), /does not hash to its vs/);
    assert.match(checkVisualDoc({ chars: {} }, vs), /not a visual set document/);
    assert.match(checkVisualDoc(doc, 'short'), /no visual hash/);
    assert.match(checkVisualDoc({ visual: { ...doc.visual, overlays: [null] } }, vs), /not plain data/);
  });

  test('getPath reads own properties only', () => {
    assert.equal(getPath(VANILLA, ['chars', 'char_112_siege', 'avatar']), '/assets/char/avatar/siege.png');
    assert.equal(getPath(VANILLA, ['chars', 'toString']), undefined);
    assert.equal(getPath(VANILLA, ['chars', 'char_112_siege', 'avatar', 'length']), undefined);
  });
});
