// 实验性选项的行构造器 (ported from the Stardust fork's ui/experimental.js, rel24 d330dbb7): the settings dialog's
// (ui/roomSettings.js) rows, each one 「标题 + 说明文字 + 开关」. The fork's builders send the whole normalized option
// set at once; this repo sends room.setExperimental per key through screens/room.js's builders (capacityExperimental /
// duckLordExperimental / … — test/ui/player-capacity.test.js pins those call shapes), so a row hands its change to the
// per-key callback the screen passes instead. Only the keys this repo's server knows (shared/experimental.js) are here:
// revivalEnabled, disableSharedPool, playerCapacity, disableDuckLord, disableLayerCap, disableHitLimit,
// uniteHumansFirst — the fork's enemy multipliers / plan, collabRow and poolPlan/PoolEditor stay unported (the server
// has none of them), and 联动干员 does not exist here.

import { html } from './components.js';
import { t } from '../../../shared/i18n.js';
import { MAX_SEATS } from '../../../shared/constants.js';
import { PLAYER_CAPACITIES, isPlayerCapacity, roomCapacity } from '../../../shared/playerCapacity.js';
import { EXPERIMENTAL_DEFAULTS, experimentalOptions } from '../../../shared/experimental.js';

/**
 * A room's experimental payload as the panel reads it: the shared normalization (shared/experimental.js
 * experimentalOptions), forgiving to an absent or legacy payload — the shared one throws, a room state from an older
 * server may carry no experimental at all. Unfrozen, so a row can spread it into a next-set proposal.
 * @param {any} value room.state experimental
 * @returns {{ revivalEnabled: boolean, disableSharedPool: boolean, playerCapacity?: number, disableDuckLord?: boolean,
 *   disableLayerCap?: boolean, disableHitLimit?: boolean, uniteHumansFirst?: boolean }}
 */
export function roomExperimental(value) {
  try { return { ...experimentalOptions(value) }; } catch { return { ...EXPERIMENTAL_DEFAULTS }; }
}

/** One switch of the settings dialog: the title and its note on the left, the switch on the right. */
export function switchRow({ id, title, note, checked, disabled, onChange, testid }) {
  return html`<label class="experimental-option" for=${id}>
    <span><strong>${title}</strong>${note ? html`<small>${note}</small>` : null}</span>
    <input id=${id} type="checkbox" role="switch" data-testid=${testid} checked=${checked} disabled=${disabled} onChange=${e => onChange(e.currentTarget.checked, e)} />
  </label>`;
}

/**
 * 扩展同盟人数 and its seat count (the fork's capacityRows, without the pool-plan re-layout this repo has not ported).
 * Hidden in a solo room and in a room the queue allocated, like screens/room.js capacityOption; `onCapacity` takes the
 * seat count (the screen builds the option set with capacityExperimental).
 */
export function capacityRows({ value, mode = 'coop', source = 'private', editable = false, busy = false, onCapacity }) {
  if (mode !== 'coop' || source === 'matchmaking' || !onCapacity) return null;
  const capacity = roomCapacity('coop', roomExperimental(value));
  const locked = !editable || !!busy;
  const setCapacity = (next) => { if (!locked && isPlayerCapacity(next)) onCapacity(next); };
  return [
    switchRow({ id: 'experimental-multiplayer', title: t('扩展同盟人数'),
      note: t('实验性选项：同盟扩到 8–20 人。可直接开局，人数较多时等待与演算时间可能增加；所有成员需更新页面。'),
      checked: capacity > MAX_SEATS, disabled: locked, onChange: () => setCapacity(capacity > MAX_SEATS ? MAX_SEATS : 8) }),
    capacity > MAX_SEATS ? html`<label class="experimental-capacity" for="experimental-capacity">
      <span>${t('同盟人数模式')}</span>
      <select id="experimental-capacity" data-testid="room-capacity-pick" value=${capacity} disabled=${locked}
        onChange=${e => setCapacity(Number(e.currentTarget.value))}>
        ${PLAYER_CAPACITIES.map((n) => html`<option key=${n} value=${n}>${t('{n} 人', { n })}</option>`)}
      </select>
    </label>` : null,
  ];
}

/** 禁用鸭爵策略: expanded co-op rooms only (the fork's duckLordRow). `onDuckLord` takes the next state. */
export function duckLordRow({ value, mode = 'coop', editable = false, busy = false, onDuckLord }) {
  const options = roomExperimental(value);
  if (mode !== 'coop' || !onDuckLord || roomCapacity('coop', options) <= MAX_SEATS) return null;
  return switchRow({ id: 'experimental-ducklord', title: t('禁用鸭爵策略'), note: t('勾选后，本局无法选择鸭爵策略；不影响其他策略。'),
    checked: options.disableDuckLord === true, disabled: !editable || !!busy,
    onChange: (on) => { if (editable && !busy) onDuckLord(on); } });
}

/**
 * The battle rules: 规则 in a co-op room, the single page of a solo room (no teammate to rescue, no 联防 there — the
 * fork's ruleRows without the enemy multipliers and their plan). The rule rows hide in a room the queue allocated
 * (screens/room.js layerCapOption's rule); the console keeps its own option object (its editable state is a solo seat's
 * personal grant) and its matchmaking guard. One callback per key, each taking the next state.
 */
export function ruleRows({ value, mode = 'coop', source = 'private', editable = false, busy = false,
  consoleOpt = null, matching = false, onRevival, onLayerCap, onHitLimit, onUniteHumans, onConsole }) {
  const options = roomExperimental(value);
  const locked = !editable || !!busy;
  const row = (id, title, note, checked, onToggle, testid) => (onToggle
    ? switchRow({ id, title, note, checked, disabled: locked, testid, onChange: (on) => { if (!locked) onToggle(on); } })
    : null);
  const rulesHidden = source === 'matchmaking';
  return [
    mode === 'solo' || rulesHidden || !onRevival ? null
      : row('experimental-revival', t('队友复活'), t('队友生命耗尽时，任意存活队友可支付 10 生命抵消这次死亡（自己至少要有 11 生命），每人每局最多被救一次。'),
          options.revivalEnabled === true, onRevival),
    rulesHidden || !onLayerCap ? null
      : row('experimental-layer-cap', t('禁用层数上限'), t('盟约层数不再停在 999 层。'), options.disableLayerCap === true, onLayerCap),
    rulesHidden || !onHitLimit ? null
      : row('experimental-hit-limit', t('禁用单次伤害上限'), t('对敌方领袖的单次伤害达到 30 万及以上时不再被取消。'), options.disableHitLimit === true, onHitLimit),
    mode === 'solo' || rulesHidden || !onUniteHumans ? null
      : row('experimental-unite-humans', t('AI 联防置后'), t('联防先按原有排序从真人博士中挑选，AI 队友和 AI 托管中的博士排在所有真人之后。'),
          options.uniteHumansFirst === true, onUniteHumans),
    consoleOpt && onConsole ? switchRow({ id: 'experimental-console', title: t('开发者控制台'),
      note: consoleOpt.on ? t('不能进入匹配队列')
        : t('对局内可发放干员、装备与盟约层数（每回合 {round} 次，全场 {total} 次），全队可见', { round: 5, total: 50 }),
      checked: consoleOpt.on === true, disabled: !consoleOpt.editable || !!busy || (matching && !consoleOpt.on),
      onChange: (on) => { if (consoleOpt.editable) onConsole(on); } }) : null,
  ];
}

/** 禁用共享卡池 (the fork's poolRows, without 手动指定卡池编组/PoolEditor — the manual groups are not ported). `onSharedPool` takes the next state. */
export function poolRows({ value, editable = false, busy = false, onSharedPool }) {
  if (!onSharedPool) return null;
  const options = roomExperimental(value);
  const locked = !editable || !!busy;
  return [
    switchRow({ id: 'experimental-pool', title: t('禁用共享卡池'), note: t('每位博士使用独立卡池，不再争用同一干员库存。'),
      checked: options.disableSharedPool === true, disabled: locked,
      onChange: (on) => { if (!locked) onSharedPool(on); } }),
  ];
}
