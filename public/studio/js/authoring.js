import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button } from '../../js/ui/components.js';
import { t } from '../../../shared/i18n.js';
import { editorOf } from './editors/index.js';

export function Authoring({ state, busy, onSave, onDraft, initialDraft }) {
  const [draft, setDraft] = useState(initialDraft || { ...state.authoring, id: state.id });
  const baseline = JSON.stringify(state.authoring);
  useEffect(() => { const next = initialDraft?.revision === state.authoring.revision ? initialDraft : { ...state.authoring, id: state.id }; setDraft(next); onDraft(next); }, [baseline]);
  const Component = editorOf(draft.template).Component;
  const change = next => { setDraft(next); onDraft(next); };
  const dirty = JSON.stringify({ ...draft, id: undefined }) !== baseline;
  return html`<section class="st-authoring" data-testid="authoring">
    ${Component ? html`<${Component} draft=${draft} state=${state} onChange=${change} />` : null}
    ${draft.template !== 'script' ? html`<${Button} variant="primary" data-testid="save-wizard" disabled=${busy || !dirty} loading=${busy} onClick=${() => onSave(draft)}>${t('保存修改')}<//>` : null}
  </section>`;
}
