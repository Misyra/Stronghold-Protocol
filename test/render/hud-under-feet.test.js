// test/render/hud-under-feet.test.js — owner decision 10 (2026-11-02): the battle HUD under the model as in the official
// game (the client's prefabs char_hp_slider / char_sp_slider / enemy_hp_slider / enemy_boss_hp_slider / trap_hp_slider and
// char_ep_slider / enemy_ep_slider, arts/ui/[uc]battlecommon.ab — render/units.js HUD_LAYOUT, textures.js EP_PREFAB):
// the HP bar's centre the prefab's units under the feet, the SP bar and the rows under it, the element ring between the
// feet and the bar, the status icons over the head, the redeploy ring in the element ring's place; operators, summons,
// enemies, bosses, devices; on high ground and in the air the HUD follows the feet; a nearer unit's HUD draws over a
// farther one's. Fake PIXI (test/render/fakepixi.js), no browser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';

let fake, M, T;
before(async () => {
  fake = installFakePixi();
  M = await import('../../public/js/render/units.js');
  T = await import('../../public/js/render/textures.js');
});
after(() => fake.restore());

const cam = () => presetCamera('normal', { width: 1280, height: 720 });
const sample = (o = {}) => ({ x: 5, y: 10, hp: 600, maxHp: 1000, sp: 3, spMax: 10, flags: 0, anim: 0, vx: 0, vy: 0, el: null, elFill: 0, elUntil: 0, elDur: 0, ...o });
function view(info = {}, ctxExtra = {}) {
  const ctx = fakeViewCtx(fake.P, { cam, ...ctxExtra });
  return new M.UnitView(ctx, { id: 1, side: 'ally', kind: 'chess', defId: 'char_x', tier: 3, x: 5, y: 10, maxHp: 1000, dir: 'RIGHT', ...info });
}
const frames = (v, n = 2) => { for (let i = 0; i < n; i++) v.update(1 / 60, cam(), i / 60); };
const top = (sp) => sp.position.y - sp.height / 2;
const bottom = (sp) => sp.position.y + sp.height / 2;

test('an operator: HP bar the prefab\'s 54.5 units under the feet, SP under it, the ring between, icons over the head', () => {
  const v = view();
  v.sync(sample({ el: 'burn', elFill: 0.5 }), 1);
  v.onStatus('fragile', true);
  frames(v);
  const s = v.screen.s, feet = v.screen.y;
  const g = M.elementRingGeom(s);
  assert.ok(Math.abs(v.hpBg.position.y - (feet + M.hudBarY(s, 'op', v.hpFill.height))) < 1e-9);
  assert.ok(v.hpBg.position.y - feet >= M.HUD_LAYOUT.op.hpY * g.px - 1e-9, 'at least the official offset');
  assert.ok(Math.abs(v.hpBg.position.x + v.hpBg.width / 2 - v.screen.x) < 1e-6, 'centred on the unit');
  assert.ok(top(v.spFill) >= bottom(v.hpFill) - 1e-9, 'SP under HP');
  const r = v._elRing;
  assert.ok(r.root.position.y > feet && r.root.position.y + r.d / 2 + M.HUD_LAYOUT.ringGap <= top(v.hpBg) + 1e-9, 'the ring between the feet and the bar');
  const icon = v.icons.find((i) => i.visible);
  assert.ok(icon && icon.position.y < v.screen.top, 'the status icons over the head');
  assert.ok(v.chip.visible && Math.abs(v.chip.position.y - v.hpBg.position.y) < v.chip.height, 'the tier chip beside the bars');
  assert.equal(v.hud.zIndex, v.root.zIndex, 'the HUD sorts with its unit');
});

test('a summon is laid out like an operator; an enemy, its bar 55.3 units down; a boss, its bar clear of the ring', () => {
  const tok = view({ kind: 'token', defId: 'token_x', tier: undefined });
  tok.sync(sample(), 1); frames(tok);
  assert.ok(tok.hpBg.position.y > tok.screen.y, 'a summon\'s bar under its feet');
  const e = view({ id: 2, side: 'enemy', kind: 'enemy', defId: 'enemy_x', dir: undefined });
  e.sync(sample({ sp: 0, spMax: 0, el: 'neural', elFill: 0.3 }), 1); frames(e);
  const se = e.screen.s;
  assert.ok(Math.abs(e.hpBg.position.y - (e.screen.y + M.hudBarY(se, 'enemy', e.hpFill.height))) < 1e-9);
  assert.ok(e._elRing.root.position.y + e._elRing.d / 2 <= top(e.hpBg) + 1e-9, 'its ring above its bar');
  const b = view({ id: 3, side: 'enemy', kind: 'enemy', defId: 'enemy_boss', boss: true, dir: undefined });
  b.sync(sample({ sp: 0, spMax: 0, maxHp: 100000, hp: 50000, el: 'apoptosis', elFill: 0.2 }), 1); frames(b);
  const sb = b.screen.s, gb = M.elementRingGeom(sb, true);
  assert.ok(b.hpBg.position.y > b.screen.y, 'a boss\'s bar under its feet');
  assert.ok(M.HUD_LAYOUT.boss.hpY * gb.px < gb.dy + gb.ring / 2 + b.hpFill.height / 2, 'the official boss offset would cut the ring…');
  assert.ok(b._elRing.root.position.y + b._elRing.d / 2 + M.HUD_LAYOUT.ringGap <= top(b.hpBg) + 1e-9, '…so the bar keeps clear of it');
});

test('high ground and flying units: the HUD follows the feet, at the same offsets', () => {
  const flat = view();
  flat.sync(sample(), 1); frames(flat);
  const high = view({}, { heightAt: () => 0.5 });
  high.sync(sample(), 1); frames(high, 3);
  assert.ok(high.screen.y < flat.screen.y - 1, 'the raised tile lifts the unit');
  for (const v of [flat, high]) {
    assert.ok(Math.abs(v.hpBg.position.y - (v.screen.y + M.hudBarY(v.screen.s, 'op', v.hpFill.height))) < 1e-9, 'the bar keeps its place under the feet');
  }
  const fly = view({ id: 4, side: 'enemy', kind: 'enemy', defId: 'enemy_fly', motion: 'FLY', dir: undefined });
  fly.sync(sample({ sp: 0, spMax: 0 }), 1); frames(fly, 60);
  assert.ok(fly.hover > 0, 'it hovers');
  assert.ok(fly.hpBg.position.y > fly.screen.y && fly.hpBg.position.y - fly.screen.y < fly.screen.s * 0.6, 'the bar under its body, not on the road');
});

test('a knocked-down operator: its redeploy ring where its element ring would be, under the feet', () => {
  const v = view();
  v.sync(sample(), 1); frames(v, 3);
  v.setDown([1, 30, 20, M.DOWN_STATE.COUNTING], 10);
  frames(v, 30);
  const r = v._downRing;
  assert.ok(r.root.visible);
  assert.ok(Math.abs(r.root.position.y - (v.screen.y + M.elementRingGeom(v.screen.s).dy)) < 1e-9);
  assert.equal(v.hpBg.visible, false, 'no bars while down');
});

test('the bars layer sorts by depth (a device\'s bar under it too: trap_hp_slider)', () => {
  assert.equal(M.HUD_LAYOUT.device.hpY, 54.5);
  const a = view({ id: 5, x: 5, y: 9 }), b = view({ id: 6, x: 5, y: 11 });
  for (const v of [a, b]) { v.sync(sample({ y: v.info.y }), 1); frames(v); }
  const [near, far] = a.screen.y > b.screen.y ? [a, b] : [b, a];   // the nearer one is lower on screen
  assert.notEqual(near.screen.y, far.screen.y);
  assert.ok(near.hud.zIndex > far.hud.zIndex, 'a nearer unit\'s HUD over a farther one\'s');
});
