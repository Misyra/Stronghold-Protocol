// 皮肤选择器 (docs/SKINS.md) — the 皮肤 section of the 干员调配 screen's detail panel.
//
// Self-contained on purpose: screens/loadout.js only imports this and drops `<${SkinSection} chess=… />` into its
// detail body, so upstream rewriting that screen (it is one of the two files most likely to change) costs one
// line here rather than a merge conflict over the whole panel.
//
// Two independent choices, in two radio groups, 商店立绘 first:
//   * 商店立绘 — which 180×360 立绘 the shop card and the operator detail card draw. **Local to this browser** (the
//     shop is private) and independent of the battle model on purpose. The options are 原始立绘 / 精英二立绘 /
//     each skin's 立绘, every one of them shown as its own art so the choice is a comparison, not a guess.
//   * 战斗模型 — which model this operator fights with in battle. A plain `{ [chessId]: skinId }` map mirrored to
//     the server through `room.skins` (PUBLIC: a teammate sees your model, ui/skins.js). Its tiles are TEXT ONLY —
//     a 40 px thumbnail of a 400 px character says nothing — and the model itself is played LIVE in the frame below
//     them (render/spinePreview.js): the same Spine + PIXI path the battlefield draws, with a button per animation
//     the model actually ships (部署 / 待机 / 攻击 / 技能1… / 眩晕 / 移动 / 死亡 — from `clipsOf`, per skin).
//
// Three states per skin, and the difference matters because skins are installed on demand:
//   * installed   → selectable, art from the asset manifest
//   * not installed → shown with an 未安装 · 点击安装 note; picking it would render nothing, so a click INSTALLS it
//     rather than selecting it (in either group — an uninstalled skin has neither a model nor a 立绘)
//   * the group's own tiles (原始立绘 / 精英二立绘 / 默认) go back to the operator's own art / model

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, MicroLabel, Spinner } from './components.js';
import { useStore, shallowEqual } from '../store.js';
import { data } from '../data.js';
import { toast } from './toasts.js';
import { net as appNet } from '../net.js';
import { t, N_ } from '../../../shared/i18n.js';
import {
  previewState, requestPreview, subscribePreviews, clearPreviews, clipsOf, mountPreview,
} from '../render/spinePreview.js';
import { chessOwnPortraitUrl, PORTRAIT_E2 } from './assetUrls.js';
import {
  skinsStore, availableSkins, loadSkinData, setSkin, clearSkin, requestSkinInstall,
  setPortrait, clearPortrait,
} from './skins.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/**
 * 1×1 transparent pixel for the frame's art layer while there is nothing to show. The layer is rendered
 * UNCONDITIONALLY on purpose: the live canvas is appended into a sibling node by render/spinePreview.js, and a vdom
 * child that appears/disappears (an img ↔ null flip) makes Preact re-diff the box's children, which wiped the
 * canvas the moment `live` turned true. A constant shape — one art layer + one mount layer — keeps it safe.
 */
const TRANSPARENT_PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * Animation button labels. `clipsOf()` reports a `kind` (it holds no Chinese itself — the i18n audit runs over
 * public/js), and the UI names it here: `N_()` registers the msgid without translating, `t()` translates at the
 * call site, which is what the audit wants.
 */
const CLIP_LABEL = {
  deploy: N_('部署'), idle: N_('待机'), attack: N_('攻击'), attackDown: N_('攻击·下'),
  stun: N_('眩晕'), move: N_('移动'), die: N_('死亡'),
};
const clipLabel = (c) => (c.kind === 'skill' ? t('技能{n}', { n: (c.skillIndex ?? 0) + 1 }) : t(CLIP_LABEL[c.kind] || c.kind));

/** A manifest asset URL of one operator (`chars[charId].<field>`), or null. */
function charAsset(charId, field) {
  return data.get('assets')?.chars?.[charId]?.[field] || null;
}

/**
 * The battle model's art: the static snapshot once it lands (render/spinePreview.js), the operator's 180×180 avatar
 * until then — so the frame is never empty, and it keeps showing something if the live canvas cannot start.
 *
 * Keyed by OPERATOR id, not by chess id: data/assets.json groups everything under `chars[charId]`, and the skin
 * catalogue does the same. A chess record carries both (`chess_char_1_01_a` → `charId: char_498_inside`), and
 * getting the two the wrong way round makes the whole section silently empty.
 */
function modelArt(charId, skinId) {
  const ready = previewState(charId, skinId).url;
  if (ready) return ready;
  return skinId ? (data.get('assets')?.chars?.[charId]?.skins?.[skinId]?.avatar || null) : charAsset(charId, 'avatar');
}

/** The 商店立绘 tile's art: the skin's 180×360 立绘, falling back to its square avatar. */
function skinPortrait(charId, skinId) {
  const sk = data.get('assets')?.chars?.[charId]?.skins?.[skinId];
  return sk?.portrait || sk?.avatar || null;
}

/**
 * One radio group of tiles: the group's own tiles first (原始立绘 / 精英二立绘 / 默认), then every skin of the
 * operator. `onPick('')` always means "the operator's own".
 * @param {{ name: string, ariaLabel: string, leading: any[], list: any[], chosenId: string|null,
 *   art: (x: any) => string|null, onPick: (id: string) => void, installing: string|null, progLabel: string,
 *   onInstall: (skinId: string) => void, thumbnails?: boolean, tall?: boolean }} p `tall` = the 立绘 tiles, whose
 *   box is the shop card's own 1:2 portrait shape inside a narrow column (a square box crops them)
 */
function SkinGroup(p) {
  const { leading, list, chosenId, art, onPick, installing, progLabel, onInstall, thumbnails = true, tall = false } = p;
  // `''` is the group's own tile and "nothing chosen" arrives as null/undefined — normalise both, or the tile that
  // means "the operator's own" would never read as selected (the first version compared the raw values)
  const chosen = chosenId || '';
  const tile = (key, id, name, note, url, extra) => html`
    <button key=${key} type="button" role="radio" aria-checked=${chosen === (id || '') ? 'true' : 'false'}
      data-skin=${id} disabled=${!!installing} title=${extra.title || name}
      class=${cx('lo-skin', !thumbnails && 'lo-skin--text', tall && 'lo-skin--tall', chosen === (id || '') && 'is-on', extra.missing && 'lo-skin--missing', extra.busy && 'is-installing')}
      onClick=${extra.onClick}>
      ${thumbnails
        ? html`<span class=${cx('lo-skin__art', tall && 'lo-skin__art--tall')}>
            ${url
              ? html`<img src=${url} alt="" loading="lazy" />`
              : extra.busy ? html`<${Spinner} size="sm" />` : html`<span class="lo-skin__art--none"></span>`}
          </span>`
        : null}
      <span class="lo-skin__text">
        <b class="lo-skin__name">${name}</b>
        <span class="lo-skin__group">${extra.busy ? progLabel : note}</span>
      </span>
    </button>`;
  return html`<div class=${cx('lo-skins', !thumbnails && 'lo-skins--text', tall && 'lo-skins--tall')} role="radiogroup"
      aria-label=${p.ariaLabel} data-skin-group=${p.name}>
    ${leading.map((x) => tile('own:' + x.id, x.id, x.name, x.note, x.art, { onClick: () => onPick(x.id), title: x.note }))}
    ${list.map((x) => {
      const isBusy = installing === x.id;
      return tile(x.id, x.id, x.name, isBusy ? '' : x.installed ? x.group : t('未安装 · 点击安装'), x.installed ? art(x) : null,
        { missing: !x.installed, busy: isBusy, onClick: () => (x.installed ? onPick(x.id) : onInstall(x.id)), title: x.name + (x.group ? ' · ' + x.group : '') });
    })}
  </div>`;
}

/**
 * 皮肤 section for one operator.
 * @param {{ chess: any, net?: any }} props `chess` is the chess record of the detail panel; `net` is injectable for tests
 */
export function SkinSection({ chess, net = appNet }) {
  const s = useStore((v) => v, shallowEqual, skinsStore);
  const m = data.get('assets');
  const [, bump] = useState(0);
  // The mount host as STATE, set by a callback ref: the frame's box appears only once the catalogue has loaded (the
  // section renders nothing before that), and a `useRef` would leave the mount effect with a null ref — it runs once,
  // finds nothing, and never re-runs because its other deps did not change. State makes the attach itself the trigger.
  const [boxNode, setBoxNode] = useState(null);
  const liveRef = useRef(null);
  const [live, setLive] = useState(false);
  const [clipId, setClipId] = useState('');
  // Two ids, and they are not interchangeable: a CHOICE is stored per chess (like the loadout, and that is the key
  // the server validates and the renderer reads), while the catalogue and the asset manifest are per operator.
  const chessId = chess && chess.chessId;
  const charId = chess && chess.charId;
  const chosen = s.entries[chessId] || null;
  const chosenPortrait = s.portraits[chessId] || '';
  const previewSkin = chosen || '';
  // The catalogue may still be loading on the first render, and until it is here the section returns null — so the
  // frame's box does not exist yet. `renderable` is part of the mount effect's deps for exactly that reason: without
  // it the effect would run once against a null ref and never again, and the live canvas would never mount.
  const list = charId ? availableSkins(charId) : [];
  const renderable = !!(chessId && charId && list.length);
  // the animations this exact model ships (per operator AND skin — a skin can have fewer skills)
  const { total: clipTotal, clips } = charId ? clipsOf(m, charId, previewSkin) : { total: 0, clips: [] };
  // 部署 / 待机 / 攻击 and up to three skills stay out; 攻击·下 / 眩晕 / 移动 / 死亡 and any further skill fold away
  const isPrimary = (c) => (c.kind === 'skill' ? c.skillIndex < 3 : (c.id === 'deploy' || c.id === 'idle' || c.id === 'attack'));
  const primaryClips = clips.filter(isPrimary);
  const extraClips = clips.filter((c) => !isPrimary(c));
  const [extraOpen, setExtraOpen] = useState(false);
  // the catalogue lives in data/skins.json and the installed set in data/assets.json; both may still be loading
  useEffect(() => {
    let dead = false;
    let manifest = data.get('assets');
    loadSkinData();
    const off = data.subscribe?.(() => {
      // a manifest that changed identity means somebody installed a skin: URLs (and so the preview) may differ
      const now = data.get('assets');
      if (now !== manifest) { manifest = now; clearPreviews(); }
      if (!dead) bump((n) => n + 1);
    });
    const offPreview = subscribePreviews(() => { if (!dead) bump((n) => n + 1); });
    const tick = setInterval(() => { if (!dead) bump((n) => n + 1); }, 500);
    return () => { dead = true; clearInterval(tick); off?.(); offPreview(); };
  }, [chessId]);

  // the static snapshot for the frame (the instant paint, and the fallback if the live canvas cannot start)
  useEffect(() => {
    if (charId) requestPreview(charId, previewSkin);
  }, [charId, previewSkin]);

  // a new model starts on 待机 (its first animation when it has no idle)
  useEffect(() => {
    setClipId('');
    setExtraOpen(false);
    setLive(false);
  }, [charId, previewSkin]);

  // LIVE playback: mount the model in the frame and step it every frame, exactly like a battlefield view. Mounted
  // once per (operator, skin); the clip buttons only re-play on the existing instance.
  useEffect(() => {
    if (!boxNode || !renderable || !charId) return undefined;
    let dead = false;
    let handle = null;
    (async () => {
      try {
        handle = await mountPreview(boxNode, { assetId: charId, skinId: previewSkin, isCancelled: () => dead });
        if (dead) { handle.dispose(); return; }
        liveRef.current = handle;
        setLive(true);
      } catch {
        // no WebGL, or a model whose files are missing: the static frame (or the avatar) stays, nothing else breaks
      }
    })();
    return () => {
      dead = true;
      liveRef.current = null;
      handle?.dispose();
      setLive(false);
    };
  }, [boxNode, charId, previewSkin, renderable]);

  // play the chosen animation (and the default one as soon as the model is mounted)
  useEffect(() => {
    const h = liveRef.current;
    if (!h) return;
    const pick = clips.find((c) => c.id === (clipId || 'idle')) || clips[0];
    if (pick) h.play(pick.steps);
  }, [clipId, live, charId, previewSkin]);

  if (!renderable) return null; // no slot / no operator / this operator has no skins at all: show nothing at all

  const installedCount = list.filter((x) => x.installed).length;
  const sock = net;
  const installing = s.installing || null;
  const prog = s.installingProgress;
  // The eight files are 2 models × (skel + atlas + png) + the avatar + the 立绘, and the installer reports them as
  // they land. Before the first report there is nothing to show but that it started.
  const progLabel = !prog ? '' :
    prog.phase === 'queued' ? t('排队中…') :
    prog.total > 0
      ? (prog.phase === 'finishing' ? t('{done}/{total} · 解析中…', { done: prog.done, total: prog.total }) : t('{done}/{total}', { done: prog.done, total: prog.total }))
      : t('准备中…');

  const install = async (skinId) => {
    if (!sock || installing) return;
    try {
      // acknowledged at once; the outcome arrives as skins.changed (ui/skins.js), which also reloads the manifest
      await requestSkinInstall(sock, skinId);
      toast(t('开始安装，装好后这里会自动出现（网络慢时约一分钟）'), 'info');
    } catch (e) {
      toast(t('安装失败：{why}', { why: (e && (e.detail || e.code)) || t('未知错误') }), 'warn');
    }
  };

  // 商店立绘: the operator's own two 立绘 first. A 1★/2★ operator has no 精英二 art — its own portrait is the only
  // option, and offering a second tile that would draw the same image is worse than offering one.
  const ownPortrait = chessOwnPortraitUrl(m, chess, false);
  const e2Portrait = chessOwnPortraitUrl(m, chess, true);
  const leading = [
    { id: '', name: t('原始立绘'), note: 'ORIGINAL', art: ownPortrait },
    ...(e2Portrait && e2Portrait !== ownPortrait ? [{ id: PORTRAIT_E2, name: t('精英二立绘'), note: 'ELITE 2', art: e2Portrait }] : []),
  ];
  const shared = { list, installing, progLabel, onInstall: install };
  // the frame: the model of the CURRENT choice, with its name and the animation buttons under it
  const previewStateNow = previewState(charId, previewSkin).status;
  const previewUrl = modelArt(charId, previewSkin);
  const previewName = chosen ? (list.find((x) => x.id === chosen)?.name || chosen) : t('默认');
  const currentClip = clips.find((c) => c.id === (clipId || 'idle')) || clips[0] || null;
  const note = previewStateNow === 'failed' ? ` · ${t('模型不可用')}` : '';
  return html`<section class="lo-sec lo-sec--skin" data-testid="skin-section">
    <header class="lo-sec__head">
      <h3>${t('皮肤')}<${MicroLabel}>SKIN<//></h3>
      <span class="lo-sec__note">
        ${installing
          ? html`<${Spinner} size="sm" /> ${t('正在安装')} <b class="num">${progLabel}</b>`
          : t('{installed}/{total} 已安装', { installed: installedCount, total: list.length })}
      </span>
    </header>
    <h4 class="lo-skin__title">${t('商店立绘')}<${MicroLabel}>SHOP ART<//></h4>
    <${SkinGroup} ...${shared} name="portrait" ariaLabel=${t('选择商店立绘')} tall=${true}
      leading=${leading}
      chosenId=${chosenPortrait} art=${(x) => skinPortrait(charId, x.id)}
      onPick=${(id) => (id ? setPortrait(chessId, id) : clearPortrait(chessId))} />
    <h4 class="lo-skin__title">${t('战斗模型')}<${MicroLabel}>BATTLE MODEL<//></h4>
    <${SkinGroup} ...${shared} name="model" ariaLabel=${t('选择战斗模型')} thumbnails=${false}
      leading=${[{ id: '', name: t('默认'), note: 'DEFAULT' }]}
      chosenId=${chosen} art=${() => null}
      onPick=${(id) => (id ? setSkin(chessId, id) : clearSkin(chessId))} />
    <div class="lo-model" data-testid="model-preview">
      <div class="lo-model__box" data-live=${live ? '1' : null}>
        <img class="lo-model__art" src=${previewUrl || TRANSPARENT_PX} alt="" />
        <div class="lo-model__live" ref=${setBoxNode}></div>
      </div>
      <p class="lo-model__cap">${t('当前战斗模型：{name}', { name: previewName })}${currentClip ? ` · ${clipLabel(currentClip)}` : ''}${clipTotal ? ` · ${t('共 {n} 段动画', { n: clipTotal })}` : ''}${note}</p>
      <div class="lo-model__clips" role="group" aria-label=${t('预览动画')}>
        ${[...primaryClips, ...(extraOpen ? extraClips : [])].map((c) => html`<button key=${c.id} type="button" data-clip=${c.id} title=${c.names.join(' > ')}
            aria-pressed=${(clipId || 'idle') === c.id ? 'true' : 'false'}
            class=${cx('lo-clipbtn', (clipId || 'idle') === c.id && 'is-on')}
            onClick=${() => setClipId(c.id)}>${clipLabel(c)}</button>`)}
        ${extraClips.length ? html`<button key="more" type="button" data-clip-more="1" aria-expanded=${extraOpen ? 'true' : 'false'}
            class=${cx('lo-clipbtn', 'lo-clipbtn--more', extraOpen && 'is-on')}
            onClick=${() => setExtraOpen((v) => !v)}>${extraOpen ? t('收起') : t('更多动画')} <b class="num">${extraClips.length}</b></button>` : null}
      </div>
    </div>
    <p class="lo-skin__hint">${t('战斗模型决定局内小人的样子（队友也看得见）；商店立绘只影响你自己看到的商店卡，两者互不影响。')}</p>
  </section>`;
}
