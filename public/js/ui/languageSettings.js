// The lobby's single language entry opens independent interface and operator-voice preferences.
import { useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon, MicroLabel, Modal, Fragment } from './components.js';
import { LangToggle, useLang, machineTranslationNote } from './lang.js';
import { useVoiceLanguage, setVoiceLanguage } from './voiceLanguage.js';
import { t, N_ } from '../../../shared/i18n.js';

const VOICE_OPTIONS = [
  { code: 'cn', label: N_('中文'), micro: 'CN' },
  { code: 'jp', label: N_('日语'), micro: 'JP' },
  { code: 'en', label: N_('英语'), micro: 'EN' },
  { code: 'kr', label: N_('韩语'), micro: 'KR' },
];

export function LanguageSettings() {
  useLang();
  const voice = useVoiceLanguage();
  const note = machineTranslationNote();
  return html`<section class="language-options" aria-label=${t('语言与配音')}>
    <div class="set-row language-options__row">
      <span class="set-row__label"><${Icon} name="signal" />${t('界面语言')}<${MicroLabel}>INTERFACE<//></span>
      <${LangToggle} class="set-lang" />
    </div>
    ${note ? html`<p class="set-hint set-lang-note" data-testid="lang-mt-note">${note}</p>` : null}
    <div class="set-row language-options__row">
      <span class="set-row__label"><${Icon} name="mic" />${t('干员配音')}<${MicroLabel}>VOICE<//></span>
      <div class="set-seg voice-language-toggle" role="radiogroup" aria-label=${t('干员配音')} data-testid="voice-language-toggle">
        ${VOICE_OPTIONS.map(option => html`<button key=${option.code} type="button" role="radio" aria-checked=${voice === option.code ? 'true' : 'false'}
          class=${voice === option.code ? 'is-on' : ''} data-voice-lang=${option.code} onClick=${() => setVoiceLanguage(option.code)}>
          ${t(option.label)}<span class="voice-language-code">${option.micro}</span>
        </button>`)}
      </div>
    </div>
    <p class="set-hint language-options__hint">${t('界面语言与配音分别保存，仅影响本浏览器，不改变队友的设置。')}</p>
    <p class="set-hint language-options__hint">${t('部分干员暂无英语或韩语配音；所选配音缺失或无法载入时，使用中文配音。')}</p>
  </section>`;
}

export function LanguageButton({ class: cls }) {
  useLang();
  const [open, setOpen] = useState(false);
  return html`<${Fragment}>
    <${Button} variant="secondary" size="sm" icon="mic" class=${`lobby-language${cls ? ` ${cls}` : ''}`} data-testid="lobby-language"
      aria-haspopup="dialog" title=${t('语言与配音')} onClick=${() => setOpen(true)}>${t('语言')}<//>
    <${Modal} open=${open} onClose=${() => setOpen(false)} title=${t('语言与配音')} micro="LANGUAGE & VOICE"
      class="language-dialog lobby-dialog" ariaLabel=${t('语言与配音')} trapFocus=${true}
      actions=${html`<${Button} variant="primary" icon="check" onClick=${() => setOpen(false)}>${t('完成')}<//>`}>
      <${LanguageSettings} />
    <//>
  <//>`;
}
