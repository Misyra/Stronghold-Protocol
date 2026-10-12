// ui/pluginPanel.js — the room's 插件 panel (DESIGN §32 P1a; the design study's §7.1) and the list of a server's plugins.
// Loaded only when one of them opens (the room's tag, ui/pluginTag.js; the title screen's button, screens/title.js), so
// the title page and the room carry none of it:
//
//   * PluginPanel — the cosmetic plugins this server has for rooms (the catalogue: content.js loadCatalog — fetched when
//     the panel opens, and only on a server that has plugins: content.plugins > 0), each with its
//     switch for the host and its state for everybody else (the other players and the spectators read it), its version,
//     authors, size and a 非官方 mark; 「自动」 on one switched on because another needs it; the warnings of the room's set
//     (two plugins change the same art — the later one applies; a plugin made for other game versions, still usable:
//     art never changes a battle). The host's switch sends room.setPlugins with the plugins it wants (the server adds
//     what they require); during a match it is read-only. 「重新应用」 (the host, a room with plugins) sends the same
//     choice again: when a plugin's files changed on the server since (the lobby tells the host: an m.toast), that
//     makes the set of the files as they are now. Art only in this version: the battles stay the original ones.
//   * InstalledPlugins — the title screen's 「本服务器安装了 N 个插件」 (screens/title.js; §7.4): every unofficial plugin
//     the catalogue lists — any class, with what this version does with it (the catalogue fetched when it opens).
// The tag and the small facts (roomPluginFacts, sizeText, pluginTagText, pluginMicro) are ui/pluginTag.js's, re-exported
// here. Texts go through t() (docs/I18N.md).

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { APP_VERSION } from '../../../shared/constants.js';
import { html, Modal, Button, Icon } from './components.js';
import { toastError } from './toasts.js';
import { net } from '../net.js';
import { useStore } from '../store.js';
import { catalog, loadCatalog, cosmeticPlugins, installedCount, pluginName, unofficialPlugins } from '../content.js';
import { t, tc, N_ } from '../../../shared/i18n.js';
import { sizeText, roomPluginFacts, pluginTagText, pluginMicro } from './pluginTag.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

export { sizeText, roomPluginFacts, pluginTagText, pluginMicro };

/**
 * The ids room.setPlugins sends when the host switches `id` on or off: the plugins the host chose, without the
 * automatic ones (the server adds what the chosen ones require) and without one the server no longer offers (`offered`:
 * the ids of the catalogue's room plugins, once it is loaded — removed, skipped or of another scope now: sending it again
 * would refuse every switch). null while the catalogue is not loaded: the choice is sent as it is.
 * @param {string[]} chosen @param {string} id @param {boolean} on @param {Set<string> | null} [offered]
 * @returns {string[]}
 */
export function nextChoice(chosen, id, on, offered = null) {
  const out = chosen.filter((x) => x !== id && (!offered || offered.has(x)));
  if (on) out.push(id);
  return out;
}

/** One warning of the room's set as a sentence (room.state.content.warnings, server/plugins/visualSet.js). */
function warningText(w, nameOf) {
  if (w.code === 'override' && Array.isArray(w.params?.plugins)) {
    const [a, b] = w.params.plugins;
    return t('「{a}」和「{b}」都改了 {path}（后者生效）', { a: nameOf(a), b: nameOf(b), path: String(w.params.path || '') });
  }
  if (w.code === 'app') return t('「{name}」适配 {app}，本服务器是 {version}（外观插件，仍可使用）', { name: nameOf(w.params?.id), app: String(w.params?.app || ''), version: APP_VERSION });
  return w.code;
}

/** The room's 插件 panel (see the header). */
export function PluginPanel({ open, room, myId, onClose }) {
  const cat = useStore((s) => s, Object.is, catalog);
  const installed = useStore(installedCount);
  const [busy, setBusy] = useState(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  // the catalogue — again each time the panel opens (a plugin dropped in meanwhile shows), never on a server without any
  useEffect(() => { alive.current = true; if (installed) loadCatalog({ force: true }); return () => { alive.current = false; }; }, [installed]);
  const f = roomPluginFacts(room, myId);
  const offered = installed ? cosmeticPlugins(cat.plugins, 'room') : [];
  const offeredIds = cat.status === 'ready' ? new Set(offered.map((p) => p.id)) : null;
  // a plugin the room has that the catalogue no longer offers (removed, skipped, another scope now) still shows, by its
  // id: its switch only turns it off
  const rows = [...offered, ...f.plugins.filter((p) => !offered.some((o) => o.id === p.id)).map((p) => ({ id: p.id, version: p.version, missing: true }))];
  const nameOf = (id) => { const p = cat.plugins.find((x) => x.id === id); return p ? pluginName(p) : String(id ?? ''); };
  /** room.setPlugins with these ids (one request at a time; `what`: the row — or 'reapply' — that shows it busy). */
  const send = async (ids, what) => {
    if (inFlight.current || !f.editable) return;
    inFlight.current = true;
    setBusy(what);
    try {
      await net.request('room.setPlugins', { plugins: ids.map((x) => ({ id: x })) });
    } catch (err) { toastError(err); } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };
  const toggle = (id, on) => send(nextChoice(f.chosen, id, on, offeredIds), id);
  // the same choice again (without a plugin the server no longer offers): the set of the files as they are now
  const reapply = () => send(f.chosen.filter((x) => !offeredIds || offeredIds.has(x)), 'reapply');
  return html`<${Modal} open=${open} onClose=${onClose} title=${t('插件')} micro="PLUGINS" width="7.4rem"
      actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>${t('完成')}<//>`}>
    <div class="plugpanel" data-testid="plugin-panel">
      <p class="plugpanel__lead">
        <span class=${cx('plugtag plugtag--static', f.count && 'is-modded')}>${f.count ? t('插件 ×{n}', { n: f.count }) : t('原版')}</span>
        ${t('房间的外观插件只改变画面和声音，不影响战斗；插件为非官方制作。')}
      </p>
      ${f.inMatch ? html`<p class="set-hint">${t('模拟进行中，插件不能更改')}</p>`
        : f.editable ? null : html`<p class="set-hint">${t('由创建者设置')}</p>`}
      ${installed && cat.status === 'loading' && !rows.length ? html`<p class="set-hint">${t('正在读取插件列表…')}</p>` : null}
      ${installed && cat.status === 'failed' && !rows.length ? html`<p class="set-hint is-warn">${t('无法读取插件列表')}</p>` : null}
      ${(!installed || cat.status === 'ready') && !rows.length ? html`<p class="set-hint">${t('本服务器没有可在房间中使用的外观插件')}</p>` : null}
      ${rows.length ? html`<ul class="plugpanel__list">
        ${rows.map((p) => {
          const on = f.on.has(p.id);
          const auto = f.auto.has(p.id);
          return html`<li key=${p.id} class=${cx('plugrow', on && 'is-on')} data-plugin=${p.id}>
            <button type="button" role="switch" aria-checked=${on ? 'true' : 'false'} class=${cx('set-toggle plugrow__switch', on && 'is-on')}
              disabled=${!f.editable || !!busy || (p.missing && !on) || (auto && on && !p.missing)} aria-label=${pluginName(p)}
              onClick=${() => toggle(p.id, !on)}><i></i><span>${on ? tc('toggle', '开启') : tc('toggle', '关闭')}</span></button>
            <div class="plugrow__body">
              <div class="plugrow__name"><b>${pluginName(p)}</b>${p.version ? html`<span class="num t-dim">v${p.version}</span>` : null}
                ${auto ? html`<span class="plugrow__badge">${t('自动')}</span>` : null}
                <span class="plugrow__badge">${t('外观')}</span><span class="plugrow__badge is-unofficial">${t('非官方')}</span></div>
              <div class="plugrow__meta t-dim">
                ${Array.isArray(p.authors) && p.authors.length ? html`<span>${t('作者 {names}', { names: p.authors.join(', ') })}</span>` : null}
                ${Number.isFinite(p.artBytes) ? html`<span class="num">${sizeText(p.artBytes)}</span>` : null}
                ${p.missing ? html`<span>${t('本服务器已不再提供')}</span>` : null}
              </div>
              ${p.compatible === false ? html`<div class="plugrow__warn">${t('适配 {app}，本服务器是 {version}（外观插件，仍可使用）', { app: p.app || '', version: APP_VERSION })}</div>` : null}
            </div>
          </li>`;
        })}
      </ul>` : null}
      ${f.editable && f.count ? html`<div class="plugpanel__reapply">
        <${Button} variant="secondary" size="sm" icon="refresh" data-testid="plugin-reapply" disabled=${!!busy} onClick=${reapply}>${t('重新应用')}<//>
        <span class="set-hint">${t('插件的文件在服务器上更新后，重新应用才会生效。')}</span>
      </div>` : null}
      ${f.warnings.filter((w) => w.code !== 'app').length ? html`<ul class="plugpanel__warnings" aria-label=${t('插件提示')}>
        ${f.warnings.filter((w) => w.code !== 'app').map((w, i) => html`<li key=${i}><${Icon} name="warn" />${warningText(w, nameOf)}</li>`)}
      </ul>` : null}
      <p class="set-hint">${t('只影响自己的外观插件在「设置」中开关。')}</p>
    </div>
  <//>`;
}

/** What a class is called in the list (msgids). */
const CLASS_NAMES = { cosmetic: N_('外观'), content: N_('改变玩法'), script: N_('代码'), trusted: N_('代码'), ui: N_('界面'), lang: N_('语言') };

/** The title screen's list of a server's unofficial plugins (see the header): the catalogue, fetched when it opens. */
export function InstalledPlugins({ open, onClose }) {
  const cat = useStore((s) => s, Object.is, catalog);
  useEffect(() => { loadCatalog({ force: true }); }, []);
  const plugins = unofficialPlugins(cat.plugins);
  return html`<${Modal} open=${open} onClose=${onClose} title=${t('本服务器的插件')} micro="PLUGINS" width="6.8rem"
      actions=${html`<${Button} variant="primary" icon="check" onClick=${onClose}>${t('完成')}<//>`}>
    <div class="plugpanel" data-testid="installed-plugins">
      <p class="plugpanel__lead">${t('插件为非官方制作，不属于原版游戏；原版内容始终是默认。')}</p>
      ${cat.status === 'loading' && !plugins.length ? html`<p class="set-hint">${t('正在读取插件列表…')}</p>` : null}
      ${cat.status === 'failed' && !plugins.length ? html`<p class="set-hint is-warn">${t('无法读取插件列表')}</p>` : null}
      <ul class="plugpanel__list">
        ${plugins.map((p) => html`<li key=${p.id} class="plugrow" data-plugin=${p.id}>
          <div class="plugrow__body">
            <div class="plugrow__name"><b>${pluginName(p)}</b>${p.version ? html`<span class="num t-dim">v${p.version}</span>` : null}
              <span class="plugrow__badge">${t(CLASS_NAMES[p.class] || '插件')}</span><span class="plugrow__badge is-unofficial">${t('非官方')}</span></div>
            <div class="plugrow__meta t-dim">
              <span>${p.status === 'loaded' ? t('可以使用') : t('本版本不支持')}</span>
              ${Array.isArray(p.authors) && p.authors.length ? html`<span>${t('作者 {names}', { names: p.authors.join(', ') })}</span>` : null}
            </div>
          </div>
        </li>`)}
      </ul>
    </div>
  <//>`;
}
