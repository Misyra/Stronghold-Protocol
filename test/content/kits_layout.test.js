// The operator kit layout (server/sim/content/kits/README.md): every file of kits/ops/ is listed once in kits/index.js
// KIT_FILES or STANDIN_KIT_FILES and nothing else is; a file `<chessId>-<codename>.js` registers exactly the kit of
// `<chessId>_a`, whose data record has that charId code name; a 补位 file `standin-<codename>.js` registers exactly the
// kit of the stand-in character whose charId has that code name (data/backups.json `units`); the registry is the tier
// groups in order, then the stand-ins, and content/index.js serves that object; no kit file imports a Node-only or
// server-only module or reads the clock / Math.random (the sim is deterministic and also runs in the browser, /sim/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT_FILES, TIER_KITS, KITS, STANDIN_KIT_FILES, STANDIN_KITS } from '../../server/sim/content/kits/index.js';
import { KITS as CONTENT_KITS } from '../../server/sim/content/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const KIT_DIR = join(ROOT, 'server/sim/content/kits');
const CHESS = JSON.parse(readFileSync(join(ROOT, 'data/chess.json'), 'utf8'));
const BACKUPS = JSON.parse(readFileSync(join(ROOT, 'data/backups.json'), 'utf8'));
const jsIn = (dir) => readdirSync(join(KIT_DIR, dir)).filter((f) => f.endsWith('.js')).sort();

test('kits/index.js lists every kit file of kits/ops/ exactly once, and only those', () => {
  const listed = [...KIT_FILES.flat(), ...STANDIN_KIT_FILES];
  assert.equal(new Set(listed).size, listed.length, 'a file listed twice');
  assert.deepEqual([...listed].sort(), jsIn('ops'));
});

test('a stand-in kit file standin-<codename>.js registers the kit of that stand-in charId (data/backups.json units)', async () => {
  const units = Object.keys(BACKUPS.units);
  for (const file of STANDIN_KIT_FILES) {
    const m = /^standin-([a-z0-9]+)\.js$/.exec(file);
    assert.ok(m, `${file}: name`);
    const charId = units.find((id) => id.replace(/^char_\d+_/, '') === m[1]);
    assert.ok(charId, `${file}: no stand-in with the code name ${m[1]}`);
    const mod = await import(`../../server/sim/content/kits/ops/${file}`);
    assert.deepEqual(Object.keys(mod.default), [charId], `${file}: default export`);
    assert.equal(typeof mod.default[charId], 'function', `${file}: kit builder`);
    assert.equal(STANDIN_KITS[charId], mod.default[charId], `${file}: registered`);
    assert.equal(KITS[charId], mod.default[charId], `${file}: in the merged registry`);
  }
});

test('a kit file <chessId>-<codename>.js registers the kit of <chessId>_a (codename: its charId without char_<n>_)', async () => {
  for (const file of KIT_FILES.flat()) {
    const m = /^(chess_char_\w+?)-([a-z0-9]+)\.js$/.exec(file);
    assert.ok(m, `${file}: name`);
    const key = `${m[1]}_a`;
    const rec = CHESS[key];
    assert.ok(rec, `${file}: no data record ${key}`);
    assert.equal(String(rec.charId).replace(/^char_\d+_/, ''), m[2], `${file}: code name of ${rec.charId}`);
    const mod = await import(`../../server/sim/content/kits/ops/${file}`);
    assert.deepEqual(Object.keys(mod.default), [key], `${file}: default export`);
    assert.equal(typeof mod.default[key], 'function', `${file}: kit builder`);
    assert.equal(KITS[key], mod.default[key], `${file}: registered`);
  }
});

test('the registry is the tier groups in KIT_FILES order, then the stand-ins, one key per file; content/index.js serves the same object', () => {
  assert.deepEqual(Object.keys(KITS), [...TIER_KITS.flatMap((t) => Object.keys(t)), ...Object.keys(STANDIN_KITS)]);
  assert.equal(Object.keys(KITS).length, KIT_FILES.flat().length + STANDIN_KIT_FILES.length, 'one key per file, none twice');
  assert.equal(CONTENT_KITS, KITS);
});

test('kit files stay browser-safe and deterministic: no Node-only or server-only import, no clock, no Math.random', () => {
  for (const f of ['index.js', ...['shared', 'ops'].flatMap((d) => jsIn(d).map((x) => `${d}/${x}`))]) {
    const src = readFileSync(join(KIT_DIR, f), 'utf8');
    assert.ok(!/from\s+['"]node:|import\(\s*['"]node:|\brequire\(|nodeData\.js/.test(src), `${f}: Node-only import`);
    const specifiers = [...src.matchAll(/^(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm), ...src.matchAll(/\bimport\(\s*['"`]([^'"`]+)['"`]/g)];
    for (const [, p] of specifiers) {
      assert.ok(p.startsWith('.'), `${f}: bare import ${p}`);
      // never server / client code, never an index module (content/index.js, kits/index.js: an import cycle)
      assert.ok(!/(^|\/)(match|net|public)\/|(^|\/)index\.js$/.test(p), `${f}: imports ${p}`);
    }
    assert.ok(!/Math\.random|Date\.now|performance\.now|setTimeout|setInterval/.test(src), `${f}: clock / Math.random (use battle.rng, battle.after / every)`);
  }
});
