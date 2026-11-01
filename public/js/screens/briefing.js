// Briefing — INFO_CHECK "1/2 确认本局信息" (research 06 §4.1, D1): enemy leader (silhouette, name,
// abilities), stage (+ its pool: 战场固定 / 战场随机（共N张）), 特训敌人 factions (icon, name, description), the difficulty
// tag, the ready count x/N with person pips, the 准备就绪 button (g.infoReady) and the countdown. The 核心盟约 / 附加盟约
// rows of bond discs (disabled bonds greyed with the banned-member badge), the legend and the 本局禁用干员 avatars, with
// the player's own 自选 pieces out of the shop (m.private.diyBanned), are ui/matchInfo.js MatchBondRow / MatchLegend /
// BannedOperators, the blocks the strategy draft's 本局信息 dialog shows (screens/bandDraft.js). The enemy section is shared too:
// ui/matchEnemies.js MatchEnemies (GitHub #484, DESIGN §35.6).
// 预选盟约 (fork e64a3260): the footer's 预选盟约 entry opens ui/bondPlan.js BondPlanPicker — the core bond (盟约) this
// player announces it means to build (g.bondPlan, display only; changeable from here until round 1's battle). The draft
// order rows (screens/bandDraft.js) and the team panel (ui/teamPanel.js) show every player's plan.
// The event's layout (PR #643, video 6:29–7:51): one scrolling column of sections under grey header bars — 本局遭遇敌方
// (MatchEnemies: the leader's framed portrait over 敌方领袖, its text with the battlefield, the 特训敌人 as round icons
// with their names, the description in a tooltip — the maintainer's decision of 2026-10-22), 核心盟约, 附加盟约 (the legend
// under it), 本局禁用干员 — with 已就绪 x/N over the person pips (已就绪 2/4 as research 06 §4.1 reads it, no colon) and
// the big 准备就绪 in the bottom-right corner. The sections come in from the right one after another
// (css/screens/briefing.css 开局转场).

import { useMemo, useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon } from '../ui/components.js';
import { useGameData } from '../ui/gameComponents.js';
import { StepHeader, ExitModal } from '../ui/matchChrome.js';
import { MatchBondRow, MatchLegend, BannedOperators, matchInfoModel } from '../ui/matchInfo.js';
import { MatchEnemies } from '../ui/matchEnemies.js';
import { LoadoutButton } from './loadout.js';
import { UnofficialMark, VersionTag } from '../ui/pluginTag.js';
import { SetupReroll } from '../ui/setupReroll.js';
import { actions, act } from '../ui/gameActions.js';
import { sortedPlayers, phaseTotalSeconds, modeOffBonds } from '../ui/gameLogic.js';
import { plannableBonds, bondPlanOpen, bondPlanHolders, BondPlanPicker } from '../ui/bondPlan.js';
import { useStore } from '../store.js';
import { data } from '../data.js';
import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/** INFO_CHECK screen. */
export function BriefingScreen() {
  const pub = useStore((s) => s.match.public);
  const priv = useStore((s) => s.match.private);
  const myId = useStore((s) => s.me.playerId);
  const solo = useStore((s) => s.room?.mode === 'solo') || String(pub?.modeId || '').includes('single');
  // gameplay plugins (DESIGN §32.6): the briefing says the match is unofficial
  const room = useStore((s) => s.room);
  const gd = useGameData();
  const [exit, setExit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  // 预选盟约 (fork e64a3260): the plannable bonds (every core faction bond, in data order — the mode's switched-off
  // ones included). Before the early return: a hook, like the useState calls above.
  const planBonds = useMemo(() => plannableBonds(gd.list('bonds')), [gd.ready, data.locale()]);
  if (!pub) return null;

  const players = sortedPlayers(pub);
  const me = players.find((p) => p.playerId === myId);
  const readyN = players.filter((p) => p.ready).length;
  const mode = gd.config?.modes?.[pub.modeId];
  // (+ the own 自选 pieces this match leaves out of the shop: m.private.diyBanned)
  const info = matchInfoModel(pub, { bonds: gd.list('bonds'), chess: gd.chess, mode, priv, diyData: { chess: data.get('chess'), backups: data.get('backups') } });
  // 预选盟约 (fork e64a3260): my plan, the others', and whether it can still change (the server's window; co-op only —
  // in solo nobody else reads it)
  const offBonds = modeOffBonds(mode);
  const myPlan = me?.bondPlan ?? null;
  const canPlan = !solo && !!me && bondPlanOpen(pub);
  const pickPlan = async (bondId) => {
    if (planBusy) return;
    setPlanBusy(true);
    const ok = await act('g.bondPlan', { bondId }, { sfx: 'confirm' });
    setPlanBusy(false);
    if (ok) setPlanOpen(false);
  };

  const ready = async () => {
    if (busy || me?.ready) return;
    setBusy(true);
    await actions.infoReady(pub.setupRevision ?? 0);
    setBusy(false);
  };

  return html`<div class="screen brief">
    <div class="brief__bg" aria-hidden="true"></div>
    <${StepHeader} step=${1} of=${2} title=${t('确认本局信息')} micro="BRIEFING // INFO CHECK" pub=${pub}
      total=${phaseTotalSeconds(pub, gd.config)} onExit=${() => setExit(true)} />
    <${UnofficialMark} room=${room} class="brief__modmark" /><${VersionTag} room=${room} class="brief__vertag" />
    <main class="brief__main">
      <section class="brief-sec brief-sec--enemy" style="--i:1">
        <${MatchEnemies} pub=${pub} gd=${gd} />
      </section>

      <section class="brief-sec brief-sec--core" style="--i:2"><${MatchBondRow} title=${t('核心盟约')} micro="CORE BONDS" bonds=${info.core} model=${info} /></section>
      <section class="brief-sec brief-sec--addon" style="--i:3">
        <${MatchBondRow} title=${t('附加盟约')} micro="ADD-ON BONDS" bonds=${info.addon} model=${info} />
        <${MatchLegend} model=${info} />
      </section>
      <section class="brief-sec brief-sec--banned" style="--i:4"><${BannedOperators} model=${info} /></section>
    </main>
    <${SetupReroll} pub=${pub} />
    <footer class="brief__foot">
      <${LoadoutButton} from="briefing" size="lg" class="brief-loadout" />
      ${canPlan ? html`<${Button} variant="secondary" size="lg" icon="users" class="brief-plan" data-testid="bond-plan-open"
        aria-haspopup="dialog" onClick=${() => setPlanOpen(true)}>${myPlan ? t('预选盟约：{name}', { name: gd.bond(myPlan)?.name || myPlan }) : t('预选盟约')}<//>` : null}
      <div class="brief-ready">
        <span class="brief-ready__txt">${t('已就绪')}<b class="num">${readyN}</b><span class="num">/${players.length}</span></span>
        <span class="brief-ready__pips">${players.map((p) => html`<i key=${p.playerId} class=${cx(p.ready && 'on', p.playerId === myId && 'me')} title=${p.name}><${Icon} name="user" /></i>`)}</span>
      </div>
      <${Button} variant="primary" size="xl" class="brief-go" icon=${me?.ready ? 'check' : me ? 'play' : 'eye'} active=${!!me?.ready} loading=${busy}
        disabled=${!!me?.ready || !me || !!pub.rerollVote} onClick=${ready}>${me?.ready ? t('已就绪') : me ? t('准备就绪') : t('观战中')}<//>
    </footer>
    <${ExitModal} open=${exit} onClose=${() => setExit(false)} solo=${solo} />
    <${BondPlanPicker} open=${planOpen && canPlan} onClose=${() => setPlanOpen(false)} bonds=${planBonds} value=${myPlan}
      holders=${bondPlanHolders(players, myId)} off=${offBonds} busy=${planBusy} onPick=${pickPlan} />
  </div>`;
}
