// ui/pluginTag.js — the room's plugin tag and the small facts the screens show of plugins (DESIGN §32 P1a): kept apart
// from the 插件 panel (ui/pluginPanel.js), which loads only when it opens, so the title page and the room carry just this.
//
//   * PluginTag — the tag at the top of the room (screens/room.js): 「原版」, or 「插件 ×N」 once its host switched plugins
//     on; a tap loads the panel (ui/pluginPanel.js PluginPanel) and opens it.
//   * roomPluginFacts — what the room's plugins are for this player; pluginTagText, sizeText, pluginMicro — their words.
// Texts go through t() (docs/I18N.md).

import { useState } from '../../vendor/hooks.module.js';
import { html, Icon } from './components.js';
import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/** A size in KB / MB. @param {number} n */
export const sizeText = (n) => (!Number.isFinite(n) ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * What the room's plugins are for this player: `count` (0 = the original art), the ids switched on and those switched on
 * automatically, whether this player may change them (the host, outside a match), the room's warnings.
 * @param {any} room room.state payload
 * @param {any} myId
 */
export function roomPluginFacts(room, myId) {
  const list = Array.isArray(room?.content?.plugins) ? room.content.plugins.filter((p) => p && typeof p.id === 'string') : [];
  return {
    count: list.length,
    plugins: list,
    on: new Set(list.map((p) => p.id)),
    auto: new Set(list.filter((p) => p.auto).map((p) => p.id)),
    chosen: list.filter((p) => !p.auto).map((p) => p.id),
    editable: room?.hostId != null && room.hostId === myId && !room.inMatch,
    inMatch: !!room?.inMatch,
    warnings: Array.isArray(room?.content?.warnings) ? room.content.warnings.filter((w) => w && typeof w.code === 'string') : [],
    vs: typeof room?.content?.vs === 'string' ? room.content.vs : null,
  };
}

/** What the tag says: 「插件 ×N」 or 「原版」. @param {any} room */
export const pluginTagText = (room) => { const n = roomPluginFacts(room, null).count; return n ? t('插件 ×{n}', { n }) : t('原版'); };

/** A label for a catalogue entry's micro line in 设置 (ui/settings.js). @param {any} p */
export const pluginMicro = (p) => [p?.id, p?.version ? `v${p.version}` : null, Number.isFinite(p?.artBytes) ? sizeText(p.artBytes) : null].filter(Boolean).join(' · ');

/** The tag at the top of the room: 「原版」 or 「插件 ×N」; a tap loads the panel and opens it. */
export function PluginTag({ room, myId }) {
  // the panel's component once loaded (a function in state: set through an updater)
  const [Panel, setPanel] = useState(null);
  const f = roomPluginFacts(room, myId);
  const open = () => {
    import('./pluginPanel.js').then((m) => setPanel(() => m.PluginPanel), (err) => console.warn('[plugins] the panel did not load', err));
  };
  return html`<button type="button" class=${cx('plugtag', f.count && 'is-modded')} data-testid="plugin-tag" onClick=${open}
      title=${t('插件')} aria-label=${f.count ? t('插件 ×{n}', { n: f.count }) : t('原版')}>
    <${Icon} name=${f.count ? 'edit' : 'check'} />${f.count ? t('插件 ×{n}', { n: f.count }) : t('原版')}
  </button>
  ${Panel ? html`<${Panel} open=${true} room=${room} myId=${myId} onClose=${() => setPanel(null)} />` : null}`;
}
