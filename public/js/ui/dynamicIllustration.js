// 动态立绘 — the layered Spine illustration of one outfit (docs/OPERATOR-SKINS.md, shared/skin-catalogue.js
// ILLUSTRATION_SPINES). Loaded only when the caller actually opens the preview, never with the card list: the Pixi
// bundle, the asset store and the skeleton all appear on mount and are released on unmount.
//
// The record it plays is one skin record's `dynamic` (shared/skins.js dynamicIllustration): skel / atlas / textures
// plus `anims.idle`, `animations` (clip → duration) and `bounds`, and the optional `background` / `foreground` layers
// drawn behind and in front of the skeleton. A record that is missing, a skeleton the client cannot parse, a failed
// layer image or a lost GL context all end on the static illustration — the picker never shows an error box.
//
// Motion: `prefers-reduced-motion: reduce` starts paused. A hidden tab stops the ticker, and a ready preview resumes
// only if the player left it playing. The clip selector is built from the model's own animation names, so an outfit
// with a single Idle clip shows no selector at all.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button } from './components.js';
import { Img } from './gameComponents.js';
import { ensurePixi } from '../render/app/pixi.js';
import { t } from '../../../shared/i18n.js';

const reducedMotion = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * @param {{ entry: any, staticSrc?: string|null, alt?: string }} props
 *   `entry` is the composed dynamic record (shared/skins.js dynamicIllustration), `staticSrc` the outfit's own
 *   illustration / portrait drawn while the model loads or when it cannot start.
 */
export function DynamicIllustration({ entry, staticSrc = null, alt = '' }) {
  const host = useRef(null);
  const appRef = useRef(null);
  const actorRef = useRef(null);
  const [state, setState] = useState('loading');
  const [clip, setClip] = useState(entry?.anims?.idle || '');
  const [playing, setPlaying] = useState(() => !reducedMotion());
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const clips = Object.keys(entry?.animations || {});
  const skelKey = entry?.skel || '';

  useEffect(() => {
    // A parent may hand a fresh object every render; the skeleton URL is the actual identity of this preview.
    let disposed = false;
    let acquired = false;
    let assets = null;
    let releaseGl = null;
    let app = null;
    let actor = null;
    let watcher = null;
    let resize = null;
    let onVisibility = null;
    const stop = () => { if (app) app.stop(); };

    (async () => {
      try {
        if (!host.current || !entry || !skelKey) throw new Error('no dynamic illustration');
        const P = await ensurePixi();
        if (disposed) return;
        app = new P.Application({
          width: 1, height: 1, backgroundAlpha: 0, antialias: true, autoStart: false,
          resolution: Math.min(globalThis.devicePixelRatio || 1, 1.5), autoDensity: true,
        });
        appRef.current = app;
        host.current.appendChild(app.view);
        [{ assets }, { releaseGl }] = await Promise.all([import('../assets.js'), import('../render/app/host.js')]);
        if (disposed) return;
        acquired = true;
        const data = await assets.spine.acquire(entry);
        if (disposed) return;
        actor = new P.spine.Spine(data);
        actor.autoUpdate = false;
        actorRef.current = actor;
        const b = entry.bounds;
        if (!b || !(b.width > 0 && b.height > 0)) throw new Error('dynamic illustration bounds missing');
        const container = new P.Container();
        container.addChild(actor);
        app.stage.addChild(container);
        const layer = async (url, foreground) => {
          if (!url) return;
          const image = await assets.image(url);
          if (disposed) return;
          if (!image) throw new Error('dynamic illustration layer unavailable');
          const sprite = new P.Sprite(P.Texture.from(image));
          sprite.width = b.width;
          sprite.height = b.height;
          sprite.x = b.x;
          sprite.y = -b.y - b.height;
          if (foreground) container.addChild(sprite); else container.addChildAt(sprite, 0);
        };
        await layer(entry.background, false);
        await layer(entry.foreground, true);
        if (disposed) return;
        const idle = entry.anims?.idle || clips[0];
        if (idle) actor.state.setAnimation(0, idle, true);
        actor.update(0);
        resize = () => {
          if (disposed || !host.current) return;
          const width = Math.max(1, host.current.clientWidth);
          const height = Math.max(1, host.current.clientHeight);
          app.renderer.resize(width, height);
          const scale = Math.min(width / b.width, height / b.height) * 0.94;
          container.scale.set(scale);
          container.position.set(width / 2 - (b.x + b.width / 2) * scale, height / 2 + (b.y + b.height / 2) * scale);
          app.render();
        };
        resize();
        if (typeof ResizeObserver === 'function') {
          watcher = new ResizeObserver(resize);
          watcher.observe(host.current);
        }
        app.ticker.maxFPS = globalThis.matchMedia?.('(pointer: coarse)').matches ? 24 : 30;
        app.ticker.add(() => actor.update(Math.min(0.05, app.ticker.deltaMS / 1000)));
        onVisibility = () => {
          if (globalThis.document?.hidden) stop();
          else if (playingRef.current) app?.start();
        };
        globalThis.document?.addEventListener('visibilitychange', onVisibility);
        if (playingRef.current && !globalThis.document?.hidden) app.start(); else app.render();
        setState('ready');
      } catch {
        stop();
        try { app?.destroy(true, { children: true, texture: false, baseTexture: false }); } catch { /* nothing was built */ }
        app = null;
        appRef.current = null;
        if (!disposed) setState('fallback');
      }
    })();

    return () => {
      disposed = true;
      watcher?.disconnect();
      if (onVisibility) globalThis.document?.removeEventListener('visibilitychange', onVisibility);
      appRef.current = null;
      actorRef.current = null;
      try {
        if (app?.renderer) releaseGl?.(app.renderer);
        app?.destroy(true, { children: true, texture: false, baseTexture: false });
      } catch { /* a lost context is already gone */ }
      if (acquired) assets?.spine.release(entry);
    };
  }, [skelKey]);

  useEffect(() => {
    const app = appRef.current;
    if (!app) return;
    if (state === 'ready' && playing && !globalThis.document?.hidden) app.start(); else app.stop();
  }, [playing, state]);

  useEffect(() => {
    const actor = actorRef.current;
    if (!actor || !clip || !clips.includes(clip)) return;
    actor.state.setAnimation(0, clip, true);
    actor.update(0);
    appRef.current?.render();
  }, [clip, state]);

  const idle = entry?.anims?.idle || clips[0] || '';
  return html`<div class="lo-dynamic" data-testid="dynamic-illustration" data-state=${state}>
    <div class="lo-dynamic__stage">
      ${state !== 'ready'
        ? html`<${Img} src=${staticSrc} class="lo-dynamic__fallback" alt=${alt}
            fallback=${html`<span class="lo-dynamic__missing">${t('立绘暂时无法载入')}</span>`} />`
        : null}
      <div class="lo-dynamic__canvas" ref=${host} hidden=${state === 'fallback'}></div>
    </div>
    <div class="lo-dynamic__controls">
      <span role="status">${state === 'loading' ? t('正在载入动态立绘…') : state === 'fallback' ? t('动态立绘暂不可用，已显示静态立绘') : playing ? t('动态立绘播放中') : t('动态立绘已暂停')}</span>
      ${state === 'ready' ? html`<${Button} variant="secondary" size="sm" data-testid="dynamic-pause" onClick=${() => setPlaying(!playing)}>${playing ? t('暂停') : t('播放')}<//>` : null}
      ${state === 'ready' && clips.length > 1 ? html`<label class="lo-dynamic__clip">${t('动作')}
        <select id="operator-illustration-animation" value=${clip || idle} onChange=${(event) => setClip(event.currentTarget.value)}>
          ${clips.map((name) => html`<option key=${name} value=${name}>${name}</option>`)}
        </select>
      </label>` : null}
    </div>
  </div>`;
}
