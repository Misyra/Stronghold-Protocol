// public/js/screens/game/overlays.js — the match-ended plate and the solo pause plate.

import { Button, MicroLabel, html } from '../../ui/components.js';
import { emptyMatch, store } from '../../store.js';
import { localAsset } from '../../data.js';

/** The room went back to its lobby without a result (match aborted): offer the way back. */
export function MatchEnded() {
  return html`<div class="awayov" role="dialog" aria-label="模拟已结束">
    <div class="awayov__box brackets">
      <${MicroLabel} tone="mint">SIMULATION CLOSED</${MicroLabel}>
      <h2>本局模拟已结束</h2>
      <p class="t-lo">同盟已返回等待室</p>
      <${Button} variant="primary" size="lg" icon="chevronLeft" onClick=${() => store.set({ match: emptyMatch() })}>返回同盟<//>
    </div>
  </div>`;
}

/** Solo pause (m.public.paused): the field dims under the 暂停中 plate; 继续作战 resumes (g.pause off). */
export function PausedOverlay({ canResume, busy, onResume, onExit }) {
  const plate = localAsset('ui/battle', 'matte_pause');
  return html`<div class="pauseov" role="dialog" aria-label="暂停中" data-testid="paused">
    <div class="pauseov__box">
      <div class="pauseov__plate" style=${plate ? `--pause-plate:url("${plate}")` : ''}>
        <span class="pauseov__micro">PAUSED</span>
        <h2>暂停中</h2>
      </div>
      <p class="pauseov__note">作战已暂停，计时与敌人行动均已停止</p>
      <div class="pauseov__btns">
        ${onExit ? html`<${Button} variant="secondary" size="lg" icon="exit" onClick=${onExit}>放弃模拟<//>` : null}
        ${canResume ? html`<${Button} variant="primary" size="lg" icon="play" loading=${busy} onClick=${onResume} data-autofocus>继续作战<//>` : null}
      </div>
    </div>
  </div>`;
}
