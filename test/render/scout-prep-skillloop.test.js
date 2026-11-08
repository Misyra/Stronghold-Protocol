// A scouted prep board (a teammate's lineup during prep, battleMeta.prep) is a prep surface: its pieces stand idle, also
// on the bench, and start no passive skill loops — the skill wiring saw them as deployed and started their loops
// (琳琅诗怀雅 S2's range cross around a benched operator, feedback #95; fork 01c60fce).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('a scouted board starts no skill loops (feedback #95: 琳琅诗怀雅 S2 on a teammate\'s bench)', () => {
  const src = readFileSync(new URL('../../public/js/render/app.js', import.meta.url), 'utf8');
  assert.match(src, /if \(!battleMeta\?\.prep\) wiring\.sync\(views\.values\(\)\);/);
});
