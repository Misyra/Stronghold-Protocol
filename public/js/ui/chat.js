import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Modal, Button } from './components.js';
import { useStore } from '../store.js';
import { actions } from './gameActions.js';
import { t } from '../../../shared/i18n.js';

/** All message text here has already been masked by the server; never render markup from a message. */
export function ChatPanel({ spectator = false }) {
  const chat = useStore(s => s.chat), online = useStore(s => s.connection.status === 'online');
  const [open, setOpen] = useState(false), [draft, setDraft] = useState(''), [sending, setSending] = useState(false);
  const [now, setNow] = useState(() => performance.now()), [seen, setSeen] = useState(0), [cooldown, setCooldown] = useState(0);
  const list = useRef(null);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setSeen(chat.messages.at(-1)?.id || 0);
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [open, chat.messages]);
  if (!chat.enabled) return null;
  const length = [...draft].length, muted = chat.deadline > now;
  const minutes = Math.max(1, Math.ceil((chat.deadline - now) / 60000));
  const unread = chat.messages.filter(m => m.id > seen).length;
  const submit = async (e) => {
    e.preventDefault();
    if (sending || !online || spectator || chat.deadline > performance.now() || cooldown > performance.now() || !draft.trim() || length > 30) return;
    setSending(true);
    try {
      if (await actions.chat(draft)) { setDraft(''); setCooldown(performance.now() + 1000); }
    } finally { setSending(false); setNow(performance.now()); }
  };
  return html`<button type="button" class="gm__gear gm__chat" aria-label=${t('局内聊天')} title=${t('局内聊天')}
      onClick=${() => { setNow(performance.now()); setOpen(true); }}>${t('聊天')}${unread ? html`<small>${unread}</small>` : null}</button>
    <${Modal} open=${open} title=${t('局内聊天')} width="min(480px, 94vw)" onClose=${() => setOpen(false)}
      actions=${html`<${Button} onClick=${() => setOpen(false)}>${t('关闭')}<//>`}>
      <div ref=${list} role="log" aria-live="polite" aria-label=${t('聊天记录')}
        style="height:min(36vh,280px);overflow:auto;overflow-wrap:anywhere;user-select:text">
        ${chat.messages.length ? chat.messages.map(m => html`<p key=${m.id}><b>${m.name}</b>：${m.text}</p>`) : html`<p>${t('暂无消息')}</p>`}
      </div>
      <p role="status">${muted ? t('聊天已暂停，剩余约 {minutes} 分钟', { minutes }) : t('每条最多 30 字；敏感内容会替换为星号，连续 5 条触发审查将暂停聊天 12 小时。')}</p>
      ${spectator ? html`<p>${t('观战玩家只能查看聊天')}</p>` : html`<form onSubmit=${submit} style="display:flex;gap:8px;align-items:center">
        <label class="field__box" style="min-width:0;flex:1"><input class="field__input" data-autofocus aria-label=${t('聊天消息')} value=${draft} maxlength="60" autocomplete="off"
          disabled=${muted || !online} onInput=${e => setDraft(e.currentTarget.value)}
          onKeyDown=${e => { if (e.key === 'Enter' && (e.isComposing || e.keyCode === 229)) { e.preventDefault(); e.stopPropagation(); } }} style="min-width:0;flex:1" /></label>
        <span aria-live="polite">${length}/30</span>
        <${Button} type="submit" variant="primary" size="sm" disabled=${sending || muted || !online || !draft.trim() || length > 30 || cooldown > now}>${t('发送')}<//>
      </form>`}
    <//>`;
}
