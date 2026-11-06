// Manifest-driven controls shared by the room panel and the studio's trial selector.
import { useEffect, useLayoutEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button } from './components.js';
import { getLang, t } from '../../../shared/i18n.js';
import { normalizeSettings } from '../../../shared/plugins/patch.js';
import { inputNumber, syncNumberInput } from './numberInput.js';
import { DIFFICULTY_TERMS, DIFFICULTY_PRESETS, difficultyPreset } from '../../../shared/enemyDifficulty.js';

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

/** A setting's number box, not a controlled value (numberInput.js): a partial entry such as "0." is left alone. */
function SettingNumber({ setting, def, value, disabled, invalid, onValue }) {
  const ref = useRef(null), latest = useRef(value);
  latest.current = value;
  useLayoutEffect(() => syncNumberInput(ref.current, value), [value]);
  return html`<input ref=${ref} type="number" data-setting=${setting} min=${def.min} max=${def.max} step=${def.step ?? (def.type === 'integer' ? 1 : 'any')} disabled=${disabled}
    aria-invalid=${invalid ? 'true' : 'false'} onInput=${e => onValue(inputNumber(e.currentTarget))} onBlur=${e => syncNumberInput(e.currentTarget, latest.current, true)} />`;
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
  const challenge = !!definitions.n18Mode && Object.keys(DIFFICULTY_TERMS).every(k => definitions[`fixed_${k}`] && definitions[`limit_${k}`]);
  const fixed = Object.fromEntries(Object.keys(DIFFICULTY_TERMS).map(k => [k, draft[`fixed_${k}`]]));
  const preset = challenge ? difficultyPreset(fixed) : null;
  const visibleKeys = challenge ? keys.filter(k => k === 'n18Mode' || (draft.n18Mode === 'random' ? k === 'n18MaxTerms' || k.startsWith('limit_') : k.startsWith('fixed_'))) : keys;
  const change = (key, raw) => {
    const def = definitions[key];
    const value = settingValue(def, raw);
    setDraft({ ...draft, [key]: value });
    setInvalid(challenge && key === 'n18Mode' ? {} : { ...invalid, [key]: raw === '' || !validSetting(def, value) });
  };
  // a number box: undefined while the entry is partial, null when empty — both keep the last value and block Apply
  const changeNumber = (key, n) => {
    if (typeof n === 'number') return change(key, n);
    setInvalid({ ...invalid, [key]: true });
  };
  return html`<form class="plugin-settings" data-testid="plugin-settings" onSubmit=${e => { e.preventDefault(); if (!disabled && !Object.values(invalid).some(Boolean)) onSave(normalizeSettings(definitions, draft)); }}>
    <strong>${t('插件设置')}</strong>
    ${challenge ? html`<p class="set-hint">${t('强化倍率叠加于房间所选的基础难度。数量仅限整数，出怪间隔按数量倍率同步缩短。')}</p>` : null}
    ${challenge && draft.n18Mode === 'fixed' ? html`<label class="st-field-row"><span>${t('难度预设')}</span>
      <select data-setting="n18Preset" disabled=${disabled} value=${preset ? DIFFICULTY_PRESETS.indexOf(preset) : -1} onChange=${e => {
        const p = DIFFICULTY_PRESETS[Number(e.currentTarget.value)];
        if (!p) return;
        setDraft({ ...draft, ...Object.fromEntries(Object.keys(DIFFICULTY_TERMS).map(k => [`fixed_${k}`, p[k]])) });
        setInvalid(Object.fromEntries(Object.entries(invalid).filter(([k]) => !k.startsWith('fixed_'))));
      }}><option value="-1">${t('自定义')}</option>${DIFFICULTY_PRESETS.map((p, i) => html`<option value=${i}>${t(p.name)}</option>`)}</select>
    </label>` : null}
    ${challenge && draft.n18Mode === 'random' ? html`<p class="set-hint">${t('以下为词条上限；×1 不参与抽取。每回合抽取 1 至最多词条数，本回合生效，不累加。')}</p>` : null}
    ${visibleKeys.map(key => {
      const def = definitions[key];
      const term = challenge ? DIFFICULTY_TERMS[key.replace(/^(fixed|limit)_/, '')] : null;
      const label = term ? t(term.label) : key === 'n18MaxTerms' && challenge ? t('每回合最多词条数')
        : typeof def.label === 'string' ? def.label : def.label?.[lang] || def.label?.zh || def.label?.en || key;
      return html`<label key=${key} class="st-field-row plugin-settings__row"><span>${label}</span>
        ${def.type === 'boolean' ? html`<input type="checkbox" data-setting=${key} checked=${draft[key] === true} disabled=${disabled} onChange=${e => change(key, e.currentTarget.checked)} />`
          : def.type === 'enum' ? html`<select data-setting=${key} disabled=${disabled} value=${def.options.indexOf(draft[key])} onChange=${e => change(key, e.currentTarget.value)}>
            ${def.options.map((v, n) => html`<option value=${n}>${challenge && key === 'n18Mode' ? (v === 'fixed' ? t('固定模式') : t('随机模式')) : String(v)}</option>`)}
          </select>` : html`<${SettingNumber} setting=${key} def=${def} value=${draft[key]} disabled=${disabled} invalid=${invalid[key]} onValue=${n => changeNumber(key, n)} />`}
      </label>`;
    })}
    ${Object.values(invalid).some(Boolean) ? html`<p class="set-hint is-warn">${t('设置值须符合范围和步长。')}</p>` : null}
    ${!disabled ? html`<${Button} type="submit" size="sm" disabled=${Object.values(invalid).some(Boolean) || JSON.stringify(draft) === signature}>${t('应用设置')}<//>` : null}
  </form>`;
}
