// 自选候补 (Stardust fork rel26 2d3ec08e, feedback #114; the owner's decision of 2026-11-02: four equal candidates per
// tier, any two play): the briefing's (INFO_CHECK) choice of which two of each tier of the player's 自选 preset
// (ui/diyModel.js diyPositions) play this match — m.private.diyChoice (server/match/player/diy.js diyChoiceView): per
// tier its slot count, the candidates in the player's order (`banned`: their bonds that are off this match; `off`: all
// of them — such a piece never reaches the shop), the ones fielded now and whether the player chose. A candidate with a
// banned bond says which (BanLine), one with every bond banned more strongly than one with some. A tap toggles a
// candidate in the tier's draft; once the draft holds as many as the tier has slots it goes to the server (g.diyChoose)
// and the fielded ones follow — an unfinished draft changes nothing. Without a choice the server fields the default:
// the first two in the player's order whose bonds are not all banned (then the rest in order).
// The view is hookless (unit-tested by calling it); DiyChoice keeps the drafts.
// The briefing's dock (Stardust fork rel28 94d736da, feedback #127, planned by the owner on 2026-11-03:
// 「需要在每场开局前，准备阶段提醒自选进行4选2」 — 「开局选自选的界面需要滚动，太不显眼了」): `dock` draws the section as one
// strip pinned above 准备就绪 (screens/briefing.js), outside the scrolling column — the tiers side by side, compact
// candidates — highlighted while a tier is still on the default and the player is not ready (`ready`).

import { useState } from '../../vendor/hooks.module.js';
import { html, TierChip, Icon } from './components.js';
import { UnitThumb, BondGlyph } from './gameComponents.js';
import { slotRecord } from './diyModel.js';
import { diyTierSlotIds } from '../../../shared/diy.js';
import { skinIdFor } from '../../../shared/skins.js';
import { data } from '../data.js';
import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The tiers of m.private.diyChoice that are well formed. @param {any} priv */
export function diyChoiceTiers(priv) {
  const tiers = isObj(priv?.diyChoice) && Array.isArray(priv.diyChoice.tiers) ? priv.diyChoice.tiers : [];
  return tiers.filter((x) => isObj(x) && Number.isInteger(x.tier) && Number.isInteger(x.slots) && Array.isArray(x.candidates) && Array.isArray(x.chosen));
}

/**
 * The next draft of a tier after a tap on `charId`: a chosen one leaves it; another joins while the draft has room
 * (a full draft is left as it is — take one out first). `current` = the tier's draft, else what is fielded now.
 * @param {{ slots: number, chosen: string[] }} tier @param {string[]|null|undefined} current @param {string} charId
 * @returns {string[]}
 */
export function toggleDiyDraft(tier, current, charId) {
  const cur = Array.isArray(current) ? current : tier.chosen;
  if (cur.includes(charId)) return cur.filter((id) => id !== charId);
  return cur.length < tier.slots ? [...cur, charId] : cur;
}

/** Whether a draft is complete and differs from what is fielded (the moment to send it). */
export function diyDraftReady(tier, draft) {
  return Array.isArray(draft) && draft.length === Math.min(tier.slots, tier.candidates.length)
    && !(draft.length === tier.chosen.length && draft.every((id) => tier.chosen.includes(id)));
}

const bondName = (id) => data.lookup('bonds', id)?.name || id;

/**
 * The bonds of a 自选 operator that are off this match — `ban` = { bonds, all } (ui/diyModel.js diyBanHint, or a
 * candidate's `banned` / `off`): every one (it never reaches the shop) or some. `compact`: the names only (a briefing
 * card); else the 自选编队 card's sentence. Shared with screens/diy.js.
 */
export function BanLine({ ban, compact = false, class: cls = 'diy-ban' }) {
  if (!ban || !Array.isArray(ban.bonds) || !ban.bonds.length) return null;
  const bonds = ban.bonds.map(bondName);
  const text = ban.all && !compact ? t('盟约全部禁用，本局不会出现在商店') : t('本局禁用：{bonds}', { bonds });
  return html`<span class=${cx(cls, ban.all ? 'is-all' : 'is-some')} data-ban=${ban.all ? 'all' : 'some'}><${Icon} name="warn" />${text}</span>`;
}

/**
 * One candidate: avatar, name, bonds (an off one struck); 上场 when in the draft; 盟约全部禁用 (strong) or 部分盟约禁用 with
 * the banned bonds named.
 */
function Candidate({ tier, c, on, onTap, disabled, skins }) {
  const D = { chess: data.get('chess'), backups: data.get('backups') };
  const slot = diyTierSlotIds(tier, D)[0];
  const rec = slot ? slotRecord(slot, c, D) : null;
  const name = rec?.name || c.charId;
  const banned = Array.isArray(c.banned) ? c.banned.filter((b) => typeof b === 'string') : [];
  const ban = banned.length ? { bonds: banned, all: !!c.off } : null;
  const label = [name, on && t('上场'), ban && (ban.all ? t('盟约全部禁用') : t('本局禁用：{bonds}', { bonds: banned.map(bondName) }))].filter(Boolean).join(' · ');
  return html`<button type="button" class=${cx('diychoice__c', on && 'is-on', ban && (ban.all ? 'is-off' : 'is-part'))} data-char=${c.charId}
      aria-pressed=${on ? 'true' : 'false'} aria-label=${label} title=${label} disabled=${disabled} onClick=${() => onTap(c.charId)}>
    <${UnitThumb} kind="chess" rec=${rec} id=${slot} size="sm" showTier=${false} dim=${!!ban?.all} skin=${skinIdFor(skins, c.charId)} />
    <span class="diychoice__name">${name}</span>
    <span class="diychoice__bonds">${(rec?.bonds || []).map((b) => html`<span key=${b} class=${cx('diychoice__bond', banned.includes(b) && 'is-off')}><${BondGlyph} bondId=${b} /></span>`)}</span>
    <${BanLine} ban=${ban} compact=${true} class="diychoice__ban" />
    ${on ? html`<b class="diychoice__tag">${t('上场')}</b>` : null}
    ${ban ? html`<b class=${cx('diychoice__flag', ban.all ? 'is-all' : 'is-some')}>${ban.all ? t('盟约全部禁用') : t('部分盟约禁用')}</b>` : null}
  </button>`;
}

/**
 * The section's view: one row per tier with a choice. `drafts` tier → charIds being chosen; `onTap(tier, charId)`.
 * `dock` (feedback #127, see the header): the briefing's pinned strip; `ready`: the player is ready (the strip stops
 * calling for a choice).
 * @param {{ priv: any, drafts?: Record<string, string[]>, onTap: (tier: number, charId: string) => void, disabled?: boolean,
 *   dock?: boolean, ready?: boolean }} props
 */
export function DiyChoiceView({ priv, drafts = {}, onTap, disabled = false, dock = false, ready = false }) {
  const tiers = diyChoiceTiers(priv);
  if (!tiers.length) return null;
  const skins = isObj(priv?.skins) ? priv.skins : {};
  const rows = tiers.map((x) => {
    const draft = Array.isArray(drafts[x.tier]) ? drafts[x.tier] : null;
    const sel = draft || x.chosen;
    const need = Math.min(x.slots, x.candidates.length);
    return html`<div key=${x.tier} class=${cx('diychoice__tier', !x.picked && !draft && 'is-default')} data-tier=${x.tier}>
      <span class="diychoice__head"><${TierChip} tier=${x.tier} size="sm" /><b>${t('{tier}阶', { tier: x.tier })}</b>
        <span class="num diychoice__n">${sel.length}/${need}</span>
        ${draft && draft.length < need ? html`<small class="diychoice__hint"><${Icon} name="info" />${t('再选 {n} 名后生效', { n: need - draft.length })}</small>`
          : !x.picked ? html`<small class="diychoice__hint t-dim">${t('未选择：默认上场')}</small>` : null}
      </span>
      <div class="diychoice__row">
        ${x.candidates.map((c) => html`<${Candidate} key=${c.charId} tier=${x.tier} c=${c} on=${sel.includes(c.charId)} skins=${skins}
          disabled=${disabled} onTap=${(id) => onTap(x.tier, id)} />`)}
      </div>
    </div>`;
  });
  if (dock) {
    // still on the default somewhere (no choice sent for a tier, no draft under way): the strip asks for one
    const todo = tiers.some((x) => !x.picked && !Array.isArray(drafts[x.tier]));
    // 「4 选 2」 when every tier offers as many; else 每阶选 2 名 (a preset may hold three in a tier)
    const k = Math.min(...tiers.map((x) => x.slots));
    const ns = [...new Set(tiers.map((x) => x.candidates.length))];
    return html`<section class=${cx('diychoice', 'diychoice--dock', todo && !ready && 'is-todo')} data-testid="diy-choice" aria-label=${t('自选上场')}>
      <div class="diychoice__bar">
        <b class="diychoice__title"><${Icon} name="user" />${t('自选上场')}<span class="diychoice__pick num">${ns.length === 1 ? t('{n} 选 {k}', { n: ns[0], k }) : t('每阶选 {k} 名', { k })}</span></b>
        <span class="diychoice__lead">${todo
          ? t('点选每阶本局上场的自选干员（卡片标出了本局被禁用的盟约）；不选则由排在前面、盟约没有全部被禁用的干员上场。')
          : t('已选好本局上场的自选干员；本阶段结束前仍可更改。')}</span>
      </div>
      <div class="diychoice__tiers">${rows}</div>
    </section>`;
  }
  return html`<div class="diychoice" data-testid="diy-choice">
    <h3 class="brief-h"><span>${t('自选上场')}</span><span class="micro">SUPPORT OPERATORS</span></h3>
    <p class="diychoice__lead">${t('从你的自选预设中为每阶选出上场的干员（看过禁用盟约后再定）；就绪后、本阶段结束前仍可更改。')}</p>
    ${rows}
  </div>`;
}

/**
 * The briefing's 自选上场 section (nothing without m.private.diyChoice). `onChoose(tier, charIds)` sends g.diyChoose and
 * resolves true on success; `dock` / `ready` as DiyChoiceView.
 * @param {{ priv: any, onChoose: (tier: number, charIds: string[]) => Promise<boolean>, disabled?: boolean, dock?: boolean,
 *   ready?: boolean }} props
 */
export function DiyChoice({ priv, onChoose, disabled = false, dock = false, ready = false }) {
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(false);
  const tap = async (tier, charId) => {
    if (busy) return;
    const x = diyChoiceTiers(priv).find((y) => y.tier === tier);
    if (!x) return;
    const next = toggleDiyDraft(x, drafts[tier], charId);
    if (!diyDraftReady(x, next)) {
      // complete and unchanged (a re-pick of the fielded ones) drops the draft; otherwise it waits for more taps
      const done = next.length === Math.min(x.slots, x.candidates.length);
      setDrafts({ ...drafts, [tier]: done ? undefined : next });
      return;
    }
    setDrafts({ ...drafts, [tier]: next });
    setBusy(true);
    await onChoose(tier, next);
    setBusy(false);
    setDrafts((d) => ({ ...d, [tier]: undefined }));
  };
  return DiyChoiceView({ priv, drafts, onTap: tap, disabled: disabled || busy, dock, ready });
}
