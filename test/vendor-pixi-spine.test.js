// tools/vendor.mjs patchPixiSpine (ported from the Stardust fork's 1cf4daaf, feedback #148): the two fixes of
// pixi-spine 4.0.6's Spine 3.7 / 3.8 runtimes in the vendored bundle — a path constraint in chain / chain-scale rotate
// mode rotating its bones along the path (锏「暗月的影子」's legs), and NoRotationOrReflection bones divided by the
// y-down scale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { patchPixiSpine, VENDOR_PATCHES } from '../tools/vendor.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'node_modules/pixi-spine/dist/pixi-spine.js');
const SERVED = path.join(ROOT, 'public/vendor/pixi-spine.js');

test('the path constraint branch: a chain rotate mode takes the path\'s direction, not 0', () => {
  const src = 'if(b=I,p=V,r){let D=0;if(o&&(o?D=w[T-1]:g[M+1]==0?D=w[T+2]:D=Math.atan2(B,F)),D-=Math.atan2(q,Y),y){X()}}';
  const out = patchPixiSpine(src);
  assert.equal(out.path, 1);
  assert.equal(out.src, 'if(b=I,p=V,r){let D=0;if((o?D=w[T-1]:g[M+1]==0?D=w[T+2]:D=Math.atan2(B,F)),D-=Math.atan2(q,Y),y){X()}}');
  // the same logic as the official runtime: tangents → the stored angle; else a zero space → the next one; else atan2
  const run = (code, o, spaceZero) => {
    const env = { o, w: [0, 0, 0, 7, 0, 0, 9], T: 4, g: [0, spaceZero ? 0 : 5], M: 0, B: 1, F: 1, q: 0, Y: 1, y: false, D: 0, b: 0, p: 0, I: 0, V: 0, r: true, X: () => {} };
    vm.runInNewContext(code.replace('let D=0;', ''), env);
    return env.D;
  };
  assert.equal(run(src, false, false), 0, 'the bug: a chain mode leaves the angle at 0');
  assert.equal(run(out.src, true, false), 7);
  assert.equal(run(out.src, false, true), 9);
  assert.equal(run(out.src, false, false), Math.atan2(1, 1));
});

test('NoRotationOrReflection divides by the function\'s own sx / sy (y-down), not the skeleton\'s scale', () => {
  const src = 'updateWorldTransformWith(t){const s=this.parent,a=this.matrix,o=this.skeleton.scaleX,d=zt.yDown?-this.skeleton.scaleY:this.skeleton.scaleY;'
    + 'switch(1){case j.NoRotationOrReflection:{let x=f*f+m*m,E=0;x>1e-4?(x=Math.abs(f*g-u*m)/x,f/=this.skeleton.scaleX,m/=this.skeleton.scaleY,u=m*x):0;break}}}';
  const out = patchPixiSpine(src);
  assert.equal(out.bone, 1);
  assert.match(out.src, /x=Math\.abs\(f\*g-u\*m\)\/x,f\/=o,m\/=d,u=m\*x/);
  // without the function head to take the names from, nothing changes
  const lone = 'f/=this.skeleton.scaleX,m/=this.skeleton.scaleY';
  assert.deepEqual(patchPixiSpine(lone), { src: lone, path: 0, bone: 0 });
});

test('the installed pixi-spine bundle gets both fixes, still parses, and patching twice changes nothing', { skip: !existsSync(DIST) && 'pixi-spine not installed' }, () => {
  const src = readFileSync(DIST, 'utf8');
  const out = patchPixiSpine(src);
  // 4.0.6 (package-lock.json): the 3.7 and 3.8 path constraints, the 3.8 bone; its 4.1 runtime has both fixes already
  assert.equal(out.path, 2, 'path-constraint fixes');
  assert.equal(out.bone, 1, 'NoRotationOrReflection fix');
  assert.doesNotThrow(() => new vm.Script(out.src, { filename: 'pixi-spine.js' }));
  assert.doesNotMatch(out.src, /if\((\w+)&&\(\1\?\w+=\w+\[\w+-1\]:/);
  assert.doesNotMatch(out.src, /\/=this\.skeleton\.scaleX,\w+\/=this\.skeleton\.scaleY/);
  const again = patchPixiSpine(out.src);
  assert.deepEqual([again.path, again.bone, again.src === out.src], [0, 0, true]);
  assert.equal(VENDOR_PATCHES['pixi-spine.js'](src), out.src);
});

test('public/vendor/pixi-spine.js is the patched bundle (npm run vendor)', { skip: !(existsSync(DIST) && existsSync(SERVED)) && 'not vendored' }, () => {
  assert.equal(readFileSync(SERVED, 'utf8'), patchPixiSpine(readFileSync(DIST, 'utf8')).src, 'public/vendor/pixi-spine.js is stale: run npm run vendor');
});
