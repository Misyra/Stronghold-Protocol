// Layout adapted from xinhai-ai/Stronghold-Protocol's communication panel: shared emote/history area + composer.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Icon } from './components.js';
import { GIcon } from './gameComponents.js';
import { EmoteWheel } from './emotes.js';
import { useStore } from '../store.js';
import { actions } from './gameActions.js';
import { t } from '../../../shared/i18n.js';

const cx = (...parts) => parts.filter(Boolean).join(' ');

/** The server refuses flagged messages outright, so only clean text ever reaches this panel; never render markup from a message. */
export function Communication({ open, onToggle }) {
  const chat = useStore(s => s.chat), online = useStore(s => s.connection.status === 'online');
  const myId = useStore(s => s.me.playerId);
  const [draft, setDraft] = useState(''), [sending, setSending] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [view, setView] = useState('emotes');
  const [now, setNow] = useState(() => performance.now()), [cooldown, setCooldown] = useState(0);
  useEffect(() => { if (!open || !chat.enabled) setHelpOpen(false); }, [open, chat.enabled]);
  useEffect(() => { if (!chat.enabled) setView('emotes'); }, [chat.enabled]);
  useEffect(() => {
    if (!open || !chat.enabled) return;
    const timer = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(timer);
  }, [open, chat.enabled]);
  const length = [...draft].length, muted = chat.deadline > now;
  const minutes = Math.max(1, Math.ceil((chat.deadline - now) / 60000));
  const rules = t('每条最多 30 字；包含不适宜内容的消息无法发送，多次违规将暂停聊天。');
  const toolbar = chat.enabled ? html`<header class="ewheel__chat-toolbar">
    <strong>${t('局内聊天')}</strong>
    <button type="button" class="ewheel__chat-help" aria-label=${t('聊天规则')} aria-expanded=${helpOpen} title=${rules}
      onClick=${() => setHelpOpen(value => !value)} onBlur=${() => setHelpOpen(false)}><${Icon} name="info" /></button>
    <button type="button" class="ewheel__chat-close" aria-label=${t('关闭')} onClick=${() => onToggle(false)}><${Icon} name="close" /></button>
  </header>` : null;
  const navigation = chat.enabled ? html`<nav class="ewheel__chat-tabs" aria-label=${t('交流')}>
    <button type="button" class=${cx('ewheel__chat-tab', view === 'emotes' && 'is-on')} aria-label=${t('表情')}
      aria-pressed=${view === 'emotes'} onClick=${() => setView('emotes')}><${GIcon} name="emote" /><span>${t('表情')}</span></button>
    <button type="button" class=${cx('ewheel__chat-tab', view === 'history' && 'is-on')} aria-label=${t('聊天记录')}
      title=${t('聊天记录')} aria-pressed=${view === 'history'} onClick=${() => setView('history')}><${Icon} name="book" />
      <span class="ewheel__chat-total">${chat.messages.length}</span></button>
  </nav>` : null;
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
          disabled=${muted || !online} onInput=${e => { if (!e.isComposing) e.currentTarget.value = [...e.currentTarget.value].slice(0, 30).join(''); setDraft(e.currentTarget.value); }}
          onCompositionEnd=${e => { e.currentTarget.value = [...e.currentTarget.value].slice(0, 30).join(''); setDraft(e.currentTarget.value); }}
          onKeyDown=${e => { if (e.key === 'Enter' && (e.isComposing || e.keyCode === 229)) { e.preventDefault(); e.stopPropagation(); } }} />
          <span class="ewheel__chat-count" aria-live="polite">${length}/30</span></label>
        <button type="submit" class="ewheel__chat-send" disabled=${sending || muted || !online || !draft.trim() || length > 30 || cooldown > now}>${t('发送')}</button>
      </form>
      ${helpOpen ? html`<p class="ewheel__chat-rules" role="tooltip">${rules}</p>` : null}
      ${muted ? html`<p class="ewheel__chat-note" role="status">${t('聊天已暂停，剩余约 {minutes} 分钟', { minutes })}</p>` : null}
    </section>` : null;
  return html`<${EmoteWheel} open=${open} onToggle=${value => { setNow(performance.now()); onToggle(value); }}
    onSend=${id => actions.emote(id)} disabled=${!online} toolbar=${toolbar} navigation=${navigation}
    content=${chat.enabled && view === 'history' ? html`<${ChatHistory} messages=${chat.messages} myId=${myId} />` : null}
    footer=${composer} />`;
}

/** Follow new messages only while already at the bottom; reading older messages must not jump the scroll. */
function ChatHistory({ messages, myId }) {
  const list = useRef(null), follow = useRef(true);
  useEffect(() => {
    if (follow.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [messages]);
  return html`<section class="ewheel__chat-history" ref=${list} role="log" aria-label=${t('聊天记录')} aria-live="polite"
    onScroll=${e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
    ${messages.length ? messages.map(entry => html`<div key=${entry.id} class=${cx('ewheel__chat-entry', entry.playerId === myId && 'is-self')}>
      <div class="ewheel__chat-meta"><strong>${entry.name}${entry.playerId === myId ? ` (${t('你')})` : ''}</strong>
        <time dateTime=${new Date(entry.at).toISOString()}>${new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
      <p>${entry.text}</p>
    </div>`) : html`<p class="ewheel__chat-empty">${t('暂无消息')}</p>`}
  </section>`;
}
