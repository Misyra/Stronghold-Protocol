import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon, useTicker } from './components.js';
import { startAnnouncementPolling } from './announcementClient.js';
import { createAnnouncementDisplay } from './announcementDisplay.js';
import { t } from '../../../shared/i18n.js';

// Dismissible server announcement, shown on every screen (title, lobby, room, match) from page load:
// a maintenance notice must reach players before they enter a match, not only inside one.
export function AnnouncementBanner() {
  const [notice, setNotice] = useState(null);
  const [display] = useState(() => {
    let storage; try { storage = globalThis.localStorage; } catch { storage = null; }
    return createAnnouncementDisplay({ storage });
  });
  const [, setDismissed] = useState(0);
  useEffect(() => startAnnouncementPolling({ onChange: setNotice }), []);
  const visible = notice && !display.isDismissed(notice) && performance.now() < notice.deadline;
  useTicker(visible ? 1000 : 0);
  if (!visible) return null;
  const dismiss = () => {
    display.dismiss(notice);
    setDismissed((count) => count + 1);
  };
  return html`<aside class="announcement brackets" role="status" aria-live="polite" aria-label=${t('服务器公告')}>
    <${Icon} name="warn" class="announcement__icon" />
    <div class="announcement__content">
      <strong class="announcement__title">${notice.title}</strong>
      <p class="announcement__text">${notice.text}</p>
    </div>
    <${Button} size="sm" variant="ghost" square icon="close" title=${t('关闭公告')} aria-label=${t('关闭公告')}
      onKeyDown=${(e) => e.stopPropagation()} onClick=${dismiss} />
  </aside>`;
}
