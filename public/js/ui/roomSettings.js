// 同盟设置 (a solo room: 模拟设置) — ported from the Stardust fork's ui/roomSettings.js (rel24 d330dbb7 and its
// follow-ups): every option of the room in one dialog, opened from ⚙ on the pill (screens/room.js). Three pages —
// 同盟 (who plays: difficulty, version, seats, AI seats), 规则 (the battle), 卡池 (the card pools and their manual
// groups, ui/poolEditor.js) — a solo room has its one page 模拟设置, without tabs. A tab with a dot differs from a new
// room (changedPages). The host edits; everybody else reads the same pages. What changes goes to the server at once:
// nothing here waits for 完成, which only closes the dialog. Against the fork, the enemy multipliers and 公开到同盟列表
// are not ported (this repo's server has none of them), and the difficulty row joins the version row (this repo's
// 选择模拟协议 flow, screens/lobby.js ProtocolSelect); the pool plan goes through the per-key onPoolPlan sender
// (screens/room.js poolPlanExperimental) instead of the fork's whole-set onExperimental.

import { html, Button, Icon, Modal, Tooltip, DifficultyIcon } from './components.js';
import { capacityRows, duckLordRow, poolRows, roomExperimental, ruleRows, switchRow } from './experimental.js';
import { PoolEditor } from './poolEditor.js';
import { MAX_SEATS } from '../../../shared/constants.js';
import { roomCapacity } from '../../../shared/playerCapacity.js';
import { t, N_ } from '../../../shared/i18n.js';

/** The pages of a room's dialog, in order. */
export const settingsPages = (room) => (room?.mode === 'solo' ? ['sim'] : ['alliance', 'rules', 'pools']);

/** The page a press opens: `page` when this room has it, else its first. */
export function settingsPage(room, page) {
  const pages = settingsPages(room);
  return pages.includes(page) ? page : pages[0];
}

/**
 * Which pages differ from a new room's defaults (a dot on their tab). This repo's defaults: 4 seats, no 鸭爵 ban, the
 * humans draft first (aiPicksLast off), one strategy per doctor, no spectator handover, no rule keys, the shared pool.
 * The developer console is a room field of its own (room.consoleEnabled), not an experimental key.
 * @param {any} room room.state payload
 */
export function changedPages(room) {
  const options = roomExperimental(room?.experimental);
  return {
    alliance: roomCapacity('coop', options) > MAX_SEATS || options.disableDuckLord === true || room?.aiPicksLast === true
      || room?.bandDupes === true || room?.aiTakeoverEnabled === true,
    rules: options.revivalEnabled === true || options.disableLayerCap === true || options.disableHitLimit === true
      || options.uniteHumansFirst === true || room?.consoleEnabled === true,
    pools: options.disableSharedPool === true || !!options.poolPlan,
  };
}

/** The taken seats of a room, for the automatic rule the pool layouts start from (the fork's takenSeats). */
const takenSeats = (room) => (room?.seats || []).flatMap((seat, index) => (seat ? [index] : []));

const TABS = { alliance: N_('同盟'), rules: N_('规则'), pools: N_('卡池') };

/** The 模拟难度 row (this repo's 选择模拟协议 flow): the host's press opens the picker, the others' the read-only view. */
function DifficultyRow({ difficulty }) {
  return html`<div class="experimental-option rset__version" data-testid="room-opt-difficulty">
    <span><strong>${t('模拟难度')}</strong><small>${difficulty.editable ? t('更改模拟难度') : t('由创建者选择')}</small></span>
    <button type="button" class="rset__ver rset__diff" disabled=${difficulty.disabled} onClick=${difficulty.onOpen}
        title=${difficulty.editable ? t('更改模拟难度') : t('由创建者选择')}>
      <${DifficultyIcon} difficulty=${difficulty.id} />${difficulty.name}<span class="num rs-pill__code">${difficulty.code}</span>
    </button>
  </div>`;
}

/** The 版本 row (this repo's version vote, ui/versionVote.js): the host proposes, the others read. */
function VersionRow({ version }) {
  return html`<div class="experimental-option rset__version" data-testid="room-opt-version">
    <span><strong>${t('版本')}</strong><small>${version.editable ? t('发起切换版本') : t('由创建者发起')}</small></span>
    <${Tooltip} text=${version.why}>
      <button type="button" class="rset__ver" disabled=${version.disabled} onClick=${version.onOpen}><${Icon} name="book" />${version.label}</button>
    <//>
  </div>`;
}

/**
 * The room's settings dialog (the fork's RoomSettings, wired to this repo's per-key senders): the screen passes one
 * callback per option, each taking the next state, and the pre-built option objects whose editable rule lives in
 * screens/room.js (aiLastOption / bandDupesOption / aiTakeoverOption / consoleOption / soloUnlimitedOption).
 * @param {{ page: string|null, onPage: (page: string) => void, room: any, myId?: any, editable: boolean, busy: any,
 *   version?: any, difficulty?: any, aiLast?: any, takeover?: any, dupes?: any, soloOption?: any, consoleOpt?: any,
 *   matching?: boolean, onRevival?: Function, onSharedPool?: Function, onPoolPlan?: Function, onLayerCap?: Function,
 *   onHitLimit?: Function, onUniteHumans?: Function, onConsole?: Function, onAiLast?: Function, onAiTakeover?: Function,
 *   onBandDupes?: Function, onCapacity?: Function, onDuckLord?: Function, onSoloUnlimited?: Function, onClose: Function }} props
 */
export function RoomSettings({ page, onPage, room, myId = null, editable, busy, version = null, difficulty = null, aiLast = null, takeover = null,
  dupes = null, soloOption = null, consoleOpt = null, matching = false, onRevival, onSharedPool, onPoolPlan, onLayerCap, onHitLimit,
  onUniteHumans, onConsole, onAiLast, onAiTakeover, onBandDupes, onCapacity, onDuckLord, onSoloUnlimited, onClose }) {
  if (!page) return null;
  const solo = room.mode === 'solo';
  const title = solo ? t('模拟设置') : t('同盟设置');
  const pages = settingsPages(room);
  const changed = changedPages(room);
  const lock = !!busy;
  const rows = { value: room.experimental, mode: room.mode, source: room.source, seats: takenSeats(room), editable, busy: lock,
    consoleOpt, matching, onRevival, onLayerCap, onHitLimit, onUniteHumans, onConsole };
  const options = roomExperimental(room?.experimental);
  // a screen option ({ on, editable }) as a row: the label lives here, the state and who may change it with the screen
  const toggle = (option, id, label, note, onToggle, testid) => (option ? switchRow({ id, title: label, note, testid,
    checked: option.on === true, disabled: !option.editable || lock,
    onChange: (on) => { if (option.editable) onToggle(on); } }) : null);
  return html`<${Modal} open=${true} title=${title} micro=${solo ? 'SIMULATION SETTINGS' : 'ALLIANCE SETTINGS'} class=${`room-settings-modal${solo ? ' is-solo' : ''}`} onClose=${onClose}
      actions=${html`<p class="rset__note">${editable ? t('开局后不可更改') : t('由创建者设置')}</p><${Button} icon="check" onClick=${onClose}>${t('完成')}<//>`}>
    ${solo ? null : html`<div class="rset__tabs" role="tablist" aria-label=${title}>
      ${pages.map((id) => html`<button key=${id} type="button" role="tab" data-autofocus=${page === id ? true : undefined} id=${`rset-tab-${id}`}
          aria-selected=${page === id ? 'true' : 'false'} aria-controls="rset-page" class=${`rset__tab${page === id ? ' is-on' : ''}`}
          data-testid=${`room-settings-${id}`} onClick=${() => onPage(id)}>
        ${t(TABS[id])}${changed[id] ? html`<i class="rset__dot" title=${t('已更改')}></i>` : null}</button>`)}
    </div>`}
    <div class=${`rset__page rset__page--${page}`} id="rset-page" role=${solo ? undefined : 'tabpanel'} aria-labelledby=${solo ? undefined : `rset-tab-${page}`}>
      ${page === 'sim' ? html`<div class="rset__rows">
        ${soloOption ? null : difficulty ? DifficultyRow({ difficulty }) : null}
        ${soloOption ? null : version ? VersionRow({ version }) : null}
        ${toggle(soloOption, 'room-solo-unlimited', t('不限时'), t('关闭本局休整与机变的计时。官方为休整期每轮 300 秒、机变 150 秒。'), onSoloUnlimited, 'room-solo-unlimited')}
        ${ruleRows(rows)}
      </div>` : null}
      ${page === 'alliance' ? html`<div class="rset__rows">
        ${difficulty ? DifficultyRow({ difficulty }) : null}
        ${version ? VersionRow({ version }) : null}
        ${capacityRows({ ...rows, onCapacity })}
        ${toggle(aiLast, 'room-ai-last', t('AI 队友最后选择'), t('策略与机变轮选时，所有博士先于 AI 队友选择'), onAiLast, 'room-ai-last')}
        ${toggle(dupes, 'room-band-dupes', t('允许重复策略'), t('默认关闭。开启后，策略选人允许多名博士选择同一策略（含自动分配），不再标「队友已选」'), onBandDupes, 'room-band-dupes')}
        ${toggle(takeover, 'room-ai-takeover', t('允许观战者接替 AI'), t('默认关闭。开启后，观战者可在休整期经同房间真人投票接替 AI；继承记录不计个人统计或奖励。'), onAiTakeover, 'room-ai-takeover')}
        ${duckLordRow({ ...rows, onDuckLord })}
      </div>` : null}
      ${page === 'rules' ? html`<div class="rset__rows">${ruleRows(rows)}</div>` : null}
      ${page === 'pools' ? html`<div class="rset__rows">${poolRows({ ...rows, onSharedPool, onPoolPlan })}</div>
        ${options.poolPlan ? html`<${PoolEditor} plan=${options.poolPlan} seats=${room.seats} hostId=${room.hostId} myId=${myId} editable=${editable} busy=${lock}
          onPlan=${(poolPlan) => onPoolPlan(poolPlan)} />` : options.disableSharedPool === true ? null : html`<p class="rset__empty">${t('未开启时按开局人数自动分组。')}</p>`}` : null}
    </div>
  <//>`;
}
