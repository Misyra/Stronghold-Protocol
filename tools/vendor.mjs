// Copies client vendor libraries from node_modules into public/vendor (run by `npm run vendor` / postinstall).
//
// three.js (the official 3D board scene, DESIGN §15) ships as two ES modules: three.module.js imports
// './three.core.js', so both are copied side by side and the renderer imports '/vendor/three.module.js' directly
// (no import map, no CDN — LAN play works offline). Optional packages that are not installed are skipped with a
// warning instead of failing the install.
// Preact's hooks build imports the bare specifier "preact"; it is rewritten to the sibling './preact.module.js' (the
// same URL the import map resolves "preact" to, so one Preact instance) — module graphs then load without import-map
// support (Safari < 16.4).
// pixi-spine 4.0.6's bundle gets two fixes of its Spine 3.7 / 3.8 runtimes (patchPixiSpine; ported from the Stardust
// fork's 1cf4daaf, feedback #148: the legs of the 动态立绘 stood at the wrong angles). Its 4.1 runtime has both
// already; the bundle runs every 4.x model on it.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'vendor');

/** Bare specifiers inside vendored ES modules → their sibling vendored file. */
export const VENDOR_REWRITES = Object.freeze({ 'hooks.module.js': { preact: './preact.module.js' } });

/**
 * Rewrite `from"x"` / `from 'x'` / `import("x")` of the mapped bare specifiers in a vendored module source.
 * @param {string} src
 * @param {Record<string, string>} map
 */
export function rewriteBare(src, map) {
  let res = src;
  for (const [bare, rel] of Object.entries(map)) {
    const esc = bare.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    res = res.replace(new RegExp(`(\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s*)(["'])${esc}\\2`, 'g'), (_, pre, q) => `${pre}${q}${rel}${q}`);
  }
  return res;
}

/**
 * Two bugs of pixi-spine 4.0.6's Spine 3.7 / 3.8 runtimes, fixed in the vendored bundle (ported from the Stardust
 * fork's 1cf4daaf, feedback #148). Checked against the official spine-ts 3.8 runtime, slot by slot: of the 57 binary
 * 动态立绘, 41 were posed off it (28 by more than 50 skeleton units); with both fixes 47 agree within 2.5 units —
 * 锏「暗月的影子」's legs were off by up to 298, now ≤ 2.2. The other 10 differ for another reason (their
 * docs/history/0.3.3.md §36.18).
 *   - PathConstraint.update: `if (tangents) if (tangents) r = …; else if (spaces[i + 1] == 0) r = …; else r = atan2(…)`
 *     — the doubled `if` leaves r = 0 for a constraint whose rotate mode is chain or chain scale, so every bone it
 *     rotates snaps to world angle 0 (the official: `if (tangents) … else if … else …`). Minified:
 *     `if(o&&(o?D=w[T-1]:g[M+1]==0?D=w[T+2]:D=Math.atan2(B,F)),…` → `if((o?D=w[T-1]:…),…`.
 *   - Bone.updateWorldTransformWith, NoRotationOrReflection (3.8): the parent's basis is divided by the skeleton's own
 *     scaleX / scaleY, but pixi-spine draws y-down by negating scaleY in that function (`sy`), not in the skeleton, so
 *     these bones (hair strands, ribbons) came out mirrored a little. Divide by the function's sx / sy, as pixi-spine's
 *     own 4.0 / 4.1 runtimes do: `f/=this.skeleton.scaleX,m/=this.skeleton.scaleY` → `f/=o,m/=d`.
 * Returns the patched source and how many of each were applied; the bundle of the version in package-lock.json has 2
 * and 1 (test/vendor-pixi-spine.test.js). A bundle without them (another pixi-spine version) is returned unchanged.
 * @param {string} src
 * @returns {{ src: string, path: number, bone: number }}
 */
export function patchPixiSpine(src) {
  let path = 0;
  let out = src.replace(/if\((\w+)&&\(\1\?(\w+)=(\w+)\[(\w+)-1\]:/g, (_, t, r, positions, p) => { path++; return `if((${t}?${r}=${positions}[${p}-1]:`; });
  let bone = 0;
  const NRR = /(\w+)\/=this\.skeleton\.scaleX,(\w+)\/=this\.skeleton\.scaleY/g;
  out = out.replace(NRR, (whole, pa, pc, at) => {
    // the function's own sx / sy: `o=this.skeleton.scaleX,d=zt.yDown?-this.skeleton.scaleY:this.skeleton.scaleY` before it
    const head = out.slice(Math.max(0, at - 2000), at);
    const m = [...head.matchAll(/(\w+)=this\.skeleton\.scaleX,(\w+)=\w+\.yDown\?-this\.skeleton\.scaleY:this\.skeleton\.scaleY/g)].pop();
    if (!m) return whole;
    bone++;
    return `${pa}/=${m[1]},${pc}/=${m[2]}`;
  });
  return { src: out, path, bone };
}

/** Text patches of a vendored file: file name in public/vendor → (source) → patched source. */
export const VENDOR_PATCHES = Object.freeze({ 'pixi-spine.js': (src) => patchPixiSpine(src).src });

/** [source under the repo root, file name in public/vendor, optional] */
export const VENDOR_FILES = Object.freeze([
  ['node_modules/ses/dist/ses.umd.js', 'ses.umd.js'],
  ['node_modules/acorn/dist/acorn.mjs', 'acorn.mjs'],
  ['node_modules/pixi.js/dist/pixi.min.js', 'pixi.min.js'],
  ['node_modules/pixi-spine/dist/pixi-spine.js', 'pixi-spine.js'],
  ['node_modules/preact/dist/preact.module.js', 'preact.module.js'],
  ['node_modules/preact/hooks/dist/hooks.module.js', 'hooks.module.js'],
  ['node_modules/htm/dist/htm.module.js', 'htm.module.js'],
  ['node_modules/@zip.js/zip.js/index.min.js', 'zip.module.js'],
  ['node_modules/@zip.js/zip.js/lib/core/streams/codecs/crc32.js', 'zip-crc32.module.js'],
  ['node_modules/three/build/three.core.js', 'three.core.js', true],
  ['node_modules/three/build/three.module.js', 'three.module.js', true],
]);

export function vendor({ log = console.log, warn = console.warn } = {}) {
  mkdirSync(out, { recursive: true });
  const done = [];
  for (const [src, dst, optional] of VENDOR_FILES) {
    const from = join(root, src);
    if (optional && !existsSync(from)) { warn(`vendor: ${dst} skipped (${src} not installed; the 3D board falls back to 2D)`); continue; }
    if (VENDOR_REWRITES[dst]) writeFileSync(join(out, dst), rewriteBare(readFileSync(from, 'utf8'), VENDOR_REWRITES[dst]));
    else if (VENDOR_PATCHES[dst]) writeFileSync(join(out, dst), VENDOR_PATCHES[dst](readFileSync(from, 'utf8')));
    else copyFileSync(from, join(out, dst));
    done.push(dst);
    log('vendor:', dst);
  }
  return done;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) vendor();
