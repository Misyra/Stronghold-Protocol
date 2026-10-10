import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button } from './components.js';
import { EmoteWheel } from './emotes.js';
import { useStore } from '../store.js';
import { actions } from './gameActions.js';
import { t } from '../../../shared/i18n.js';

/** All message text here has already been masked by the server; never render markup from a message. */
export function Communication({ open, onToggle }) {
  const chat = useStore(s => s.chat), online = useStore(s => s.connection.status === 'online');
  const [draft, setDraft] = useState(''), [sending, setSending] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [now, setNow] = useState(() => performance.now()), [cooldown, setCooldown] = useState(0);
  useEffect(() => { if (!open || !chat.enabled) setHelpOpen(false); }, [open, chat.enabled]);
  useEffect(() => {
    if (!open || !chat.enabled) return;
    const timer = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(timer);
  }, [open, chat.enabled]);
  const length = [...draft].length, muted = chat.deadline > now;
  const minutes = Math.max(1, Math.ceil((chat.deadline - now) / 60000));
  const rules = t('每条最多 30 字；敏感内容会替换为星号，10 分钟内累计 5 条触发审查将暂停聊天 12 小时。');
  const submit = async (e) => {
    e.preventDefault();
    if (sending || !chat.enabled || !online || chat.deadline > performance.now() || cooldown > performance.now() || !draft.trim() || length > 30) return;
    setSending(true);
    try {
      if (await actions.chat(draft)) { setDraft(''); setCooldown(performance.now() + 1000); onToggle(false); }
    } finally { setSending(false); setNow(performance.now()); }
  };
  const composer = chat.enabled ? html`<section class="ewheel__chat" aria-label=${t('局内聊天')}>
      <form class="ewheel__chat-form" onSubmit=${submit}>
        <label class="field__box"><input class="field__input" aria-label=${t('聊天消息')} placeholder=${t('请文明交流')} value=${draft} maxlength="60" autocomplete="off"
          disabled=${muted || !online} onInput=${e => setDraft(e.currentTarget.value)}
          onKeyDown=${e => { if (e.key === 'Enter' && (e.isComposing || e.keyCode === 229)) { e.preventDefault(); e.stopPropagation(); } }} />
          <span class="ewheel__chat-count" aria-live="polite">${length}/30</span></label>
        <div class="ewheel__chat-send">
          <${Button} type="submit" variant="primary" size="sm" disabled=${sending || muted || !online || !draft.trim() || length > 30 || cooldown > now}>${t('发送')}<//>
          <button type="button" class="ewheel__chat-help" aria-label=${t('聊天规则')} aria-expanded=${helpOpen} title=${rules}
            onClick=${() => setHelpOpen(value => !value)} onBlur=${() => setHelpOpen(false)}>?</button>
        </div>
      </form>
      ${helpOpen ? html`<p class="ewheel__chat-rules" role="tooltip">${rules}</p>` : null}
      ${muted ? html`<p class="ewheel__chat-note" role="status">${t('聊天已暂停，剩余约 {minutes} 分钟', { minutes })}</p>` : null}
    </section>` : null;
  return html`<${EmoteWheel} open=${open} onToggle=${value => { setNow(performance.now()); onToggle(value); }}
    onSend=${id => actions.emote(id)} disabled=${!online} header=${composer} />`;
}
