// A popup announcement (shared/announcements.js): a Markdown or plain body, an optional link, one dismissal per notice.
import { html, Button, Modal } from './components.js';
import { renderAnnouncementMarkdown } from './announcementMarkdown.js';
import { t } from '../../../shared/i18n.js';

export function AnnouncementPopup({ popup, onClose }) {
  const body = popup.format === 'markdown'
    ? renderAnnouncementMarkdown(popup.text)
    : html`<p class="announcement-detail__text">${popup.text}</p>`;
  return html`<${Modal} open=${true} title=${popup.title || t('公告')} micro="ANNOUNCEMENT" tone="amber" width="8rem"
      onClose=${onClose} utility=${true} class="announcement-popup"
      actions=${html`${popup.url ? html`<${Button} variant="secondary" icon="external"
          onClick=${() => globalThis.open(popup.url, '_blank', 'noopener,noreferrer')}>${t('查看详情')}<//>` : null}
        <${Button} variant="primary" onClick=${onClose}>${t('我知道了')}<//>`}>
    <div class="announcement-popup__body">${body}</div>
  <//>`;
}
