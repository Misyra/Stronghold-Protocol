// public/js/render/fx/zones.js — FxSystem blasts, zones, tile flashes and screen washes.
// Installed on FxSystem.prototype by ./system.js (a method container: never instantiated; `this` is the effect system).

import { NO_OPTS, clamp, easeOut } from './limits.js';

export class FxZones {
  /**
   * An explosion on the ground at (x, y, z) of radius r tiles: fireball in `col`, a white flash, a shockwave and a
   * coloured ring on the ground, sparks and smoke. o.heavy (bombard, airstrike …): longer, more sparks, debris flying
   * and a scorch mark; o.small (shell impacts): no coloured ring, fewer sparks; o.tiles: flash those tiles too.
   */
  explosion(x, y, z, r, col, o = NO_OPTS) {
    const cam = this.ctx.cam();
    const g = cam.project(x, y, z + 0.3, this._g);
    const gx = g.x, gy = g.y, s = g.s;
    const R = Math.max(0.4, r), heavy = !!o.heavy, small = !!o.small, rich = this.rich;
    this.particle('glow', gx, gy, { tint: col, life: heavy ? 0.5 : small ? 0.3 : 0.4, s0: (s / 128) * (0.7 + R * 0.7), s1: (s / 128) * (1.2 + R * 1.2), a0: 1, a1: 0 });
    this.particle('flare', gx, gy, { tint: 0xfff4e0, life: heavy ? 0.28 : 0.18, s0: (s / 128) * (0.9 + R * 0.7), s1: (s / 128) * (0.3 + R * 0.2), a0: 1, a1: 0, rot: Math.random() * 3 });
    this.ring(x, y, z, 0.1, R * 1.1, 0xfff0d8, heavy ? 0.42 : 0.3, 'shock');
    if (!small) this.ring(x, y, z, 0.15, R, col, heavy ? 0.6 : 0.45);
    this.burst(gx, gy, s, Math.round((small ? 4 : 6) + R * (heavy ? 6 : 3)), col, { speed: 1.8 + R, life: heavy ? 0.6 : 0.45, up: 0.5 });
    this.smoke(gx, gy - s * 0.15, s * (0.35 + R * 0.35), o.smoke ?? 0x2a2522, heavy ? 0.5 : 0.35);
    if (rich && heavy) {
      // debris: dark chunks and hot embers thrown up, falling back
      for (let i = 0; i < 8; i++) {
        const a = -Math.PI * (0.15 + Math.random() * 0.7), v = s * (1.6 + Math.random() * 1.8);
        const hot = i % 2 === 0;
        this.particle(hot ? 'dot' : 'shard', gx, gy, {
          add: hot, tint: hot ? col : 0x2e2620, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: s * 5, life: 0.55 + Math.random() * 0.25,
          s0: (s / 32) * (hot ? 0.16 : 0.2), s1: (s / 32) * (hot ? 0.04 : 0.14), a0: 1, a1: hot ? 0 : 0.4, spin: (Math.random() - 0.5) * 14,
        });
      }
      // a scorch mark fading on the ground (flattened like the ground under the camera)
      const c = cam.project(x, y, z + 0.01, this._p);
      const cx = c.x, cy = c.y;
      const flat = clamp((cy - cam.project(x, y + 1, z + 0.01, this._q).y) / Math.max(1, c.s), 0.25, 1);
      this.particle('soft', cx, cy, { add: false, tint: 0x000000, life: 1.6, s0: (c.s / 128) * R * 1.5 * flat, s1: (c.s / 128) * R * 1.6 * flat, sx: 1 / flat, a0: 0.4, a1: 0 });
    }
    if (o.tiles) this.tileFlash(o.tiles, col, 0.45);
  }

  /** Dark (normal-blend) smoke puff. */
  smoke(x, y, size, tint, alpha = 0.45) {
    this.particle('smoke', x, y, { add: false, tint, life: 0.8, s0: size / 128 * 0.9, s1: size / 128 * 2, a0: alpha, a1: 0 });
  }

  /** Motion streak between two world points at height z (dash / pull / blink trails). */
  streak(x0, y0, x1, y1, z, tint, life = 0.3) {
    const cam = this.ctx.cam();
    const a = cam.project(x0, y0, z, this._p), ax = a.x, ay = a.y;
    const b = cam.project(x1, y1, z, this._q);
    const len = Math.hypot(b.x - ax, b.y - ay);
    if (len < 2) return;
    const th = Math.max(0.05, (b.s * 0.3) / 32);
    this.particle('streak', b.x, b.y, { tint, life, s0: th, s1: th * 0.5, sx: len / 128 / th, a0: 0.8, a1: 0, rot: Math.atan2(b.y - ay, b.x - ax), anchorX: 1 });
  }

  /** Light strike from the sky onto a point (lightning / skill strikes / columns). */
  strike(x, y, z, tint, wide = false) {
    const cam = this.ctx.cam();
    const g = cam.project(x, y, z);
    this.particle('pillar', g.x, g.y, { tint, life: 0.4, s0: g.s / 64 * (wide ? 1.2 : 0.7), s1: g.s / 64 * (wide ? 0.9 : 0.2), a0: 1, a1: 0, sx: wide ? 1 : 0.5, ay: 1 });
    this.particle('glow', g.x, g.y - g.s * 0.2, { tint, life: 0.3, s0: g.s / 128 * 0.8, s1: g.s / 128 * 1.6, a0: 0.9, a1: 0 });
    this.ring(x, y, z, 0.1, wide ? 1.2 : 0.7, tint, 0.35);
    this.burst(g.x, g.y - g.s * 0.2, g.s, 6, tint, { speed: 2.4, life: 0.35 });
  }

  /** Persistent ground area: soft disc + pulsing edge ring for `dur` real seconds (telegraphs pulse faster). */
  zone(x, y, z, r, tint, dur, tex = 'soft', warn = false) {
    const P = this.P;
    const disc = new P.Sprite(this.tex[tex === 'ring' ? 'soft' : tex] || this.tex.soft);
    disc.anchor.set(0.5); disc.blendMode = P.BLEND_MODES.ADD; disc.tint = tint;
    const edge = new P.Sprite(this.tex.ring);
    edge.anchor.set(0.5); edge.blendMode = P.BLEND_MODES.ADD; edge.tint = tint;
    this._onGround(disc, y, z); this._onGround(edge, y, z);
    this.zones.push({ disc, edge, x, y, z, r, t: 0, dur, warn });
    if (this.zones.length > 24) this._freeZone(this.zones.shift());
  }

  _freeZone(zn) { zn.disc.destroy(); zn.edge.destroy(); }

  _updateZones(dt) {
    const cam = this.ctx.cam();
    const p = this._p, q = this._q;
    let w = 0;
    for (const zn of this.zones) {
      zn.t += dt;
      if (zn.t >= zn.dur) { this._freeZone(zn); continue; }
      const k = zn.t / zn.dur;
      const grow = Math.min(1, zn.t / 0.25);
      const rad = zn.r * (0.35 + 0.65 * easeOut(grow));
      cam.project(zn.x, zn.y, zn.z + 0.02, p);
      cam.project(zn.x, zn.y + rad, zn.z + 0.02, q);
      const rx = p.s * rad, ry = Math.max(1, p.y - q.y);
      const fade = k > 0.8 ? (1 - k) / 0.2 : 1;
      const pulse = zn.warn ? 0.55 + 0.45 * Math.abs(Math.sin(zn.t * 7)) : 0.8 + 0.2 * Math.sin(zn.t * 3);
      zn.disc.position.set(p.x, p.y); zn.disc.scale.set((rx * 2) / 128, (ry * 2) / 128); zn.disc.alpha = (zn.warn ? 0.35 : 0.28) * fade * pulse;
      zn.edge.position.set(p.x, p.y); zn.edge.scale.set((rx * 2.1) / 128, (ry * 2.1) / 128); zn.edge.alpha = 0.75 * fade * pulse;
      this.zones[w++] = zn;
    }
    this.zones.length = w;
  }

  /** Flash a set of tiles ([[r,c]]) on the ground (telegraphed boxes, blast tiles). */
  tileFlash(tiles, tint, dur, warn = false) {
    if (!Array.isArray(tiles) || !tiles.length) return;
    this.tileFlashes.push({ tiles: tiles.slice(0, 60), tint, dur: Math.max(0.2, dur), t: 0, warn });
    if (this.tileFlashes.length > 12) this.tileFlashes.shift();
  }

  _updateTileFlashes(dt) {
    const g = this.tileGfx;
    g.clear();
    if (!this.tileFlashes.length) return;
    const cam = this.ctx.cam();
    const p = this._p;
    let w = 0;
    for (const f of this.tileFlashes) {
      f.t += dt;
      if (f.t >= f.dur) continue;
      const k = f.t / f.dur;
      const a = (f.warn ? 0.35 + 0.35 * Math.abs(Math.sin(f.t * 7)) : 0.55 * (1 - k)) * (k > 0.85 ? (1 - k) / 0.15 : 1);
      for (const [r, c] of f.tiles) {
        const z = (this.ctx.heightAt ? this.ctx.heightAt(r, c) : 0) + 0.015;
        const pts = [];
        for (const [dx, dy] of [[-0.46, 0.46], [0.46, 0.46], [0.46, -0.46], [-0.46, -0.46]]) { cam.project(c + dx, r + dy, z, p); pts.push(p.x, p.y); }
        g.lineStyle(Math.max(1, p.s * 0.03), f.tint, Math.min(1, a * 1.6));
        g.beginFill(f.tint, a * 0.6);
        g.drawPolygon(pts);
        g.endFill();
      }
      this.tileFlashes[w++] = f;
    }
    this.tileFlashes.length = w;
  }

  /** Full-screen colour pulse (field-wide telegraphs, cold wind). */
  flashScreen(tint, alpha = 0.4, dur = 0.6) {
    this.tintT = dur; this.tintDur = dur; this.tintA = alpha;
    this.tintSprite.tint = tint;
  }

  /** A short flurry of snow over the field (cold wind). */
  snowfall(tint) {
    const size = this.ctx.screenSize();
    for (let i = 0; i < (this.quality === 'low' ? 10 : 26); i++) {
      this.particle('dot', Math.random() * size.width, Math.random() * size.height * 0.7, { tint, vx: 30 + Math.random() * 40, vy: 60 + Math.random() * 60, life: 1 + Math.random() * 0.6, s0: 0.25 + Math.random() * 0.3, s1: 0.1, a0: 0.8, a1: 0, fadeIn: 0.2 });
    }
  }

  /** Leak: objective flash + red screen vignette pulse. */
  leak() {
    this.vigT = 0.9;
  }
}
