// public/dev/fx-viewer.js — dev viewer of the official battle effects (render/vfx, DESIGN §33): plays any extracted
// prefab key on the board camera (the official battle camera of render/projection.js) with play / pause / step, 1× / 2×
// (the battle clock), the 完整 / 精简 tiers, a left / right facing and an optional unit whose skin's mount points place
// the effect (its `_spawnLocation`) — markers show the points. A 2D canvas under the transparent Pixi canvas stands in
// for the 3D board, so the effects composite onto it as they do in the game.
//
// Query: ?key=<prefab> &unit=<unit id> &speed=1|2 &tier=full|lite &face=L|R &panel=0 &seed=<n> &bg=<css colour>
//        &grid=0 (a flat background without the tiles: the browser test measures the blending on it)
//        &attack=<unit id> (the wiring demo: that unit attacks a dummy 3 tiles away every second — its casts,
//        projectile and hits from index.json through render/vfx/wiring.js, as in a battle) &kind=<projKind> &skill=1
// Puppeteer hook: window.__fx = { ready, error, lib, ofx, play(key, o), step(frames, dt), render(), clear(), stats(),
//   setTier(t), keys() } — the tests drive frames by hand (ticker stopped) for deterministic pictures.

import { OfficialFx } from '../js/render/vfx/system.js';
import { FxWiring } from '../js/render/vfx/wiring.js';
import { projSpeed } from '../js/render/fx.js';
import { spawnPoint, unitPoint } from '../js/render/vfx/mounts.js';
import { fallbackLog } from '../js/render/vfx/materials.js';
import { presetCamera } from '../js/render/projection.js';
import { assets } from '../js/assets.js';
import { ensurePixi } from '../js/render/app/pixi.js';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const api = { ready: false, error: null };
window.__fx = api;

const UNIT_TILE = { row: 10, col: 5 };
const state = { key: q.get('key') || 'common_hit_01', speed: Number(q.get('speed')) === 1 ? 1 : 2, paused: false, loop: true, left: q.get('face') === 'L', unit: q.get('unit') || '', handle: null };

function drawBoard(cam, w, h) {
  const c = $('board');
  const dpr = devicePixelRatio || 1;
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = q.get('bg') || '#1b2422';
  g.fillRect(0, 0, w, h);
  if (q.get('grid') === '0') return;
  for (let r = 6; r <= 13; r++) for (let col = -1; col <= 11; col++) {
    const pts = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([dx, dy]) => cam.project(col + dx, r + dy, 0));
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    g.fillStyle = (r + col) % 2 ? '#2b3633' : '#323f3b';
    g.fill();
    g.strokeStyle = '#46554f';
    g.lineWidth = 1;
    g.stroke();
  }
}

async function main() {
  if (q.get('panel') === '0') $('panel').classList.add('is-hidden');
  const P = await ensurePixi(); // the page's CSP has no unsafe-eval: the no-eval shader path
  const host = $('field');
  const W = () => Math.max(1, host.clientWidth), H = () => Math.max(1, host.clientHeight);
  const app = new P.Application({ width: W(), height: H(), backgroundAlpha: 0, antialias: false, resolution: devicePixelRatio || 1, autoDensity: true, preserveDrawingBuffer: true });
  host.appendChild(app.view);
  app.view.style.width = '100%'; app.view.style.height = '100%';
  let cam = presetCamera('normal', { width: W(), height: H() }, { side: 'L' });
  drawBoard(cam, W(), H());
  addEventListener('resize', () => { app.renderer.resize(W(), H()); cam = presetCamera('normal', { width: W(), height: H() }, { side: 'L' }); drawBoard(cam, W(), H()); });

  await assets.ready?.();
  const ofx = new OfficialFx({ P, renderer: app.renderer, assets, cam: () => cam, heightAt: () => 0, tier: q.get('tier') === 'lite' ? 'lite' : 'full' });
  ofx.setGround(() => 0, 'flat');
  const markers = new P.Graphics();
  app.stage.addChild(ofx.ground, markers, ofx.over);
  api.ofx = ofx; api.lib = ofx.lib; api.app = app;
  const ok = await ofx.init();
  if (!ok) { $('stats').textContent = 'no extracted effects (data/local-fx.json)'; api.error = 'no effects'; api.ready = true; return; }
  const index = await ofx.lib.index();
  const keys = Object.keys(ofx.lib.groups['fx/prefabs']).sort();
  const dl = $('keys');
  for (const k of keys) dl.append(new Option(k));
  const units = index ? Object.keys(index.units || {}).sort() : [];
  for (const u of units) $('unit').append(new Option(u, u));
  $('key').value = state.key;
  $('unit').value = state.unit;

  let demo = { on: false, t: 0, src: null, tgt: null, kind: q.get('kind') || 'arrow' };
  let demoStep = () => {};
  const unitAt = () => ({ x: UNIT_TILE.col, y: UNIT_TILE.row, z: 0, left: state.left, back: false });
  const skinOf = () => {
    const u = index?.units?.[state.unit];
    return u && u.skin ? index.skins?.[u.skin] : null;
  };

  function drawMarkers() {
    markers.clear();
    const skin = skinOf();
    const u = unitAt();
    if (q.get('grid') === '0') return;
    const foot = cam.project(u.x, u.y, 0);
    markers.lineStyle(1, 0xffffff, 0.5).drawCircle(foot.x, foot.y, 4);
    if (!skin) return;
    for (const [kind, col] of [['hit', 0xff5050], ['muzzle', 0x50ff50], ['head', 0x5090ff], ['s0', 0xffff50]]) {
      const p = unitPoint(skin, kind, u);
      const s = cam.project(p[0] + 10, p[1] + 9, -p[2]);
      markers.lineStyle(2, col, 0.9).moveTo(s.x - 5, s.y).lineTo(s.x + 5, s.y).moveTo(s.x, s.y - 5).lineTo(s.x, s.y + 5);
    }
  }

  async function play(key, o = {}) {
    state.key = String(key || state.key).toLowerCase();
    if (state.handle) state.handle.kill();
    const def = await ofx.lib.load(state.key);
    if (!def) { $('stats').textContent = `no prefab ${state.key}`; return null; }
    await ofx.lib.preload([state.key], { half: ofx.lite });
    const u = unitAt();
    const pos = spawnPoint(skinOf(), def.spawn, u);
    const flip = (def.rotateType === 1 && (u.left !== def.leftIsDefault)) || (!!def.proj && u.left);
    const mirror = flip && !(def.rotateType === 1 && def.rotY >= 0), flipY = flip && def.rotateType === 1 && def.rotY >= 0;
    const yaw = def.rotateType === 2 || def.rotateType === 4 ? (u.left ? Math.PI : 0) : 0;
    // a projectile's flying part flies 3 tiles to the right (or left) and back, like a shot across the board
    let track = null;
    if (def.proj) {
      const from = pos.slice(), dir = u.left ? -1 : 1, dur = 0.5;
      track = (fx) => {
        const k = (fx.time % (dur * 2)) / dur;
        const f = k <= 1 ? k : 2 - k;
        fx.anchor[0] = from[0] + dir * 3 * f;
        fx.anchor[1] = from[1];
        fx.anchor[2] = from[2];
        fx.yaw = (k <= 1) === (dir > 0) ? 0 : Math.PI;
        fx.mirror = false;
      };
    }
    state.handle = ofx.spawn(state.key, { pos, yaw, mirror: def.proj ? false : mirror, flipY, groundZ: 0 }, { loop: true, track, seed: o.seed ?? (Number(q.get('seed')) || 1) });
    drawMarkers();
    return state.handle;
  }

  function step(frames = 1, dt = 1 / 60) {
    for (let i = 0; i < frames; i++) {
      ofx.update(dt * state.speed);
      demoStep(dt * state.speed);
      if (state.loop && state.handle && !state.handle.alive && !demo.on) play(state.key);
    }
  }

  app.ticker.add(() => {
    if (!state.paused) step(1, app.ticker.deltaMS / 1000);
    const s = ofx.stats();
    $('stats').textContent = `${state.key}  ${state.handle?.effect ? state.handle.effect.state : '—'}  t=${state.handle?.effect ? state.handle.effect.time.toFixed(2) : '—'}\n` +
      `effects ${s.effects}  particles ${s.particles}  draws ${s.draws}  programs ${s.programs}  textures ${s.textures} (${s.texMB} MB)\n` +
      `fallback shaders: ${fallbackLog().map(([n, f]) => `${n} → ${f}`).join(', ') || 'none'}`;
    ofx.frameStats();
  });

  const toggle = (on, off) => { $(on).classList.add('is-on'); $(off).classList.remove('is-on'); };
  $('play').onclick = () => play($('key').value);
  $('key').onchange = () => play($('key').value);
  $('pause').onclick = () => { state.paused = !state.paused; $('pause').classList.toggle('is-on', state.paused); };
  $('step').onclick = () => { state.paused = true; $('pause').classList.add('is-on'); step(1, 1 / 60); };
  $('speed1').onclick = () => { state.speed = 1; toggle('speed1', 'speed2'); };
  $('speed2').onclick = () => { state.speed = 2; toggle('speed2', 'speed1'); };
  $('loop').onclick = () => { state.loop = !state.loop; $('loop').classList.toggle('is-on', state.loop); };
  $('stop').onclick = () => { state.loop = false; $('loop').classList.remove('is-on'); state.handle?.stop(); };
  $('clear').onclick = () => { ofx.clear(); state.handle = null; };
  $('full').onclick = () => { ofx.setTier('full'); toggle('full', 'lite'); play(state.key); };
  $('lite').onclick = () => { ofx.setTier('lite'); toggle('lite', 'full'); play(state.key); };
  $('faceL').onclick = () => { state.left = true; toggle('faceL', 'faceR'); play(state.key); };
  $('faceR').onclick = () => { state.left = false; toggle('faceR', 'faceL'); play(state.key); };
  $('unit').onchange = () => { state.unit = $('unit').value; play(state.key); };
  if (q.get('speed')) toggle(state.speed === 1 ? 'speed1' : 'speed2', state.speed === 1 ? 'speed2' : 'speed1');

  // ---- the wiring demo: a unit attacking a dummy (render/vfx/wiring.js) ----------------------------------------------
  const wiring = new FxWiring(ofx, { speed: projSpeed });
  await wiring.ready();
  const fake = (id, unitKey, col, row, enemy) => ({ id, x: col, y: row, z: 0, hover: 0, visFacing: enemy ? -1 : 1, isEnemy: enemy, alive: true, flags: 0,
    info: { id, spine: unitKey, defId: unitKey, side: enemy ? 'enemy' : 'ally', kind: enemy ? 'enemy' : 'op', skillIndex: 0 } });
  function startAttackDemo(unitKey, o = {}) {
    ofx.clear(); wiring.clear();
    demo.on = true; demo.t = 0; demo.kind = o.kind || demo.kind;
    demo.src = fake(1, unitKey, UNIT_TILE.col, UNIT_TILE.row, /^enemy_/.test(unitKey));
    demo.tgt = fake(2, o.target || 'enemy_1007_slime', UNIT_TILE.col + (o.dist ?? 3), UNIT_TILE.row, !/^enemy_/.test(unitKey));
    if (demo.src.isEnemy) demo.src.visFacing = 1;
    if (o.skill) demo.src.flags |= 16;
    wiring.begin([demo.src, demo.tgt]);
  }
  demoStep = (dt) => {
    if (!demo.on) return;
    const before = demo.t;
    demo.t += dt;
    wiring.tick();
    if (Math.floor(before) !== Math.floor(demo.t) || before === 0) {
      const melee = demo.kind === 'none';
      wiring.attack(demo.src, demo.tgt, demo.kind, ofx.time);
      // the damage lands when the sim's projectile would (melee: at once)
      const dur = melee ? 0 : Math.hypot(demo.tgt.x - demo.src.x, demo.tgt.y - demo.src.y) / projSpeed(demo.kind);
      (ofx.timers || (ofx.timers = [])).push({ at: ofx.time + dur, fn: () => wiring.damage(demo.tgt, 'phys', demo.src, ofx.time) });
    }
  };
  if (q.get('attack')) startAttackDemo(q.get('attack'), { kind: q.get('kind') || undefined, skill: q.get('skill') === '1' });

  Object.assign(api, {
    play, step,
    attackDemo: startAttackDemo,
    stopDemo: () => { demo.on = false; },
    wiring,
    render: () => app.renderer.render(app.stage),
    clear: () => { ofx.clear(); state.handle = null; },
    stats: () => ofx.stats(),
    setTier: (t) => ofx.setTier(t),
    keys: () => keys,
    /** Screen px of a board point (col, row, height): where the tests look. */
    project: (x, y, z = 0) => { const p = cam.project(x, y, z); return { x: p.x, y: p.y, s: p.s }; },
    unitTile: () => ({ ...UNIT_TILE }),
    stopTicker: () => app.ticker.stop(),
    setLoop: (v) => { state.loop = !!v; },
    setFace: (left) => { state.left = !!left; },
    setUnit: (u) => { state.unit = u || ''; },
    fallbacks: () => fallbackLog(),
  });
  if (!q.get('attack')) await play(state.key);
  api.ready = true;
}

main().catch((err) => { api.error = String(err?.stack || err); api.ready = true; console.error(err); });
