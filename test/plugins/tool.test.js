// test/plugins/tool.test.js — tools/plugin.mjs pack and the cosmetic template (DESIGN §32 P1a): pack writes
// plugin.lock.json — every file's SHA-256 and size, each Spine model's clip data parsed from the skeleton the way the
// game's own models are (roles, durations, events, hits, bounds) — and checks the folder; an atlas page `textures` does
// not name refuses the lock; a skeleton changed after the pack is refused until it is packed again; `check` follows a
// cosmetic plugin's references to this checkout's data/assets.json; plugins/_template/cosmetic/ is a valid cosmetic
// plugin made of references only — no file of the game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { main, buildPluginLock } from '../../tools/plugin.mjs';
import { readPluginFolder, readVanillaAssets, listPluginFiles } from '../../server/plugins/registry.js';
import { png, skel, atlas, writePlugin, cosmetic } from '../helpers/pluginFixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const quiet = async (argv) => {
  const out = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try { return { code: await main(argv), out: out.join('\n') }; } finally { console.log = log; console.error = err; }
};

test('pack writes plugin.lock.json: the files\' hashes and each model\'s clip data; then the plugin loads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-pack-'));
  try {
    const p = writePlugin(path.join(dir, 'texas-red'), cosmetic({ assets: { chars: { char_102_texas: { spine: { front: { skel: 'spine/t.skel' } } }, char_112_siege: { avatar: 'a.png' } } } }), {
      'spine/t.skel': skel({ animations: { Idle: [['OnStart', 2]], Attack: [['OnAttack', 0.3], ['OnAttack', 0.6]], Skill_2_Loop: [['OnAttack', 0.4]] } }),
      'spine/t.atlas': atlas(['t.png']), 'spine/t.png': png(4, 4), 'a.png': png(2, 2), 'README.md': '# texas\n',
    });
    // before the pack: the model has no clip data, the plugin is kept out
    assert.match(readPluginFolder(p).problems.join(), /plugin\.lock\.json has no clip data for spine\/t\.skel/);
    const r = await quiet(['pack', p, '--root', ROOT]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /wrote plugin\.lock\.json \(6 files, 1 Spine model\)/);
    const lock = JSON.parse(fs.readFileSync(path.join(p, 'plugin.lock.json'), 'utf8'));
    assert.deepEqual([lock.lock, lock.id, lock.version, lock.generator], [1, 'texas-red', '1.0.0', 'tools/plugin.mjs pack']);
    assert.deepEqual(Object.keys(lock.files).sort(), ['README.md', 'a.png', 'plugin.json', 'spine/t.atlas', 'spine/t.png', 'spine/t.skel']);
    assert.equal(lock.files['a.png'].sha256, sha(fs.readFileSync(path.join(p, 'a.png'))));
    const s = lock.spine['spine/t.skel'];
    assert.equal(s.sha256, sha(fs.readFileSync(path.join(p, 'spine/t.skel'))));
    assert.deepEqual([s.anims.idle, s.anims.attack.loop, s.anims.skill.loop, s.anims.skills['1'].loop], ['Idle', 'Attack', 'Attack', 'Skill_2_Loop'], 'an operator: its three skill slots');
    assert.deepEqual([s.animations, s.events, s.hits, s.bounds], [{ Idle: 2, Attack: 0.6, Skill_2_Loop: 0.4 }, ['OnStart', 'OnAttack'], { Attack: [0.3, 0.6], Skill_2_Loop: [0.4] }, { x: -50, y: 0, width: 100, height: 120 }]);
    const loaded = readPluginFolder(p, { vanilla: readVanillaAssets(path.join(ROOT, 'data')) });
    assert.deepEqual(loaded.problems, []);
    assert.deepEqual(loaded.plugin.visual.ops.find((o) => o.spine).spine.meta.hits, { Attack: [0.3, 0.6], Skill_2_Loop: [0.4] });
    // the skeleton changed after the pack: refused until it is packed again
    fs.writeFileSync(path.join(p, 'spine/t.skel'), skel({ animations: { Idle: [['OnStart', 1]] } }));
    assert.match(readPluginFolder(p).problems.join(), /plugin\.lock\.json was made from another spine\/t\.skel — run node tools\/plugin\.mjs pack again/);
    assert.equal((await quiet(['pack', p])).code, 0);
    assert.deepEqual(readPluginFolder(p).problems, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pack refuses an atlas page the model does not list, a skeleton the client cannot read, and a folder without plugin.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-pack-'));
  try {
    const p = writePlugin(path.join(dir, 'pages'), cosmetic({ assets: { chars: { char_102_texas: { spine: { front: { skel: 'm/t.skel' } } } } } }), {
      'm/t.skel': skel(), 'm/t.atlas': atlas(['t.png', 't2.png']), 'm/t.png': png(), 'm/t2.png': png(),
    });
    const r = await quiet(['pack', p]);
    assert.equal(r.code, 1);
    assert.match(r.out, /m\/t\.atlas: its page m\/t2\.png is not in "textures"/);
    assert.match(r.out, /plugin\.lock\.json not written/);
    assert.equal(fs.existsSync(path.join(p, 'plugin.lock.json')), false);
    const junk = writePlugin(path.join(dir, 'junk'), cosmetic({ assets: { chars: { char_102_texas: { spine: { front: { skel: 'j.skel' } } } } } }), {
      'j.skel': 'not a skeleton', 'j.atlas': atlas(['j.png']), 'j.png': png(),
    });
    assert.match(buildPluginLock(junk).problems.join(), /j\.skel: not a Spine 3\.8 skeleton the client can read/);
    assert.equal((await quiet(['pack', path.join(dir, 'nothing-here')])).code, 2);
    assert.equal((await quiet(['pack'])).code, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('check follows a cosmetic plugin\'s references to this checkout\'s data/assets.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-check-'));
  try {
    const p = writePlugin(path.join(dir, 'refs'), cosmetic({ assets: { chars: { char_102_texas: { avatar: { ref: 'char_000_nobody' } } } } }));
    const r = await quiet(['check', p, '--root', ROOT]);
    assert.equal(r.code, 1);
    assert.match(r.out, /\{ "ref": "char_000_nobody" \} — this installation's art manifest \(data\/assets\.json\) has no chars\.char_000_nobody\.avatar/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the cosmetic template: references only, no file of the game; valid against this checkout\'s manifest', async () => {
  const tpl = path.join(ROOT, 'plugins', '_template', 'cosmetic');
  assert.deepEqual(listPluginFiles(tpl).map((f) => f.rel).sort(), ['README.md', 'plugin.json'], 'no art file in the template');
  const r = readPluginFolder(tpl, { vanilla: readVanillaAssets(path.join(ROOT, 'data')) });
  assert.deepEqual([r.problems, r.warnings], [[], []]);
  assert.equal(r.plugin.class, 'cosmetic');
  assert.ok(r.plugin.visual.ops.length > 0 && r.plugin.visual.ops.every((o) => o.ref), 'every write a reference');
  assert.equal(r.plugin.visual.served.size, 0, 'it serves no file');
  const m = JSON.parse(fs.readFileSync(path.join(tpl, 'plugin.json'), 'utf8'));
  assert.equal(m.id, undefined, 'the folder name decides the id: a copy needs no edit of it');
  assert.equal((await quiet(['check', tpl])).code, 0);
});
