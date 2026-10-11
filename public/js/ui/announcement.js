import { useEffect, useLayoutEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon, Modal, useTicker } from './components.js';
import { createStore, useStore } from '../store.js';
import { startAnnouncementPolling } from './announcementClient.js';
import { createAnnouncementDisplay } from './announcementDisplay.js';
import { t } from '../../../shared/i18n.js';

const announcementUi = createStore({ open: false });
const openAnnouncement = () => announcementUi.set({ open: true });

export function AnnouncementButton({ class: cls, square = false, variant = 'ghost' }) {
  return html`<${Button} class=${cls} size="sm" variant=${variant} square=${square} icon="info"
    title=${t('服务器公告')} aria-label=${t('服务器公告')} onKeyDown=${(e) => e.stopPropagation()}
    onClick=${openAnnouncement}>${square ? null : t('公告')}<//>`;
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

// One polling host supplies both the strip and the manually opened viewer on every screen.
export function AnnouncementBanner() {
  const [notice, setNotice] = useState(null);
  const { open } = useStore((s) => s, Object.is, announcementUi);
  const [display] = useState(() => {
    let storage; try { storage = globalThis.localStorage; } catch { storage = null; }
    return createAnnouncementDisplay({ storage });
  });
  const [, setDismissed] = useState(0);
  useEffect(() => startAnnouncementPolling({ onChange: setNotice }), []);
  const active = notice && performance.now() < notice.deadline;
  useTicker(active ? 1000 : 0);
  const dismiss = () => {
    display.dismiss(notice);
    setDismissed((count) => count + 1);
  };
  const close = () => announcementUi.set({ open: false });
  return html`
    ${active && !display.isDismissed(notice) ? html`<${AnnouncementStrip} key=${notice.id} notice=${notice} onClose=${dismiss} />` : null}
    <${Modal} open=${open} title=${t('服务器公告')} micro="ANNOUNCEMENT" tone="amber" width="7.2rem" onClose=${close}
      class="announcement-detail">
      <${Button} class="announcement-detail__close" size="sm" variant="ghost" square icon="close"
        title=${t('关闭公告')} aria-label=${t('关闭公告')} onClick=${close} />
      ${active ? html`<h3 class="announcement-detail__title">${notice.title}</h3>
        <p class="announcement-detail__text">${notice.text}</p>` : html`<p>${t('当前暂无公告')}</p>`}
    <//>`;
}
