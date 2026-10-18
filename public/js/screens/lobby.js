import { LobbyMusicButton } from '../ui/lobbyMusic.js';
import { AccountMeChip } from '../ui/accounts.js';
import { decorateOwnerName } from '../ui/ownerName.js';
import { MatchmakingCount } from '../ui/matchmaking.js';
import { Emblem } from './title.js';
import { useHubBackdrop, HubBackdrop, HubRadar, BackdropSettings, BackdropGlyph, backdropTheme } from '../ui/hubBackdrop.js';
// Lobby screen — a hub (owner's request, 2026-10-13): an original backdrop (ui/hubBackdrop.js: generated night scenes or
// the player's own picture) with the game's dot-matrix emblem in the middle, a left column (密钥加入 · tips), a right
// column (S.W.E.E.P.报告 (screens/sweep.js) · 干员调配) and the entries at the bottom right:
// 独立模拟 / 同盟模拟 open the start sheet (difficulty 标准/险境/绝境/终极) and 选择同盟方式, 同盟匹配 opens THIS fork's
// own queue (queue.join; see below). The 密钥加入 dialog joins with a 同盟密钥 (recent codes remembered) — as a
// player (加入同盟) or in one of its MAX_SPECTATORS spectator seats (观战: room.spectate, also while its match runs;
// community report #26). The server is picked on the title screen.
//
// The hub's PUBLIC ROOM DIRECTORY is deliberately ABSENT (owner's request, 2026-10-15): the 缺人同盟 card, the 三服统一大厅
// list, the 浏览公开同盟 / 模拟邀约 / 搜寻队友 pills and the 私密房间 switch all needed messages this server does not have
// (room.list / room.setPrivate / match.queue / room.setRandom, see AGENTS.md), so every one of them was dead — the card
// read a store key nothing writes and rendered an empty box forever. This fork's own door is the room key (密钥加入) plus
// the optional 门户登记 (server/http/portalRoom.js), which publishes a room to the 联机站 for ten minutes.
//
// Difficulty descriptions come from data/config.json `modes[modeId]` when present, else from the
// official act2autochess `modeDataDict` texts embedded below (desc + effectDescList), so the
// screen is complete before data is generated. Rounds: solo 标准 = 9, everything else 14 (+R15
// hidden core on 险境+), per research 00-INDEX §2. Battlefield pool (`modes[].stages`): 标准 always
// plays 战场#01, 险境 draws one of 8, 绝境 / 终极 one of 7 (m01 excluded).
// Texts go through t() (docs/I18N.md); the module-level tables hold msgids (N_) translated where they are shown, the
// config.json mode texts come localized from data.js.

import { ResumeMatchButton } from '../ui/resumeMatch.js';
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_COLORS, ROOM_CODE_LEN, MAX_SEATS, MAX_SPECTATORS, modeIdFor, ERR, ERR_TEXT, REPOSITORY_URL, APP_VERSION } from '../../../shared/constants.js';
import { RANDOM_MODE } from '../../../shared/randomMode.js';
import { html, Button, Icon, MicroLabel, Panel, TextField, PingPill, AvatarFrame, Tooltip, Spinner, DifficultyIcon, doctorNo } from '../ui/components.js';
import { toast, toastError } from '../ui/toasts.js';
import { copyText } from '../ui/clipboard.js';
import { GuideButton, openGuide } from '../ui/guide.js';
import { openStats } from './stats.js';
import { AchievementEntry, AchievementPanel } from '../ui/achievements.js';
import { FriendsTile } from '../ui/friends.js';
import { AnnouncementButton, AnnouncementCard } from '../ui/announcement.js';
import { SettingsButton } from '../ui/settings.js';
import { PwaInstallButton, fullscreen } from '../ui/device.js';
import { LoadoutButton } from './loadout.js';
import { SweepReport } from './sweep.js';
import { ProtocolScene } from '../ui/protocolScene.js';
import { SearchPanel, RecruitHint, RadarScene, CreateArt, JoinArt } from '../ui/matchFlow.js';
import { useLeave } from '../ui/transitions.js';
import { net, identity } from '../net.js';
import { store, useStore, shallowEqual, serverNow, loadPref, savePref } from '../store.js';
import { getConfig, getMode, getStage, useData } from '../data.js';
import { t, tc, N_ } from '../../../shared/i18n.js';
import { C2S as SERVER_C2S } from '../../../shared/protocol.js';

const COMMUNITY_GROUP = '709955459';
const DESIGN_CREDIT = 'Bilibili@雨千代chiyo'; // i18n-ignore: the designer's handle — a name, not UI text

/** Official mode texts (activity_table act2autochess.modeDataDict), fallback when config.json is absent. */
export const MODE_TEXT = {
  single: {
    FUNNY: { code: 'AC-1', desc: N_('时长较短的模拟训练'), effects: [N_('可以快速完成作战'), N_('常规奖励')] },
    NORMAL: { code: 'AC-2', desc: N_('敌方攻击强度较高的模拟训练'), effects: [N_('可使用盟约数增加'), N_('大幅增加奖励')] },
    HARD: { code: 'AC-3', desc: N_('敌方攻击强度极高的模拟训练'), effects: [N_('作战环境困难'), N_('出现更加危险的敌人')] },
    ABYSS: { code: 'AC-4', desc: N_('敌方攻击强度到达极限的模拟训练'), effects: [N_('作战环境无比困难'), N_('出现极度危险的敌人')] },
  },
  multi: {
    FUNNY: { code: 'AC-1', desc: N_('敌方攻击强度较低的模拟训练'), effects: [N_('作战环境较为温和'), N_('常规奖励')] },
    NORMAL: { code: 'AC-2', desc: N_('敌方攻击强度较高的模拟训练'), effects: [N_('可使用盟约数增加'), N_('大幅增加奖励')] },
    HARD: { code: 'AC-3', desc: N_('敌方攻击强度极高的模拟训练'), effects: [N_('作战环境困难'), N_('出现更加危险的敌人')] },
    ABYSS: { code: 'AC-4', desc: N_('敌方攻击强度到达极限的模拟训练'), effects: [N_('作战环境无比困难'), N_('出现极度危险的敌人')] },
  },
};

/** Battlefield pool per difficulty when config.json is absent (the modes' `stages` lists; same for solo and co-op). */
export const STAGE_POOL = { FUNNY: ['act1autochess_m01'], NORMAL: 8, HARD: 7, ABYSS: 7 };

/**
 * Display name of a stage: stages.json when it is loaded, else derived from the id (act1 m0N → 战场#0N, act2 m0N → 战场#0(N+4)).
 * From the data name only its 战场#NN part (with a (上半) / (下半) mark) — 'Battlefield #NN (First Half)' in English.
 * @param {string} id e.g. 'act1autochess_m01'
 */
export function stageLabel(id) {
  const rec = getStage(id);
  if (rec && typeof rec.name === 'string' && rec.name) {
    const m = rec.name.match(/^(.*?#\d+(?:\s*[(（][^)）]*[)）])?)/);
    return m ? m[1] : rec.name.split(/\s+/)[0];
  }
  const m = String(id || '').match(/^act(\d)autochess_m(\d+)$/);
  return m ? t('战场#{no}', { no: String(Number(m[2]) + (m[1] === '2' ? 4 : 0)).padStart(2, '0') }) : '';
}

/**
 * The battlefield note of a difficulty (official wording): a single-stage pool is fixed ("战场固定为 战场#01"), a larger
 * one is drawn at random ("战场随机（共8张）").
 * @param {string[] | number | null | undefined} stages the mode's `stages` list (or a count)
 * @returns {string} '' when unknown
 */
export function stageNote(stages) {
  if (Array.isArray(stages)) {
    const ids = stages.filter((s) => typeof s === 'string' && s);
    if (ids.length === 1) { const name = stageLabel(ids[0]); return name ? t('战场固定为 {name}', { name }) : t('战场固定'); }
    return ids.length > 1 ? t('战场随机（共{n}张）', { n: ids.length }) : '';
  }
  return Number.isInteger(stages) && stages > 1 ? t('战场随机（共{stages}张）', { stages }) : '';
}

const MODE_CARDS = [
  {
    id: 'solo', name: N_('独立模拟'), en: 'SOLO SIMULATION', icon: 'user',
    desc: N_('独自调配资金与干员，以自己的节奏完成整场模拟。'),
    points: [N_('1 名博士'), N_('休整期与机变阶段不限时')],
  },
  {
    id: 'coop', name: N_('同盟模拟'), en: 'ALLIANCE SIMULATION', icon: 'users',
    desc: N_('与至多 {n} 名博士组成同盟，共享干员池，联防协作抵御敌潮。'), params: { n: MAX_SEATS - 1 },
    points: [N_('1–{n} 名博士 · 邀请真人队友'), N_('联防阶段 · 最终攻势合并生命值')], pointParams: { n: MAX_SEATS },
  },
  {
    id: 'firepower', name: N_('无限火力'), badge: '1.1', en: 'UNLIMITED FIREPOWER', icon: 'dice',
    desc: N_('强势干员、技能连发，迎战怪潮与悬赏首领，轻松体验阵营成型的快感。'),
    points: [N_('1–{seats} 名博士 · 邀请真人队友'), N_('{rounds} 回合娱乐乱斗 · 推荐标准难度')],
    pointParams: { seats: MAX_SEATS, rounds: RANDOM_MODE.totalRounds },
  },
];

/** 无限火力分支（随机模式 variant）：快速突袭 9 回合 / 持久鏖战 13 回合。 */
const VARIANT_CARDS = [
  {
    id: 'blitz', name: N_('快速突袭'), en: 'BLITZ', desc: N_('固定 {rounds} 回合短局，紧凑刺激的数值节奏。'), descParams: { rounds: RANDOM_MODE.totalRounds },
  },
  {
    id: 'endurance', name: N_('持久鏖战'), en: 'ENDURANCE', desc: N_('固定 {rounds} 回合长局，曲线平滑拉长，供深度养成构筑。'), descParams: { rounds: RANDOM_MODE.endurance.totalRounds },
  },
  { id: 'marathon', name: N_('最长时赛'), en: 'MARATHON', desc: N_('固定 {rounds} 回合超长局，逐回合悬赏，极限养成拉锯。'), descParams: { rounds: RANDOM_MODE.marathon.totalRounds } },
];

/** 随机模式分支偏好（localStorage）。 */
export function firepowerVariantPreference() {
  const v = loadPref('lobby.firepowerVariant', 'blitz');
  return v === 'endurance' || v === 'marathon' ? v : 'blitz';
}

/** A presentation choice; the protocol still uses solo/coop plus Room.random. */
export function lobbySimulationPreference() {
  const selected = loadPref('lobby.simulation', null);
  if (MODE_CARDS.some((c) => c.id === selected)) return selected;
  // Preserve the old random toggle, including random solo preferences, as the new dedicated mode.
  if (loadPref('lobby.random', false) === true) return 'firepower';
  return loadPref('lobby.mode', 'coop') === 'solo' ? 'solo' : 'coop';
}

function preferredDifficulty(simulation) {
  const key = simulation === 'firepower' ? 'lobby.firepowerDifficulty' : 'lobby.difficulty';
  const d = loadPref(key, 'FUNNY');
  return DIFFICULTIES.includes(d) ? d : 'FUNNY';
}

/** Keep the explanation tied to the shared balance configuration. */
export function firepowerFeatures(variant = 'blitz') {
  const { multipliers, firepower, shop, lowTier, band, rounds, endurance, marathon, evolution, opening } = RANDOM_MODE;
  const v = variant === 'endurance' ? endurance : variant === 'marathon' ? marathon : { totalRounds: RANDOM_MODE.totalRounds, leaders: rounds.leaders };
  const leaderRounds = Object.keys(v.leaders).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const bossSpan = leaderRounds.length ? t('第 {0}–{1} 回合', { 0: leaderRounds[0], 1: leaderRounds.at(-1) }) : t('中后段回合');
  return [
    { title: t('强势阵营'), text: t('开局逐轮发放无限火力模组：装备后生命与攻击 ×{hpMul}，防御提升 {1}%，每场可复活一次；盟约层数无上限成长。', { hpMul: opening.modBuff.hpMul, 1: Math.round((opening.modBuff.defMul - 1) * 100) }) },
    { title: t('技能回转'), text: t('全员技力恢复加速 {0}%，保留原生技能轴；再部署缩短 {1}%。', { 0: Math.round((firepower.spRecoveryMul - 1) * 100), 1: Math.round((1 - firepower.redeployMul) * 100) }) },
    { title: t('开局成型'), text: t('{startLevel} 级商店、{startFunds} 资金开局；干员盲盒 {revealChoices} 选 1，部署上限 9 人，每人 {picksPerPlayer} 个策略。', { startLevel: shop.startLevel, startFunds: shop.startFunds, revealChoices: shop.revealChoices, picksPerPlayer: band.picksPerPlayer }) },
    { title: t('阶段质变'), text: t('第 {0} 回合休整期三选一：层数共鸣 / 生机坚壁 / 军备充盈。', { 0: evolution.rounds.join('/') }) },
    { title: t('轻松也有挑战'), text: t('{totalRounds} 回合密集怪潮，{bossSpan}悬赏首领轮换；每回合随机效果，{lowTierMax} 阶及以下干员也有额外强化。', { totalRounds: v.totalRounds, bossSpan, lowTierMax: lowTier.lowTierMax }) },
  ];
}

function FirepowerBrief({ variant, onVariant }) {
  const rounds = variant === 'endurance' ? RANDOM_MODE.endurance.totalRounds : variant === 'marathon' ? RANDOM_MODE.marathon.totalRounds : RANDOM_MODE.totalRounds;
  return html`<aside class="firepower-brief brackets" aria-label=${t('无限火力模式特点')}>
    <div class="firepower-brief__head">
      <span class="firepower-brief__title">${t('无限火力')}</span><span class="mode-beta">1.1</span>
      <span class="firepower-brief__hint">${t('从标准难度开始，享受阵营成型与技能清场')}</span>
    </div>
    <div class="firepower-variants" role="radiogroup" aria-label=${t('模式分支')}>
      ${VARIANT_CARDS.map((c) => html`<button key=${c.id} type="button" role="radio" aria-checked=${variant === c.id ? 'true' : 'false'}
          class=${`firepower-variant${variant === c.id ? ' is-selected' : ''}`} onClick=${() => onVariant(c.id)}>
        <span class="firepower-variant__name">${t(c.name)}<span class="firepower-variant__en">${c.en}</span></span>
        <span class="firepower-variant__desc">${t(c.desc, c.descParams)}</span>
      </button>`)}
    </div>
    <div class="firepower-features">${firepowerFeatures(variant).map((f) => html`<div key=${f.title} class="firepower-feature">
      <strong>${f.title}</strong><p>${f.text}</p>
    </div>`)}</div>
  </aside>`;
}

/**
 * Text for a difficulty card, preferring data/config.json.
 * @param {'solo'|'coop'} roomMode
 * @param {string} difficulty
 * @param {{ random?: boolean, variant?: string }} [opts] 随机模式: the room's random flag + variant — the variant's
 *   round count (RANDOM_MODE / variantRounds: blitz 9 / endurance 13) replaces the config's lastRound everywhere
 *   the count is shown.
 * @returns {{ code: string, desc: string, effects: string[], rounds: number, hidden: boolean, stageNote: string }}
 */
export function difficultyInfo(roomMode, difficulty, { random = false, variant = 'blitz' } = {}) {
  const fallback = MODE_TEXT[roomMode === 'single' || roomMode === 'solo' ? 'single' : 'multi'][difficulty] || { code: '', desc: '', effects: [] };
  // modeIdFor() lower-cases the difficulty: never call it with a value the server did not validate.
  const m = DIFFICULTIES.includes(difficulty) ? getMode(modeIdFor(roomMode, difficulty)) : null;
  const effects = Array.isArray(m?.effectDescList)
    ? m.effectDescList.map((e) => String(e).replace(/^[·•\s]+/, '')).filter(Boolean)
    : fallback.effects;
  // 随机模式: the whole run is the variant's rounds (server GameData.applyRandomRounds; variantRounds)
  const rounds = random
    ? (variant === 'endurance' ? RANDOM_MODE.endurance.totalRounds : variant === 'marathon' ? RANDOM_MODE.marathon.totalRounds : RANDOM_MODE.totalRounds)
    : Number.isFinite(m?.lastRound) ? m.lastRound : roomMode === 'solo' && difficulty === 'FUNNY' ? 9 : 14;
  return {
    code: typeof m?.code === 'string' ? m.code : fallback.code,
    desc: typeof m?.desc === 'string' ? m.desc : t(fallback.desc),
    effects,
    rounds,
    hidden: !random && difficulty !== 'FUNNY',
    stageNote: stageNote(Array.isArray(m?.stages) && m.stages.length ? m.stages : STAGE_POOL[difficulty]),
  };
}

const CODE_RE = new RegExp(`^[A-Z0-9]{${ROOM_CODE_LEN}}$`);
/**
 * Normalise user input into a room code: accepts a pasted invite link (`…?room=ABCD`), keeps
 * upper-cased alphanumerics and clamps to the code length.
 * @param {string} v
 * @returns {string}
 */
export function normalizeCode(v) {
  let s = String(v ?? '');
  const m = s.match(/[?&]room=([A-Za-z0-9]+)/);
  if (m) s = m[1];
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LEN);
}

/**
 * A handler that Preact binds as `onClick=${fn}` receives the click EVENT as its first argument, and a default
 * parameter only applies to `undefined` — so `fn(c = code)` would normalise the event target into a nonsense code
 * (`String(el)` → `"[object HTMLElement]"` → "OBJE"). Only a string is ever a code; anything else falls back to the
 * input field. Returns null when neither yields a well-formed code.
 * @param {unknown} arg the argument a handler was called with
 * @param {string} field the current input-field value
 * @returns {string|null}
 */
export function codeArg(arg, field) {
  const k = normalizeCode(typeof arg === 'string' ? arg : field);
  return CODE_RE.test(k) ? k : null;
}

/**
 * Room code from a deep link query string (`?room=CODE`), or null when absent/malformed.
 * Accepts ROOM_CODE_LEN..ROOM_CODE_LEN+2 alphanumerics (the protocol's join limit).
 * @param {string} search e.g. location.search
 * @returns {string|null}
 */
export function parseRoomParam(search) {
  try {
    const raw = new URLSearchParams(search || '').get('room');
    if (!raw) return null;
    const code = raw.trim().toUpperCase();
    if (!/^[A-Z0-9]+$/.test(code)) return null;
    return code.length >= ROOM_CODE_LEN && code.length <= ROOM_CODE_LEN + 2 ? code : null;
  } catch {
    return null;
  }
}

/** Recently joined/created co-op room codes (most recent first). */
export function recentRooms() {
  const list = loadPref('recentRooms', []);
  return Array.isArray(list) ? list.filter((c) => typeof c === 'string' && CODE_RE.test(c)).slice(0, 4) : [];
}

/** @param {string} code */
export function rememberRoom(code) {
  if (!CODE_RE.test(code)) return;
  savePref('recentRooms', [code, ...recentRooms().filter((c) => c !== code)].slice(0, 4));
}

const FALLBACK_TIPS = [
  N_('联合模拟在选择策略时可以进行一次跳过'),
  N_('调度中心即使冻结，依然可以主动刷新'),
  N_('两件同名装备可以合成一件更强力的装备'),
  N_('只有达成完美作战的队友可以进行联防'),
];
const TIP_ROTATE_MS = 5000; // matchingTipRotateInterval

/** Rotating tactical tips (config.json `tips`, weighted list of { tip, weight }). */
function TipsPanel() {
  const cfg = getConfig();
  const fallback = FALLBACK_TIPS.map((x) => t(x));
  const tips = Array.isArray(cfg?.tips)
    ? cfg.tips.map((x) => (typeof x === 'string' ? x : x?.tip)).filter((x) => typeof x === 'string' && x)
    : fallback;
  const list = tips.length ? tips : fallback;
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * list.length));
  useEffect(() => {
    const id = setInterval(() => setIdx((i) => i + 1), TIP_ROTATE_MS);
    return () => clearInterval(id);
  }, []);
  const i = ((idx % list.length) + list.length) % list.length;
  return html`<div class="tips brackets">
    <div class="tips__head">
      <${Icon} name="info" />
      <span>${t('作战提示')}</span>
      <${MicroLabel}>TACTICAL TIPS<//>
      <span class="tips__idx num">${String(i + 1).padStart(2, '0')}<span class="t-dim">/${String(list.length).padStart(2, '0')}</span></span>
      <button type="button" class="tips__nav" onClick=${() => setIdx(i - 1 + list.length)} aria-label=${t('上一条')}><${Icon} name="chevronLeft" /></button>
      <button type="button" class="tips__nav" onClick=${() => setIdx(i + 1)} aria-label=${t('下一条')}><${Icon} name="chevronRight" /></button>
    </div>
    <p key=${i} class="tips__text">${list[i]}</p>
  </div>`;
}


/** 全屏 / 退出全屏 in the top bar, styled like its neighbours (hidden where the browser has no element fullscreen). */
function HubFullscreenButton() {
  const [on, setOn] = useState(() => fullscreen.active());
  const [ok] = useState(() => fullscreen.supported());
  useEffect(() => {
    const upd = () => setOn(fullscreen.active());
    document.addEventListener('fullscreenchange', upd);
    document.addEventListener('webkitfullscreenchange', upd);
    return () => { document.removeEventListener('fullscreenchange', upd); document.removeEventListener('webkitfullscreenchange', upd); };
  }, []);
  if (!ok) return null;
  const label = on ? t('退出全屏') : t('全屏');
  return html`<${Button} variant="secondary" size="sm" square=${true} icon=${on ? 'collapse' : 'expand'} class="hub-fs-btn"
    title=${label} aria-label=${label} aria-pressed=${on ? 'true' : 'false'} onClick=${() => fullscreen.toggle()} />`;
}

/** Crossed blades in a hexagon: the S.W.E.E.P. plate's glyph (original drawing). */
function SweepGlyph() {
  return html`<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <path d="M16 2.5 27.7 9.2v13.6L16 29.5 4.3 22.8V9.2z" fill="none" stroke="currentColor" stroke-width="1.5" />
    <path d="M9 9l12.5 12.5M23 9 10.5 21.5" stroke="currentColor" stroke-width="2.2" />
    <path d="M19.2 23.8l4.6-4.6M8.2 19.2l4.6 4.6M21.6 21.6l2.2 2.2M10.4 21.6l-2.2 2.2" stroke="currentColor" stroke-width="1.8" />
  </svg>`;
}

/** S.W.E.E.P.报告: opens the report (screens/sweep.js — 盟约报告 / 策略报告 / 敌方资料). */
function SweepPlate({ onClick }) {
  return html`<button type="button" class="hub-plate hub-plate--sweep" onClick=${onClick} title=${t('S.W.E.E.P.报告：盟约、策略与敌方资料')}>
    <span class="hub-plate__glyph"><${SweepGlyph} /></span>
    <span class="hub-plate__label">S.W.E.E.P.${t('报告')}</span>
    <span class="hub-plate__tag">REPORT</span>
  </button>`;
}

/** One of the four big entries at the bottom right. */
function HubEntry({ group, name, en, icon, badge, tone = 'mint', count = null, onClick, disabled = false }) {
  return html`<div class="hub-entry-wrap">
    ${group ? html`<span class="hub-entry__group"><${Icon} name=${group.icon} />${group.label}</span>` : html`<span class="hub-entry__group hub-entry__group--blank"></span>`}
    <button type="button" class=${`hub-entry hub-entry--${tone}`} onClick=${onClick} disabled=${disabled}>
      <span class="hub-entry__icon"><${Icon} name=${icon} /></span>
      <span class="hub-entry__en">${en}</span>
      <span class="hub-entry__name">${name}${badge ? html`<span class="mode-beta">${badge}</span>` : null}</span>
      ${count != null ? html`<span class="hub-entry__count"><${MatchmakingCount} count=${count} /></span>` : null}
      <span class="hub-entry__corner" aria-hidden="true"></span>
    </button>
  </div>`;
}

/** A small tile of the side column. */
function HubTile({ icon, label, en, onClick, children }) {
  return html`<button type="button" class="hub-tile" onClick=${onClick}>
    <span class="hub-tile__icon"><${Icon} name=${icon} /></span>
    <span class="hub-tile__text"><span class="hub-tile__label">${label}</span><span class="hub-tile__en">${en}</span></span>
    ${children}
  </button>`;
}

/** Shared frame of the hub's two dialogs (the start sheet, 密钥加入). */
function HubDialog({ open, micro, title, onClose, wide = false, children }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    addEventListener('keydown', onKey);
    // the lobby chat (z 180, ui/communityChat.js) sits above modals: it steps aside while a hub dialog is open
    document.body.classList.add('hub-dialog-open');
    return () => { removeEventListener('keydown', onKey); document.body.classList.remove('hub-dialog-open'); };
  }, [open]);
  if (!open) return null;
  return html`<div class="modal hub-dialog" role="presentation" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
    <div class=${`modal__box hub-dialog__box brackets${wide ? ' hub-dialog__box--wide' : ''}`} role="dialog" aria-modal="true">
      <div class="modal__stripe" aria-hidden="true"></div>
      <header class="hub-dialog__head">
        <${MicroLabel} tone="mint">${micro}<//>
        <div class="hub-dialog__title-row">
          <h2 class="modal__title">${title}</h2>
          <button type="button" class="mm-modal__close" onClick=${onClose} aria-label=${t('关闭')}><${Icon} name="close" /></button>
        </div>
      </header>
      <div class="hub-dialog__body">${children}</div>
    </div>
  </div>`;
}

function DifficultyCard({ roomMode, difficulty, selected, onSelect, matchmaking, random = false, variant = 'blitz' }) {
  const info = difficultyInfo(roomMode, difficulty, { random, variant });
  return html`<button type="button" class=${`diff-card${selected ? ' is-selected' : ''}`}
      style=${`--d-color:${DIFFICULTY_COLORS[difficulty]}`} onClick=${() => onSelect(difficulty)} aria-pressed=${selected ? 'true' : 'false'}>
    <span class="diff-card__bar" aria-hidden="true"></span>
    <span class="diff-card__head">
      <${DifficultyIcon} difficulty=${difficulty} class="diff-card__glyph" />
      <span class="diff-card__name">${t(DIFFICULTY_NAMES[difficulty])}</span>
      <span class="diff-card__code num">${info.code}</span>
      ${roomMode === 'coop' && !random ? html`<${MatchmakingCount} count=${matchmaking?.byDifficulty?.[difficulty]} />` : null}
      <span class="diff-card__meta">
        <span class="num">${info.rounds}</span> ${tc('rounds', '回合')}${info.hidden ? html`<span class="diff-card__hidden">${t('+ 隐秘核心')}</span>` : null}
      </span>
    </span>
    <span class="diff-card__desc">${info.desc}</span>
    <span class="diff-card__effects">${info.effects.map((e) => html`<span key=${e}>${e}</span>`)}${info.stageNote ? html`<span key="stage" class="diff-card__stage"><${Icon} name="rook" />${info.stageNote}</span>` : null}</span>
    <span class="diff-card__check" aria-hidden="true"><${Icon} name="check" /><span>${t('已选定')}</span></span>
  </button>`;
}

/** The hand-drawn ring of the 已选定 stamp (two loose strokes). */
function StampRing() {
  return html`<svg class="pcard__ring" viewBox="0 0 120 100" aria-hidden="true" focusable="false">
    <path pathLength="1" d="M18 62C6 34 34 8 70 10c34 2 48 30 38 54-10 24-46 32-72 22C20 80 10 66 16 50" />
    <path pathLength="1" d="M30 20c22-14 62-12 78 10 12 18 4 44-16 54" />
  </svg>`;
}

/** 正在加入同盟…: bottom left while the room is being opened, a light running along the bottom edge (css tr-join). */
function JoinLine({ text }) {
  return html`<div class="tr-join" role="status"><span class="tr-join__mark" aria-hidden="true"></span>${text}<span class="tr-join__dots" aria-hidden="true"></span></div>`;
}

/** One difficulty of 选择模拟协议: name, text, effects; the extras (code, rounds, 隐秘核心, battlefields, queue) below. */
export function ProtoCard({ roomMode, difficulty, selected, onSelect, matchmaking, random, variant }) {
  const info = difficultyInfo(roomMode, difficulty, { random, variant });
  return html`<button type="button" class=${`pcard${selected ? ' is-on' : ''}`} style=${`--d-color:${DIFFICULTY_COLORS[difficulty]}`}
      onClick=${() => onSelect(difficulty)} aria-pressed=${selected ? 'true' : 'false'}>
    <span class="pcard__glow" aria-hidden="true"></span>
    <span class="pcard__head">
      <${DifficultyIcon} difficulty=${difficulty} class="pcard__glyph" />
      <span class="pcard__name">${t(DIFFICULTY_NAMES[difficulty])}</span>
      ${roomMode === 'coop' && !random ? html`<${MatchmakingCount} count=${matchmaking?.byDifficulty?.[difficulty]} />` : null}
    </span>
    <span class="pcard__desc">${info.desc}</span>
    <span class="pcard__effects">${info.effects.map((e) => html`<span key=${e}>${e}</span>`)}</span>
    <span class="pcard__meta">
      ${info.code ? html`<span class="num">${info.code}</span>` : null}
      <span><b class="num">${info.rounds}</b> ${tc('rounds', '回合')}${info.hidden ? t(' + 隐秘核心') : ''}</span>
      ${info.stageNote ? html`<span>${info.stageNote}</span>` : null}
    </span>
    <span class="pcard__stamp" aria-hidden="true"><${StampRing} /><span class="pcard__tick"><${Icon} name="check" /></span><span class="pcard__ok">${t('已选定')}</span></span>
  </button>`;
}

/**
 * 选择模拟协议 (2026-10-13, the owner's request: the event's second screen after 独立模拟): full screen, the picture of
 * the selected difficulty at the left (ui/protocolScene.js, original), the difficulties down the right with the
 * 已选定 stamp, 开始模拟 at the bottom right. Kept from the old start sheet: 无限火力's variants and notes, the queue
 * counts, rounds / 隐秘核心 / battlefields and the hints. Esc or ‹ returns to the hub.
 * Comes up from black over the hub (`chained`: straight after 选择同盟方式, already black) and fades back out
 * (ui/transitions.js); the picture is redrawn for each difficulty.
 */
function ProtocolSelect({ card, roomMode, random, variant, difficulty, onDifficulty, onClose, matchmaking, brief,
  online, maint, busy, isSearching, onCreate, purpose = 'create', onSearch, onCancel, onAccept, offering = false, mm, chained = false }) {
  const [leaving, leave] = useLeave(onClose);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal, .guide')) leave(); };
    addEventListener('keydown', onKey);
    document.body.classList.add('hub-dialog-open');
    return () => { removeEventListener('keydown', onKey); document.body.classList.remove('hub-dialog-open'); };
  }, []);
  const fx = `${leaving ? ' is-leaving' : ''}${chained ? ' is-chained' : ''}`;
  const search = purpose === 'search';
  const info = difficultyInfo(roomMode, difficulty, { random, variant });
  const label = maint?.active ? t('维护中 · 暂停开局') : search ? t('开始搜寻') : random ? t('创建无限火力') : roomMode === 'solo' ? t('开始模拟') : t('创建同盟');
  const hint = !online ? t('正在连接服务器…') : maint?.active ? t('服务器即将停机维护，暂时停止开启新的同盟')
    : search ? t('精确搜寻：只与选择相同难度的博士组成同盟，凑齐 4 人即开始')
    : isSearching ? t('正在匹配真人队友，AI 补位已暂停') : roomMode === 'solo' ? t('独自调配阵容，按自己的节奏开始模拟') : t('创建后可邀请好友，AI 队友已暂停');
  // 搜寻队友: while the queue runs, the right column is the 搜寻中 panel (the server's elapsed / matched counts)
  if (search && isSearching) {
    const d = mm?.difficulty && DIFFICULTIES.includes(mm.difficulty) ? mm.difficulty : difficulty;
    return html`<div class=${`proto proto--searching${fx}`} style=${`--d-color:${DIFFICULTY_COLORS[d]}`} data-difficulty=${d} role="dialog" aria-label=${t('搜寻队友')}>
      <div class="proto__bg" aria-hidden="true"></div>
      <header class="proto-top">
        <button type="button" class="proto-back" onClick=${leave} title=${t('返回大厅（继续搜寻）')} aria-label=${t('返回大厅')}>
          <${Icon} name="chevronLeft" /><span class="proto-back__home"><${Icon} name="rook" /></span>
        </button>
      </header>
      <div class="proto-body">
        <section class="proto-stage"><${ProtocolScene} key=${d} difficulty=${d} /></section>
        <section class="proto-side proto-side--search">
          ${offering ? html`<div class="proto-offer" role="status">
            <${MicroLabel}>MATCH FOUND<//>
            <h3>${t('队友已集结')}</h3>
            <p>${t('全员确认后直接开局；超时未确认则继续等待队友')}</p>
            <${Button} variant="primary" block=${true} icon="check" disabled=${!online || !!busy} loading=${busy === 'accept'}
              onClick=${onAccept}>${t('确认入场')}<//>
          </div>` : null}
          <${SearchPanel} elapsed=${mm?.elapsed || 0} onStop=${onCancel} stopping=${busy === 'cancel'}
            note=${t('已找到 {matched}/{target} 名博士', { matched: mm?.matched || 1, target: mm?.target || 4 })}
            tags=${[{ key: 'mode', label: t('精确搜寻'), icon: html`<${Icon} name="search" />` },
              { key: 'diff', label: t(DIFFICULTY_NAMES[d]), color: DIFFICULTY_COLORS[d], icon: html`<${DifficultyIcon} difficulty=${d} />` }]} />
        </section>
      </div>
    </div>`;
  }
  return html`<div class=${`proto${fx}`} style=${`--d-color:${DIFFICULTY_COLORS[difficulty]}`} data-difficulty=${difficulty} role="dialog" aria-label=${t('选择模拟协议')}>
    <div class="proto__bg" aria-hidden="true"></div>
    <header class="proto-top">
      <button type="button" class="proto-back" onClick=${leave} title=${t('返回大厅 (Esc)')} aria-label=${t('返回大厅')}>
        <${Icon} name="chevronLeft" /><span class="proto-back__home"><${Icon} name="rook" /></span>
      </button>
      <div class="proto-title">
        <h2>${t('选择模拟协议')}</h2>
        <span class="proto-title__mode">${search ? t('搜寻队友') : t(card.name)}<i>${search ? 'FIND ALLIES' : card.en}</i></span>
      </div>
    </header>
    <div class="proto-body">
      <section class="proto-stage">
        <${ProtocolScene} key=${difficulty} difficulty=${difficulty} />
        <div class="proto-brief">
          <span class="proto-brief__code num">${info.code}</span>
          <b class="proto-brief__name">${t(DIFFICULTY_NAMES[difficulty])}</b>
          <p>${t(card.desc, card.params)}</p>
        </div>
        ${brief ? html`<div class="proto-fp">${brief}</div>` : null}
      </section>
      <section class="proto-side">
        <div class="proto-list" role="radiogroup" aria-label=${t('模拟难度')}>
          ${DIFFICULTIES.map((d) => html`<${ProtoCard} key=${d} roomMode=${roomMode} difficulty=${d} selected=${difficulty === d} onSelect=${onDifficulty}
            matchmaking=${matchmaking} random=${random} variant=${variant} />`)}
        </div>
        <div class="proto-foot">
          ${search ? html`<div class="proto-opts">
            <span class="proto-mode-chip"><${Icon} name="search" />${t('精确搜寻')}</span>
          </div>` : null}
          <p class="proto-hint">${hint}</p>
          <button type="button" class="proto-start" disabled=${!online || maint?.active || busy === 'create'} onClick=${search ? onSearch : onCreate}>
            <span class="proto-start__mark" aria-hidden="true"><span class="proto-start__rook"><i>[</i><${Icon} name="rook" /><i>]</i></span><small>STRONGHOLD<br />PROTOCOL</small></span>
            <span class="proto-start__label">${busy === 'create' ? html`<${Spinner} size="sm" />` : null}${label}</span>
            <span class="proto-start__deco" aria-hidden="true"></span>
          </button>
        </div>
      </section>
    </div>
    ${busy === 'create' ? html`<${JoinLine} text=${roomMode === 'solo' ? t('正在进入模拟') : t('正在建立同盟')} />` : null}
  </div>`;
}

/**
 * 选择同盟方式 (2026-10-13, the owner's request: the event's screen after 同盟模拟, video 5:22–6:29): the radar at the
 * left (ui/matchFlow.js), 创建同盟 (a room at the remembered difficulty — it is changed in the room) and 加入同盟 (the
 * key field, 观战, recent keys) at the right, 入门协议 (玩法说明) at the bottom left. Esc or ‹ returns to the hub.
 */
function AllianceSelect({ onClose, code, onCode, codeOk, recent, online, maint, busy, onCreate, onJoin, onSpectate, difficulty }) {
  const [leaving, leave] = useLeave(onClose);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal, .guide')) leave(); };
    addEventListener('keydown', onKey);
    document.body.classList.add('hub-dialog-open');
    return () => { removeEventListener('keydown', onKey); document.body.classList.remove('hub-dialog-open'); };
  }, []);
  const joining = busy === 'create' ? t('正在建立同盟') : busy === 'join' ? t('正在加入同盟') : busy === 'spectate' ? t('正在进入观战') : null;
  return html`<div class=${`proto ally${leaving ? ' is-leaving' : ''}`} role="dialog" aria-label=${t('选择同盟方式')}>
    <div class="proto__bg ally__bg" aria-hidden="true"></div>
    <header class="proto-top">
      <button type="button" class="proto-back" onClick=${leave} title=${t('返回大厅 (Esc)')} aria-label=${t('返回大厅')}>
        <${Icon} name="chevronLeft" /><span class="proto-back__home"><${Icon} name="rook" /></span>
      </button>
      <div class="proto-title"><h2>${t('选择同盟方式')}</h2><span class="proto-title__mode ally__mode">${t('同盟模拟')}<i>ALLIANCE SIMULATION</i></span></div>
    </header>
    <div class="proto-body ally-body">
      <section class="ally-stage"><${RadarScene} />
        <button type="button" class="ally-guide" onClick=${() => openGuide(0)}><span class="ally-guide__icon"><${Icon} name="book" /></span>${t('入门协议')}</button>
      </section>
      <section class="ally-side">
        <button type="button" class="ally-card ally-card--create" disabled=${!online || maint?.active || busy === 'create'} onClick=${onCreate}>
          <span class="ally-card__art"><${CreateArt} /></span>
          <span class="ally-card__bar"><span class="ally-card__icon"><${Icon} name="plus" /></span>${maint?.active ? t('维护中 · 暂停开局') : t('创建同盟')}
            ${busy === 'create' ? html`<${Spinner} size="sm" />` : html`<small>${t('难度：{name}（可在同盟内更改）', { name: t(DIFFICULTY_NAMES[difficulty]) })}</small>`}</span>
        </button>
        <div class="ally-card ally-card--join">
          <span class="ally-card__art"><${JoinArt} /></span>
          <label class="ally-key"><${Icon} name="search" />
            <input type="text" value=${code} placeholder=${t('输入同盟密钥')} maxlength="64" autocomplete="off" spellcheck="false"
              onInput=${(e) => onCode(e.currentTarget.value)} onKeyDown=${(e) => { if (e.key === 'Enter') onJoin(); }} />
            ${codeOk ? html`<button type="button" class="ally-key__spec" disabled=${!online || busy === 'spectate'} onClick=${onSpectate}
              title=${t('以观战者身份进入：不占博士席位，只能观看（每个同盟最多 {MAX_SPECTATORS} 名，模拟进行中也可进入）', { MAX_SPECTATORS })}><${Icon} name="eye" />${t('观战')}</button>` : null}
          </label>
          ${recent.length ? html`<span class="ally-recent">${recent.map((c) => html`<button key=${c} type="button" class="code-chip num" title=${t('填入密钥（不会直接加入）')} onClick=${() => onCode(c)}>${c}</button>`)}</span>` : null}
          <button type="button" class="ally-card__bar ally-card__bar--join" disabled=${!codeOk || !online || busy === 'join'} onClick=${() => onJoin()}>
            <span class="ally-card__icon"><${Icon} name="users" /></span>${t('加入同盟')}${busy === 'join' ? html`<${Spinner} size="sm" />` : null}
          </button>
        </div>
      </section>
    </div>
    ${joining ? html`<${JoinLine} text=${joining} />` : null}
  </div>`;
}


// package: features follow the target server's message list (shared/protocol.js C2S)
const HAS = (type) => !!SERVER_C2S && Object.hasOwn(SERVER_C2S, type);
const CAN_FIREPOWER = HAS('room.setRandom');
// This fork's 同盟匹配 (server/matchmaking.js: identified players of ONE difficulty, the group gets a room of its own)
// takes the hub's 搜寻队友 entry: `match.queue` is not a message this server knows, `queue.join` is.
const CAN_SEARCH = true;

/** Lobby screen component. */
export function LobbyScreen() {
  const matchmakingCounts = useStore(s => s.presence?.matchmaking);
  const me = useStore((s) => s.me, shallowEqual);
  const conn = useStore((s) => s.connection, shallowEqual);
  useData('config');
  const [simulation, setSimulation] = useState(lobbySimulationPreference);
  const [difficulty, setDifficulty] = useState(() => preferredDifficulty(lobbySimulationPreference()));
  const [fpVariant, setFpVariant] = useState(firepowerVariantPreference);
  const roomMode = simulation === 'solo' ? 'solo' : 'coop';
  const randomMode = simulation === 'firepower';
  const variant = randomMode ? fpVariant : 'blitz';
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(null);
  const [recent] = useState(recentRooms);
  const alive = useRef(true);
  const inFlight = useRef(false); // synchronous guard against double clicks (state updates are async)
  useEffect(() => () => { alive.current = false; }, []);

  const resourcesReady = useStore((s) => !s.session.preloadRequired || s.session.preloadReady);
  const online = conn.status === 'online' && resourcesReady;
  const codeOk = CODE_RE.test(code);
  const mm = useStore((s) => s.matchmaking, shallowEqual);
  const maint = useStore((s) => s.maintenance, shallowEqual);
  const bg = useHubBackdrop();
  const [bgOpen, setBgOpen] = useState(false);
  const [sweepOpen, setSweepOpen] = useState(false);
  // The Android shell can ask the local network who hosts a key, so a guest never types an address: the code is enough.
  const nativeShell = globalThis.AndroidNative?.isNativeApp?.() ? globalThis.AndroidNative : null;
  const [lanRoom, setLanRoom] = useState(null);
  const [lanNote, setLanNote] = useState('');
  useEffect(() => {
    if (!nativeShell || roomMode !== 'coop' || !codeOk) { setLanRoom(null); return undefined; }
    let cancelled = false;
    setLanRoom(null);
    setLanNote(t('正在局域网中查找该房间…'));
    globalThis.__onRoomFound = (list) => {
      if (cancelled) return;
      const host = (list || []).find((h) => !h.self);
      if (host) { setLanRoom(host); setLanNote(t('已找到房主 {ip}（{1} 人在房）· 点「加入同盟」进入', { ip: host.ip, 1: host.humans || 0 })); }
      else setLanNote(t('局域网里没有这个房间：确认房主已创建同盟模拟房间，且两台设备在同一网络'));
    };
    nativeShell.findRoom(code);
    return () => { cancelled = true; delete globalThis.__onRoomFound; };
  }, [code, roomMode]);
  const isSearching = mm?.status === 'searching';
  // server/matchmaking.js reports { status: 'searching', difficulty, joinedAt, players, target, serverNow }; the hub's
  // HUD counts in matched / elapsed, so the mapping lives here — and the elapsed time comes from the SERVER's clock
  // (serverNow), which is what every other display in this app uses.
  const mmView = isSearching ? {
    ...mm, matched: mm.players, target: mm.target || MAX_SEATS,
    elapsed: mm.joinedAt ? Math.max(0, Math.floor((serverNow() - mm.joinedAt) / 1000)) : 0,
  } : mm;
  const [, setMmTick] = useState(0);
  useEffect(() => {
    if (!isSearching) return undefined;
    const timer = setInterval(() => setMmTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [isSearching, mm?.joinedAt]);

  const pickMode = (m) => {
    if (!MODE_CARDS.some((c) => c.id === m)) return;
    // Normal modes share their difficulty; firepower remembers its own explicitly chosen difficulty.
    if ((m === 'firepower') !== randomMode) setDifficulty(preferredDifficulty(m));
    setSimulation(m);
    savePref('lobby.simulation', m);
    savePref('lobby.mode', m === 'solo' ? 'solo' : 'coop');
    savePref('lobby.random', m === 'firepower');
  };
  const pickDifficulty = (d) => {
    setDifficulty(d);
    savePref(randomMode ? 'lobby.firepowerDifficulty' : 'lobby.difficulty', d);
  };

  const run = async (kind, fn) => {
    if (inFlight.current) return;
    if (!online) { toast(t('尚未连接到服务器，请稍候'), 'warn'); return; }
    inFlight.current = true;
    setBusy(kind);
    try { await fn(); } catch (err) { toastError(err); } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };
  const pickVariant = (v) => {
    setFpVariant(v);
    savePref('lobby.firepowerVariant', v);
  };

  const create = () => run('create', () => net.request('room.create', { mode: roomMode, difficulty, random: randomMode, ...(randomMode ? { variant } : {}) }));
  const queueMatch = () => run('search', () => net.request('queue.join', { difficulty }));
  const cancelMatch = () => run('cancel', () => net.request('queue.cancel', { ticketId: mm?.ticketId }));
  const acceptMatch = () => run('accept', () => net.request('queue.accept', { ticketId: mm?.ticketId, offerId: mm?.offerId }));
  const join = (c = code, federationNode) => {
    // `onClick=${join}` hands the click EVENT as the first argument, and a default parameter only applies to
    // `undefined` — codeArg keeps an event target out of the key and falls back to the input field
    const k = codeArg(c, code);
    if (!CODE_RE.test(k)) { toast(t('同盟密钥为 {ROOM_CODE_LEN} 位字母或数字', { ROOM_CODE_LEN }), 'warn'); return; }
    // A room found on another phone is a different origin: hand the WebView over to it instead of asking the
    // server we are on, which by definition does not have that room.
    if (nativeShell && lanRoom) {
      nativeShell.connectToHost(lanRoom.ip, k);
      setLanNote(t('正在进入 {ip} 的房间…', { ip: lanRoom.ip }));
      return;
    }
    run('join', () => net.request('room.join', { code: k, ...(federationNode ? { federationNode } : {}) }));
  };
  // a spectator seat: no player seat taken, nothing to do but watch (also a match already running)
  const spectate = (c = code, federationNode) => {
    // same guard as join: `onClick=${spectate}` passes the click event, not a code
    const k = codeArg(c, code);
    if (!k) { toast(t('同盟密钥为 {ROOM_CODE_LEN} 位字母或数字', { ROOM_CODE_LEN }), 'warn'); return; }
    run('spectate', () => net.request('room.spectate', { code: k, ...(federationNode ? { federationNode } : {}) }).catch((err) => {
      // Clearer than the bare ERR_TEXT: the usual cause is a code that is not the host's (a remembered one from an
      // earlier room, or another machine's) — the server can only answer "no such room".
      if (err?.code === ERR.ROOM_NOT_FOUND) {
        toast(t('没有找到密钥 {k} 对应的同盟：请和房主核对密钥（同盟结束后密钥即失效）', { k }), 'warn');
        return;
      }
      if (err?.code === ERR.ALREADY) {
        toast(t('你已经是该同盟的博士：先离开同盟，才能以观战身份进入'), 'warn');
        return;
      }
      throw err;
    }));
  };
  const returnToTitle = () => {
    identity.setEntered(false);
    store.set((s) => ({ session: { ...s.session, entered: false } }));
  };
  // leaving the hub while the queue runs cancels it first: a queue entry outlives this screen otherwise
  const backToTitle = () => isSearching
    ? run('cancel', async () => { await net.request('queue.cancel', { ticketId: mm?.ticketId }); returnToTitle(); })
    : returnToTitle();
  // hub dialogs: the start sheet of a picked mode, 密钥加入 (opened by an invite code in the URL too)
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetPurpose, setSheetPurpose] = useState('create'); // 'create' | 'search' (搜寻队友)
  const [allyOpen, setAllyOpen] = useState(false);            // 选择同盟方式
  const [sheetChained, setSheetChained] = useState(false);    // opened from 选择同盟方式: no darkening of the hub between
  const [joinOpen, setJoinOpen] = useState(false);
  const [achOpen, setAchOpen] = useState(false);              // 成就统计 (ui/achievements.js)
  // 同盟模拟 → 选择同盟方式; 独立模拟 / 无限火力 → 选择模拟协议
  const openMode = (m) => { pickMode(m); if (m === 'coop') setAllyOpen(true); else { setSheetPurpose('create'); setSheetChained(false); setSheetOpen(true); } };
  const openSearch = () => { pickMode('coop'); setSheetChained(allyOpen); setAllyOpen(false); setSheetPurpose('search'); setSheetOpen(true); };
  const modeCard = MODE_CARDS.find((c) => c.id === simulation) || MODE_CARDS[0];

  return html`<div class=${`screen lobby-screen lobby-hub${isSearching ? ' lobby-hub--searching' : ''}`} data-hub-theme=${backdropTheme(bg)}>
    <${HubBackdrop} bg=${bg} />
    <header class="topbar hub-topbar">
      <div class="topbar__left">
        <${Button} variant="ghost" size="sm" icon="chevronLeft" onClick=${backToTitle} title=${t('返回标题')}>${t('返回')}<//>
        <${PingPill} ms=${conn.ping} online=${online} />
        <span class="topbar__sep" aria-hidden="true"></span>
        <div class="topbar__tools">
          <${SettingsButton} class="lobby-settings" variant="secondary" square=${true} />
          <${AnnouncementButton} variant="secondary" square=${true} />
          <${GuideButton} class="lobby-guide" variant="secondary" square=${true} />
          <${Button} variant="secondary" size="sm" square=${true} class="hub-bg-btn" onClick=${() => setBgOpen(true)}
            title=${t('大厅背景')} aria-label=${t('大厅背景')}><${BackdropGlyph} /><//>
          <${HubFullscreenButton} />
          <${LobbyMusicButton} />
          <${PwaInstallButton} class="lobby-pwa" square=${true} />
        </div>
      </div>
      <div class="topbar__right">
        <${ResumeMatchButton} />
        <${AccountMeChip} player=${me} onStats=${openStats} />
      </div>
    </header>

    <main class="hub-stage">
      <div class="hub-center">
        <div class="hub-center__mark"><${HubRadar} bg=${bg} /><${Emblem} /></div>
        <div class="hub-center__en">STRONGHOLD PROTOCOL <b>ALLIANCE</b></div>
        <h1 class="hub-center__title">${t('卫戍协议：盟约')}</h1>
      </div>

      <aside class="hub-side">
        <${AchievementEntry} key=${achOpen ? 'open' : 'shut'} onOpen=${() => setAchOpen(true)} />
        <${HubTile} icon="chart" label=${t('统计数据')} en="STATISTICS" onClick=${() => openStats('overview')} />
        <${HubTile} icon="key" label=${t('密钥加入')} en="JOIN WITH KEY" onClick=${() => setJoinOpen(true)} />
        <${FriendsTile} />
        <${TipsPanel} />
        <footer class="hub-credits">
          <p class="hub-credits__group"><button type="button" class="hub-credits__copy"
            title=${`${t('复制')} ${t('防失联群')} ${COMMUNITY_GROUP}`} aria-label=${`${t('复制')} ${t('防失联群')} ${COMMUNITY_GROUP}`}
            onKeyDown=${(e) => e.stopPropagation()} onClick=${async () => {
              const ok = await copyText(COMMUNITY_GROUP);
              toast(ok ? t('已复制到剪贴板') : t('复制失败，请手动复制'), ok ? 'success' : 'warn');
            }}><${Icon} name="copy" />${t('防失联群')} <strong class="num">${COMMUNITY_GROUP}</strong></button></p>
          <p>${t('界面设计')} <strong>${DESIGN_CREDIT}</strong></p>
          <p class="hub-credits__meta">${t('非官方同人复刻 · 游戏素材版权归 上海鹰角网络 / Yostar 所有')} · <a href=${REPOSITORY_URL} target="_blank" rel="noopener noreferrer">${t('项目仓库')}</a><span> · v${APP_VERSION}</span></p>
        </footer>
      </aside>

      <aside class="hub-right">
        <${AnnouncementCard} />
        <div class="hub-right__plates">
          <${SweepPlate} onClick=${() => setSweepOpen(true)} />
          <${LoadoutButton} from="lobby" size="lg" class="hub-plate hub-plate--loadout" label=${t('干员调配')} />
        </div>
      </aside>

      <section class="hub-entries" aria-label=${t('模拟方式')}>
        ${isSearching ? html`<div class="matching-panel brackets hub-searching" role="status">
          <div class="matching-panel__head"><div><${MicroLabel}>SEARCHING FOR DOCTORS<//><h2>${t('正在搜寻队友')}</h2></div><span class="matching-panel__time num">${String(Math.floor((mmView?.elapsed || 0) / 60)).padStart(2, '0')}:${String((mmView?.elapsed || 0) % 60).padStart(2, '0')}</span></div>
          <div class="matching-panel__count"><${Spinner} label="SEARCHING" /><div><strong class="num">${mmView?.matched || 1}/${mmView?.target || MAX_SEATS} ${t('名博士')}</strong><p>${DIFFICULTY_NAMES[mmView?.difficulty] ? t(DIFFICULTY_NAMES[mmView.difficulty]) : ''} · ${t('当前站点')}</p></div></div>
          <progress class="matching-panel__progress" max=${mmView?.target || MAX_SEATS} value=${mmView?.matched || 1} aria-label=${t('匹配队列人数')}></progress>
          <p class="matching-panel__note">${t('等待同站同难度的博士，凑齐 4 人后直接进入模拟。可随时取消，不添加 AI 队友。')}</p>
          <${RecruitHint} />
          <${Button} variant="ghost" size="lg" icon="chevronLeft" loading=${busy === 'cancel'} onClick=${cancelMatch}>${t('取消搜寻')}<//>
          <p class="matching-panel__foot">${t('匹配成功后无需房间准备，可在本局信息确认阶段查看同盟密钥。')}</p>
        </div>` : null}
        ${maint?.active ? html`<div class="hub-maint">${t('服务器即将维护，暂停开启新的模拟')}</div>` : null}
        <div class="hub-entries__row">
          <${HubEntry} group=${{ icon: 'user', label: t('独立模拟') }} name=${t('独立模拟')} en="SOLO" icon="user" onClick=${() => openMode('solo')} />
          <${HubEntry} group=${{ icon: 'users', label: t('同盟模拟') }} name=${t('同盟模拟')} en="ALLIANCE" icon="users" count=${matchmakingCounts?.total} onClick=${() => openMode('coop')} />
          ${CAN_FIREPOWER ? html`<${HubEntry} name=${t('无限火力')} en="FIREPOWER" icon="dice" badge="1.1" tone="gold" onClick=${() => openMode('firepower')} />` : null}
          ${CAN_SEARCH ? html`<${HubEntry} name=${t('同盟匹配')} en="ALLIANCE MATCH" icon="search" tone="bright" onClick=${openSearch} />` : null}
        </div>
      </section>
    </main>

    ${sheetOpen ? html`<${ProtocolSelect} card=${modeCard} roomMode=${roomMode} random=${randomMode} variant=${variant} difficulty=${difficulty}
      onDifficulty=${pickDifficulty} onClose=${() => setSheetOpen(false)} matchmaking=${matchmakingCounts}
      brief=${randomMode ? html`<${FirepowerBrief} variant=${fpVariant} onVariant=${pickVariant} />` : null}
        online=${online} maint=${maint} busy=${busy} isSearching=${isSearching}
        onCreate=${create}
        purpose=${sheetPurpose} onSearch=${queueMatch} onCancel=${cancelMatch} onAccept=${acceptMatch}
      offering=${!!mmView?.offerId && !mmView?.accepted} mm=${mmView} chained=${sheetChained} />` : null}

    ${allyOpen ? html`<${AllianceSelect} onClose=${() => setAllyOpen(false)} code=${code} onCode=${(v) => setCode(normalizeCode(v))} codeOk=${codeOk}
      recent=${recent} online=${online} maint=${maint} busy=${busy} difficulty=${difficulty}
      onCreate=${create} onJoin=${() => join()} onSpectate=${() => spectate()} />` : null}

    <${HubDialog} open=${joinOpen} micro="JOIN WITH ALLIANCE KEY" title=${t('密钥加入')} onClose=${() => setJoinOpen(false)}>
      <div class="join-row">
        <${TextField} size="code" icon="key" value=${code} placeholder=${t('输入同盟密钥 / 粘贴邀请链接')}
          transform=${normalizeCode} onInput=${(v) => setCode(normalizeCode(v))} onEnter=${() => join()} />
      </div>
      <div class="join-row hub-join__buttons">
        <${Button} variant="amber" size="lg" icon="users" loading=${busy === 'join'} disabled=${!codeOk || !online} onClick=${() => join()}>${t('加入同盟')}<//>
        <${Tooltip} text=${t('以观战者身份进入：不占博士席位，只能观看（每个同盟最多 {MAX_SPECTATORS} 名，模拟进行中也可进入）', { MAX_SPECTATORS })}>
          <${Button} variant="secondary" size="lg" icon="eye" class="join-spectate" loading=${busy === 'spectate'} disabled=${!codeOk || !online} onClick=${spectate}>${t('观战')}<//>
        <//>
      </div>
      ${lanNote && nativeShell ? html`<p class="t-dim">${lanNote}</p>` : null}
      <div class="join-foot">
        ${recent.length ? html`<span class="t-lo">${t('最近的同盟')}</span>
          ${recent.map((c) => html`<button key=${c} type="button" class="code-chip num" title=${t('填入密钥（不会直接加入）')}
            onClick=${() => setCode(c)}>${c}</button>`)}`
          : html`<span class="t-dim">${t('向同伴索取 {ROOM_CODE_LEN} 位同盟密钥，或直接打开邀请链接', { ROOM_CODE_LEN })}</span>`}
      </div>
    <//>

    <${HubDialog} open=${bgOpen} micro="LOBBY BACKDROP" title=${t('大厅背景')} onClose=${() => setBgOpen(false)}>
      <${BackdropSettings} bg=${bg} />
    <//>

    ${achOpen ? html`<${AchievementPanel} me=${me} onClose=${() => setAchOpen(false)} />` : null}
    ${sweepOpen ? html`<${SweepReport} onClose=${() => setSweepOpen(false)} />` : null}
  </div>`;
}
