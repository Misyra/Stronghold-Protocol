// Manifest-driven controls shared by the room panel and the studio's trial selector.
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button } from './components.js';
import { getLang, t } from '../../../shared/i18n.js';
import { normalizeSettings } from '../../../shared/plugins/patch.js';

export function settingsSelection(ids, plugins, change = null) {
  return ids.map(id => {
    const settings = change?.id === id ? change.settings : plugins.find(p => p.id === id)?.settings;
    return { id, ...(settings && Object.keys(settings).length ? { settings } : {}) };
  });
}
export const settingValue = (def, input) => def.type === 'boolean' ? !!input : def.type === 'enum' ? def.options[Number(input)] : Number(input);
export function validSetting(def, value) {
  return typeof value === typeof normalizeSettings({ value: def }, { value }).value && Object.is(value, normalizeSettings({ value: def }, { value }).value);
}

export function PluginSettings({ definitions = {}, values = {}, disabled = false, onSave }) {
  const initial = normalizeSettings(definitions, values);
  const signature = JSON.stringify(initial);
  const [draft, setDraft] = useState(initial);
  const [invalid, setInvalid] = useState({});
  useEffect(() => { setDraft(initial); setInvalid({}); }, [signature]);
  const keys = Object.keys(definitions);
  if (!keys.length) return null;
  const lang = getLang();
  const change = (key, raw) => {
    const def = definitions[key];
    const value = settingValue(def, raw);
    setDraft({ ...draft, [key]: value });
    setInvalid({ ...invalid, [key]: raw === '' || !validSetting(def, value) });
  };
  return html`<form class="plugin-settings" data-testid="plugin-settings" onSubmit=${e => { e.preventDefault(); if (!disabled && !Object.values(invalid).some(Boolean)) onSave(normalizeSettings(definitions, draft)); }}>
    <strong>${t('插件设置')}</strong>
    ${keys.map(key => {
      const def = definitions[key];
      const label = typeof def.label === 'string' ? def.label : def.label?.[lang] || def.label?.zh || def.label?.en || key;
      return html`<label key=${key} class="st-field-row plugin-settings__row"><span>${label}</span>
        ${def.type === 'boolean' ? html`<input type="checkbox" data-setting=${key} checked=${draft[key] === true} disabled=${disabled} onChange=${e => change(key, e.currentTarget.checked)} />`
          : def.type === 'enum' ? html`<select data-setting=${key} disabled=${disabled} value=${def.options.indexOf(draft[key])} onChange=${e => change(key, e.currentTarget.value)}>
            ${def.options.map((v, n) => html`<option value=${n}>${String(v)}</option>`)}
          </select>` : html`<input type="number" data-setting=${key} value=${draft[key]} min=${def.min} max=${def.max} step=${def.step ?? (def.type === 'integer' ? 1 : 'any')} disabled=${disabled}
            aria-invalid=${invalid[key] ? 'true' : 'false'} onInput=${e => change(key, e.currentTarget.value)} />`}
      </label>`;
    })}
    ${Object.values(invalid).some(Boolean) ? html`<p class="set-hint is-warn">${t('设置值须符合范围和步长。')}</p>` : null}
    ${!disabled ? html`<${Button} type="submit" size="sm" disabled=${Object.values(invalid).some(Boolean) || JSON.stringify(draft) === signature}>${t('应用设置')}<//>` : null}
  </form>`;
}
