// The strategy draft's battlefield mini map (fork 2254875e, #65, ui/stagePreview.js): drawn from every stage's own tiles,
// so no battlefield of any official version goes without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

const { stagePreview, miniTile, StageMiniMap } = await import('../../public/js/ui/stagePreview.js');

const json = (p) => JSON.parse(readFileSync(path.join(ROOT, p), 'utf8'));
const stages = { ...json('data/stages.json') };
for (const dir of readdirSync(path.join(ROOT, 'data/versions'))) {
  const f = `data/versions/${dir}/stages.json`;
  if (existsSync(path.join(ROOT, f))) Object.assign(stages, Object.fromEntries(Object.entries(json(f)).map(([k, v]) => [`${dir}/${k}`, v])));
}

test('every battlefield of every version has a map with its gates and protected point', () => {
  const fields = Object.entries(stages).filter(([k]) => !k.includes('escaped'));
  assert.ok(fields.length >= 11, `${fields.length} stages`);
  for (const [id, stage] of fields) {
    const map = stagePreview(stage);
    assert.ok(map, id);
    assert.deepEqual([map.w, map.h], [11, 4], id);
    const kinds = new Set(map.tiles.map((t) => t.kind));
    assert.ok(kinds.has('gate') && kinds.has('goal'), `${id}: ${[...kinds]}`);
    assert.ok(map.tiles.every((t) => t.x >= 0 && t.x < map.w && t.y >= 0 && t.y < map.h), id);
  }
});

test('rows go bottom-up as on the board; road, platform and fence read apart', () => {
  const stage = stages.act2autochess_m01;
  const at = (x, y) => stagePreview(stage).tiles.find((t) => t.x === x && t.y === y)?.kind;
  assert.equal(at(0, 3), 'goal', 'the protected point of row 9 is the bottom row, as on the board');
  assert.equal(at(8, 3), 'gate');
  assert.equal(at(8, 0), 'gate');
  assert.equal(miniTile(stage, 9, 3), 'road');
  assert.equal(miniTile(stage, 10, 4), 'high');
  assert.equal(miniTile(stages.act1autochess_m01, 10, 3), 'fence');
});

test('a stage without tile data draws nothing; the draft screen mounts the map', () => {
  assert.equal(stagePreview(null), null);
  assert.equal(stagePreview({ name: 'x' }), null);
  assert.equal(StageMiniMap({ stage: { name: 'x' } }), null);
  // the order column heads with it (screens/bandDraft.js): the map, the name and the mode's pool note
  const draft = read('public/js/screens/bandDraft.js');
  assert.match(draft, /import \{ StageMiniMap \} from '\.\.\/ui\/stagePreview\.js';/);
  assert.match(draft, /data-testid="draft-map"/);
  assert.match(draft, /<\$\{StageMiniMap\} stage=\$\{stage\} \/>/);
});
