// 干员皮肤 — ported from sganggs/Stronghold-Protocol PR #652 (https://github.com/sganggs/Stronghold-Protocol/pull/652, upstream 0.2.7-dev); this fork's adaptations are listed in docs/SKINS.md.
// public/js/render/spinePreview.js — 干员小人预览 (docs/SKINS.md).
//
// Two things live here, both for the 皮肤 section's preview frame (ui/skinPicker.js):
//
//   * a STATIC snapshot (a 256 px PNG) — the instant first paint, and the fallback when WebGL is unavailable;
//   * LIVE playback — the exact render path the battlefield uses (ensurePixi + assets.spine + a frame loop), so the
//     frame shows the real model animated at the display's refresh rate instead of a pre-rendered GIF. A GIF of one
//     clip measured ~360 KB at this size (30 frames, transparent); the live canvas costs 0 extra bytes because the
//     model files are the ones a deploy already pulls, from the HTTP cache.
//
// `clipsOf()` is the data side of the buttons under the frame: which animations a model ACTUALLY has comes from its
// manifest entry (`anims` roles), and it differs per skin — 隐现's default model ships two skills, its 罗德厨房 skin
// only one — so the buttons are derived per (operator, skin), never hardcoded.
//
// A model that fails to load (a skin whose files are missing upstream, no WebGL at all) leaves `status: 'failed'` and
// the caller keeps the avatar — the section must never be blocked by a preview.

import { ensurePixi } from './app/pixi.js';
import { assets, spineEntry } from '../assets.js';
import { data } from '../data.js';

/**
 * Side of the static PNG, in px. Square: the preview box crops nothing and a letterboxed model needs no fitting.
 * Rendered well above its display size so the model stays crisp on a retina screen.
 */
export const PREVIEW_PX = 256;
/** How much of the box the model fills (the rest is breathing room, so a wide weapon does not touch the edges). */
const FILL = 0.92;
/** Where in the idle loop the static snapshot is taken: frame 0 is often a transitional pose (a step, an arm up). */
const IDLE_AT = 0.33;
/** The longest step the live loop may advance by, so a backgrounded tab does not jump the animation. */
const MAX_STEP = 0.05;

/** @type {Map<string, { status: 'loading'|'ready'|'failed', url: string|null }>} */
const cache = new Map();
const subs = new Set();
const queue = [];
let busy = false;
let renderer = null;

/** `${assetId}|${skinId}` — the model a frame shows. `skinId` empty = the operator's own model. */
export function previewKey(assetId, skinId = '') {
  return `${assetId || ''}|${skinId || ''}`;
}

/**
 * What is known about one static snapshot right now. Safe to call in a render pass (no side effects) — the picker
 * calls it for the frame, then `requestPreview()` in an effect.
 * @param {string} assetId operator charId (or token/enemy id)
 * @param {string} [skinId]
 * @returns {{ status: 'idle'|'loading'|'ready'|'failed', url: string|null }}
 */
export function previewState(assetId, skinId = '') {
  const hit = cache.get(previewKey(assetId, skinId));
  return hit ? { status: hit.status, url: hit.url } : { status: 'idle', url: null };
}

/**
 * Queue a snapshot unless it is already known. Cheap to call repeatedly (a re-render, a reopened picker): a key that
 * is loading or done is ignored, a failed one is only retried when `retry` is set.
 * @param {string} assetId @param {string} [skinId] @param {{ retry?: boolean }} [opts]
 */
export function requestPreview(assetId, skinId = '', opts = {}) {
  if (!assetId) return;
  const key = previewKey(assetId, skinId);
  const hit = cache.get(key);
  if (hit && (hit.status !== 'failed' || !opts.retry)) return;
  cache.set(key, { status: 'loading', url: null });
  queue.push({ key, assetId, skinId });
  notify();
  void pump();
}

/** Subscribe to "a snapshot landed". Returns the unsubscribe function. */
export function subscribePreviews(fn) {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

/** Drop every cached snapshot (a manifest reload replaces the URLs; tests use it too). */
export function clearPreviews() {
  cache.clear();
  queue.length = 0;
  notify();
}

function notify() {
  for (const fn of subs) { try { fn(); } catch { /* a subscriber must not break the queue */ } }
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      if (!cache.has(job.key)) continue; // cleared while waiting
      try {
        const url = await renderOne(job.assetId, job.skinId);
        cache.set(job.key, { status: 'ready', url });
      } catch {
        // deliberately silent: a model missing upstream is a known case (2 of the 174 skins, docs/SKINS.md) and the
        // frame falls back to the avatar, so a console warning per miss would only be noise
        cache.set(job.key, { status: 'failed', url: null });
      }
      notify();
    }
  } finally {
    busy = false;
  }
}

/** One offscreen WebGL renderer, shared by the snapshots and the live frame (created on first use). */
async function getRenderer(PIXI, size = PREVIEW_PX) {
  if (renderer && !renderer._destroyed) {
    if (renderer.width !== size || renderer.height !== size) renderer.resize(size, size);
    return renderer;
  }
  // autoDetectRenderer tries WebGL and falls back to canvas; a preview does not need either specialised
  renderer = await PIXI.autoDetectRenderer({ width: size, height: size, backgroundAlpha: 0, antialias: true });
  return renderer;
}

function okRect(r) {
  return !!r && Number.isFinite(r.x) && Number.isFinite(r.y) && r.width > 1 && r.height > 1;
}

/** Fit a skeleton into a square of `size` px, centred, from its own bounds (the manifest's union only as a fallback). */
function fit(sp, entry, size) {
  const b = sp.getLocalBounds();
  const box = okRect(b) ? b : (okRect(entry?.bounds) ? entry.bounds : { x: 0, y: 0, width: size, height: size });
  const scale = Math.min(size / box.width, size / box.height) * FILL;
  sp.scale.set(scale);
  sp.position.set(size / 2 - (box.x + box.width / 2) * scale, size / 2 - (box.y + box.height / 2) * scale);
}

/** A Spine posed at `at`× the clip (a fresh instance: the skeleton data itself is shared and cached). */
function poseSkeleton(PIXI, skel, clip, at) {
  const sp = new PIXI.spine.Spine(skel);
  sp.autoUpdate = false;
  if (clip) sp.state.setAnimation(0, clip, true);
  const dur = clip ? (skel.findAnimation?.(clip)?.duration || 1) : 0;
  if (at) sp.update(dur * at);
  return sp;
}

/**
 * Pose one model at an idle frame and draw it into a square PNG data URL.
 * @param {string} assetId @param {string} skinId
 * @returns {Promise<string>}
 */
async function renderOne(assetId, skinId) {
  const PIXI = await ensurePixi();
  const entry = spineEntry(data.get('assets'), assetId, skinId ? { skin: skinId } : undefined);
  if (!entry) throw new Error('no spine for ' + assetId + (skinId ? ' (' + skinId + ')' : ''));
  const skel = await assets.spine.acquire(entry);
  let sp = null;
  let rt = null;
  try {
    sp = poseSkeleton(PIXI, skel, entry.anims?.idle || skel.animations?.[0]?.name || null, IDLE_AT);
    fit(sp, entry, PREVIEW_PX);
    const r = await getRenderer(PIXI, PREVIEW_PX);
    rt = PIXI.RenderTexture.create({ width: PREVIEW_PX, height: PREVIEW_PX });
    // a masked model (hasClipping) needs the stencil buffer, exactly like the impostor atlas pages
    try { rt.framebuffer?.enableStencil(); } catch { /* canvas renderer: masks fall back to scissor */ }
    r.render(sp, { renderTexture: rt, clear: true });
    const canvas = r.extract.canvas(rt);
    return canvas.toDataURL('image/png');
  } finally {
    try { rt?.destroy?.(true); } catch { /* ignore */ }
    try { sp?.destroy?.({ children: true }); } catch { /* ignore */ }
    assets.spine.release(entry);
  }
}

// ---- the animation list -----------------------------------------------------------------------------------------

/** A clip name out of a role slot that may be a string or `{ begin, loop, end, idle }`. */
const clipName = (x) => (typeof x === 'string' ? x : (x && typeof x === 'object' && typeof x.loop === 'string' ? x.loop : null));

/**
 * Every skill family the SKELETON ships, read from its clip names: `Skill_1` / `Skill1` / `Skill_01` (a one-clip
 * skill) and `Skill_<n>_Begin/_Loop/_End`. The manifest's resolved `skills` only covers the indices the mode's pool
 * uses — `skillIndicesByChar()` resolves the skill the pool fields, so 锏's model (Skill_1, Skill_2 and a
 * Skill_3_Begin/Loop/End trio) came back with index 2 alone and the preview offered a single 技能 button.
 * Directional (`Skill_Right_Loop`) and prone (`Skill_Down_2`) variants are not families of their own.
 * @param {string[]} names the skeleton's clip names
 * @returns {Map<number, { begin: string|null, loop: string|null, end: string|null, one: string|null }>} by 0-based index
 */
function skillFamilies(names) {
  const out = new Map();
  for (const n of names) {
    const m = /^skill_?0*(\d+)(?:_(begin|loop|end))?$/i.exec(n);
    if (!m) continue;
    const i = Number(m[1]) - 1;
    if (!(i >= 0 && i < 20)) continue;
    const slot = out.get(i) || { begin: null, loop: null, end: null, one: null };
    const part = (m[2] || '').toLowerCase();
    if (part === 'begin') slot.begin = slot.begin || n;
    else if (part === 'loop') slot.loop = slot.loop || n;
    else if (part === 'end') slot.end = slot.end || n;
    else slot.one = slot.one || n; // a bare Skill_1: the whole cast is that clip
    out.set(i, slot);
  }
  return out;
}

/** begin → loop ×2 → end → idle: what the battlefield plays for an attack or a skill. */
function sequenced(role, idle) {
  const begin = typeof role?.begin === 'string' ? role.begin : null;
  const loop = typeof role?.loop === 'string' ? role.loop : null;
  const end = typeof role?.end === 'string' ? role.end : null;
  const steps = [];
  if (begin) steps.push([begin, false]);
  if (loop) steps.push([loop, false], [loop, false]);
  if (end) steps.push([end, false]);
  if (steps.length && idle) steps.push([idle, true]);
  return steps;
}

/**
 * Every animation the model of (operator, skin) actually has, as buttons for the preview frame: the semantic ones
 * from the manifest's `anims` roles (the same roles the battlefield plays) plus the skeleton's own skill families
 * and one entry per remaining clip — so a model with 13 clips offers buttons that between them reach all 13.
 * @returns {{ total: number, clips: { id: string, kind: string, skillIndex: number, clipName?: string, names: string[], steps: [string, boolean][] }[] }}
 *
 * @param {any} m manifest @param {string} assetId @param {string} [skinId]
 * @returns {{ total: number, clips: { id: string, kind: string, skillIndex: number, names: string[], steps: [string, boolean][] }[] }}
 *   `kind` is what the caller labels (ui/skinPicker.js maps it to 待机 / 攻击 / 技能…); a `raw` entry carries a
 *   `clipName` and is labelled with it; `names` is the underlying clip list, shown as the button's tooltip;
 *   `total` counts every clip in the skeleton — and every one of them is reachable through some button.
 */
export function clipsOf(m, assetId, skinId = '') {
  const entry = spineEntry(m, assetId, skinId ? { skin: skinId } : undefined);
  const a = entry?.anims;
  if (!a) return { total: 0, clips: [] };
  const idle = clipName(a.idle);
  const out = [];
  // `kind` + `skillIndex`, never a label: the LABEL is a UI concern (the picker maps it through t()), so this
  // module stays free of Chinese literals — which the i18n audit requires of everything under public/js.
  const push = (id, kind, steps, skillIndex = 0) => {
    if (!steps.length) return;
    out.push({ id, kind, skillIndex, names: steps.map(([n]) => n), steps });
  };
  /** begin → loop ×2 → end → idle (what the battlefield plays for an attack or a skill). */
  const seq = (role) => sequenced(role, idle);
  /** One clip that just loops (待机 / 眩晕 / 移动 / 攻击·下). */
  const loop = (name) => (name ? [[name, true]] : []);
  push('deploy', 'deploy', typeof a.deploy === 'string' ? [[a.deploy, false], ...loop(idle)] : seq(a.deploy));
  push('idle', 'idle', loop(idle));
  push('attack', 'attack', seq(a.attack));
  push('attackDown', 'attackDown', loop(clipName(a.attackDown)));
  // 技能: every family the skeleton ships, merged with the resolved roles (which cover only the pool's indices)
  const families = skillFamilies(Object.keys(entry.animations || {}));
  const indices = [...new Set([...families.keys(), ...Object.keys(a.skills || {}).map(Number)])].sort((x, y) => x - y);
  if (indices.length) {
    for (const i of indices) {
      const fam = families.get(i);
      const role = (a.skills || {})[String(i)] || (i === 0 ? a.skill : null);
      const steps = fam && (fam.begin || fam.loop || fam.end || fam.one)
        ? (fam.one && !fam.loop && !fam.begin && !fam.end
          ? [[fam.one, false], ...loop(idle)]           // a one-clip skill: cast once, then back to 待机
          : seq({ begin: fam.begin, loop: fam.loop, end: fam.end }))
        : seq(role);
      push(`skill${i}`, 'skill', steps, i);
    }
  } else push('skill', 'skill', seq(a.skill));
  push('stun', 'stun', loop(clipName(a.stun)));
  push('move', 'move', loop(clipName(a.move)));
  push('die', 'die', typeof a.die === 'string' ? [[a.die, false]] : seq(a.die));
  // Every remaining clip gets its own button, so `total` clips and buttons line up: stance and variant clips no role
  // points at (锏: Default, Skill_2_B, Skill_Down_2, Skill_Down_2_B; 隐现: Attack_Idle, Skill_1_Idle, …) are still
  // part of what the model ships, and the user asked to be able to look at each one. They loop: nothing says whether
  // a clip is a one-shot, and a loop keeps the preview alive. The picker labels them with the raw clip name.
  const used = new Set(out.flatMap((c) => c.names));
  for (const n of Object.keys(entry.animations || {})) {
    if (used.has(n)) continue;
    out.push({ id: `clip:${n}`, kind: 'raw', skillIndex: 0, clipName: n, names: [n], steps: [[n, true]] });
  }
  return { total: Object.keys(entry.animations || {}).length, clips: out };
}

// ---- live playback ---------------------------------------------------------------------------------------------

/**
 * Play one model live in `host` (a DOM element), the way the battlefield draws it: a Spine in the shared PIXI
 * renderer, stepped by requestAnimationFrame at the display's own rate.
 *
 * @param {any} host the preview box; the renderer's canvas is appended to it
 * @param {{ assetId: string, skinId?: string, clipSize?: number, isCancelled?: () => boolean }} opts
 *   `isCancelled` is checked right before the canvas is attached: a mount that resolves after its caller moved on
 *   (the player switched operator or skin while the skeleton was loading) must NOT attach — the renderer has ONE
 *   canvas, and a late attach moves it into a DOM node that is already gone, leaving the visible frame empty.
 * @returns {Promise<{ play: (steps: [string, boolean][]) => void, dispose: () => void }>}
 */
export async function mountPreview(host, { assetId, skinId = '', clipSize = PREVIEW_PX, isCancelled = null } = {}) {
  if (!host) throw new Error('mountPreview: no host');
  const cancelled = () => (typeof isCancelled === 'function' ? !!isCancelled() : false);
  const PIXI = await ensurePixi();
  const entry = spineEntry(data.get('assets'), assetId, skinId ? { skin: skinId } : undefined);
  if (!entry) throw new Error('no spine for ' + assetId);
  const skel = await assets.spine.acquire(entry);
  if (cancelled()) {
    assets.spine.release(entry);
    return { play() {}, dispose() {} };
  }
  const sp = poseSkeleton(PIXI, skel, entry.anims?.idle || null, IDLE_AT);
  fit(sp, entry, clipSize);
  const r = await getRenderer(PIXI, clipSize);
  if (cancelled() || !host.isConnected) {
    try { sp.destroy({ children: true }); } catch { /* ignore */ }
    assets.spine.release(entry);
    return { play() {}, dispose() {} };
  }
  const view = r.view;
  view.style.width = '100%';
  view.style.height = '100%';
  view.style.display = 'block';
  host.appendChild(view);
  let raf = 0;
  let last = performance.now();
  let disposed = false;
  const tick = (now) => {
    if (disposed) return;
    // a long gap (a tab that was hidden) must not fast-forward the clip
    const dt = Math.min(MAX_STEP, Math.max(0, (now - last) / 1000));
    last = now;
    try { sp.update(dt); r.render(sp); } catch { /* one bad frame must not kill the loop */ }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return {
    /** Play one entry of `clipsOf().clips` (its `steps`). */
    play(steps) {
      if (disposed || !Array.isArray(steps) || !steps.length) return;
      const [first, ...rest] = steps;
      sp.state.setAnimation(0, first[0], first[1]);
      for (const [name, loop] of rest) sp.state.addAnimation(0, name, loop, 0);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      try { view.remove(); } catch { /* already gone */ }
      try { sp.destroy({ children: true }); } catch { /* ignore */ }
      assets.spine.release(entry);
    },
  };
}
