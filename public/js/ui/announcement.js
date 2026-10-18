import { useEffect, useLayoutEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon, Modal, useTicker } from './components.js';
import { createStore, useStore } from '../store.js';
import { startAnnouncementPolling } from './announcementClient.js';
import { createAnnouncementDisplay } from './announcementDisplay.js';
import { AnnouncementPopup } from './announcementPopup.js';
import { t } from '../../../shared/i18n.js';

const announcementUi = createStore({ open: false, notice: null, popup: null });
const openAnnouncement = () => announcementUi.set({ open: true });

export function AnnouncementButton({ class: cls, square = false, variant = 'ghost' }) {
  return html`<${Button} class=${cls} size="sm" variant=${variant} square=${square} icon="info"
    title=${t('服务器公告')} aria-label=${t('服务器公告')} onKeyDown=${(e) => e.stopPropagation()}
    onClick=${openAnnouncement}>${square ? null : t('公告')}<//>`;
}

// The lobby preview shares the banner's polling host, including expiry and withdrawal.
export function AnnouncementCard() {
  const notice = useStore((s) => s.notice, Object.is, announcementUi);
  const active = notice && performance.now() < notice.deadline;
  useTicker(active ? 1000 : 0);
  return html`<button type="button" class="hub-notice" aria-label=${t('查看完整公告')}
    onKeyDown=${(e) => e.stopPropagation()} onClick=${openAnnouncement}>
    <span class="hub-notice__head"><span class="hub-notice__label">${t('公告')}<small>NOTICE</small></span>
      <span class="hub-notice__view">${t('查看')}<${Icon} name="chevronRight" /></span></span>
    ${active ? html`<strong class="hub-notice__title">${notice.title}</strong>
      <span class="hub-notice__text">${notice.text}</span>`
      : html`<span class="hub-notice__text hub-notice__text--empty">${t('当前暂无公告')}</span>`}
  </button>`;
}

function AnnouncementStrip({ notice, onClose }) {
  const viewport = useRef(null);
  const content = useRef(null);
  const [distance, setDistance] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      const width = content.current?.scrollWidth || 0;
      setDistance(width > (viewport.current?.clientWidth || 0) ? width + 48 : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport.current);
    observer.observe(content.current);
    return () => observer.disconnect();
  }, [notice.title, notice.text]);
  const line = html`<span class="announcement__text">${notice.text}</span>`;
  return html`<aside class="announcement brackets" role="status" aria-live="polite" aria-label=${t('服务器公告')}>
    <${Icon} name="warn" class="announcement__icon" />
    <button type="button" class="announcement__content" ref=${viewport} title=${t('查看完整公告')}
      aria-label=${t('查看完整公告')} onKeyDown=${(e) => e.stopPropagation()} onClick=${openAnnouncement}>
      <span class=${`announcement__track${distance ? ' is-scrolling' : ''}`}
        style=${`--announcement-distance:-${distance}px;--announcement-duration:${Math.max(12, distance / 40)}s`}>
        <span class="announcement__line" ref=${content}>${line}</span>
        ${distance ? html`<span class="announcement__line" aria-hidden="true"><span>${notice.text}</span></span>` : null}
      </span>
    </button>
    <${Button} size="sm" variant="ghost" square icon="close" title=${t('关闭公告')} aria-label=${t('关闭公告')}
      onKeyDown=${(e) => e.stopPropagation()} onClick=${onClose} />
  </aside>`;
}

// One polling host supplies the strip, lobby preview and manually opened viewer on every screen.
export function AnnouncementBanner() {
  const { open, notice } = useStore((s) => s, Object.is, announcementUi);
  const [display] = useState(() => {
    let storage; try { storage = globalThis.localStorage; } catch { storage = null; }
    return createAnnouncementDisplay({ storage });
  });
  const [, setDismissed] = useState(0);
  useEffect(() => startAnnouncementPolling({ onChange: (notice, popup) => announcementUi.set({ notice, popup }) }), []);
  const active = notice && performance.now() < notice.deadline;
  useTicker(active ? 1000 : 0);
  const dismiss = () => {
    display.dismiss(notice);
    setDismissed((count) => count + 1);
  };
  const close = () => announcementUi.set({ open: false });
  const popup = useStore((s) => s.popup, Object.is, announcementUi);
  const popupLive = !!popup && (popup.deadline === Infinity || performance.now() < popup.deadline);
  const [popupDismissed, setPopupDismissed] = useState(() => ({ id: null, seen: false }));
  const seenPopup = (id) => {
    try { return globalThis.localStorage?.getItem('sp.announcement.popup.' + id) === '1'; } catch { return false; }
  };
  const closePopup = () => {
    try { globalThis.localStorage?.setItem('sp.announcement.popup.' + popup.id, '1'); } catch { /* in-memory only */ }
    setPopupDismissed({ id: popup.id, seen: true });
  };
  const showPopup = popupLive && popup.autoPopup !== false
    && !(popupDismissed.id === popup.id && popupDismissed.seen) && !seenPopup(popup.id);
  return html`
    ${showPopup ? html`<${AnnouncementPopup} key=${popup.id} popup=${popup} onClose=${closePopup} />` : null}
    ${active && !display.isDismissed(notice) ? html`<${AnnouncementStrip} key=${notice.id} notice=${notice} onClose=${dismiss} />` : null}
    <${Modal} open=${open} title=${t('服务器公告')} micro="ANNOUNCEMENT" tone="amber" width="7.2rem" onClose=${close} utility=${true}
      class="announcement-detail">
      ${active ? html`<p class="announcement-detail__text">${notice.text}</p>` : html`<p>${t('当前暂无公告')}</p>`}
    <//>`;
}
