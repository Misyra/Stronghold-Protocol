// server/match/match/phases.js — Match methods: the round flow up to the prep — INFO_CHECK, the strategy draft
// (BAND_DRAFT: a co-op match with two or more humans — 自由选策略（维护者决定 2026-11-08，移植自用户分支 rel33，
// freeDraft）— has one countdown of BAND_TURN_SECONDS for every seat at once, a tentative choice each can cancel or
// 锁定, and the step ends when every seat has locked or the countdown fixes the choices; solo and a single human keep
// the turns: one countdown of BAND_TURN_SECONDS per turn, 队友已选, the highlighted strategy on a timeout, skips),
// BATTLE_CHECK and ROUND_START (the round's enemies — a normal wave or the boss pairing — planned before the players'
// round start).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, ERR } from '../../../shared/constants.js';
import { buildNormalWave, buildBossWave } from '../waves.js';
import { pairPlayers, bossPairSalt } from '../finalAssault.js';
import { createRng, deriveSeed } from '../../sim/rng.js';
import { OK, fail, DELAYS, BAND_TURN_SECONDS } from './common.js';
import { LEGACY_BOT } from '../botStrategyContract.js';
import { rollEnemyDifficulty } from '../../../shared/enemyDifficulty.js';

export class MatchPhases {
  enterInfoCheck() {
    this.phase = PHASE.INFO_CHECK;
    for (const ps of this.order) if (ps.botControlled) ps.infoReady = true;
    // solo: no time limit (the player confirms); co-op: the official 25 s guard
    this.setDeadline(this.soloUntimed ? 0 : this.gd.timer('infoCheck'), () => this.enterBandDraft());
    this.markPublic();
    for (const ps of this.order) this.markPrivate(ps);
    this.flush(true);
    this.maybeEndInfo();
  }

  maybeEndInfo() {
    if (this.phase !== PHASE.INFO_CHECK || this.setupVote || this._infoAdvanceTimer) return;
    if (this.order.every((p) => p.isBot || p.left || p.infoReady)) {
      this.setDeadline(0);
      this._infoAdvanceTimer = this.later(0, () => {
        this._infoAdvanceTimer = null;
        if (this.phase === PHASE.INFO_CHECK && !this.setupVote) this.enterBandDraft();
      });
    }
  }

  /**
   * The strategy draft (user playtest #4 item 4): in the turn-based draft ONE countdown — every turn has the same clock,
   * BAND_TURN_SECONDS, and m.public.deadline is the current turn's end (= draft.turnDeadline; the step header and the
   * turn indicator show the same number). No separate step cap: the turns bound the step (≤ (seats + skips) × turn). AI
   * seats pick at once. A turn that runs out takes the strategy the player has highlighted (g.bandFocus) while it is
   * free, else the default (timeoutBand). Solo, and any single-human match (soloUntimed): untimed. Solo also keeps seat
   * order and has no skip. A free draft (freeDraft) replaces the turns with one countdown for every seat at once.
   */
  enterBandDraft() {
    if (this.phase !== PHASE.INFO_CHECK) return;
    this.phase = PHASE.BAND_DRAFT;
    // The opening is settled, so no reroll cooldown outlives this phase.
    this._rerollStartAt.clear();
    let order = this.order.map((p) => p.playerId);
    if (!this.isSolo) this.rngDraft.shuffle(order);
    order = this.humansFirst(order);
    // 自由选策略（维护者决定 2026-11-08，移植自用户分支 rel33）: every ≥2-human co-op room drafts freely — the expanded
    // rooms' concurrent draft (concurrentDraft) gains holds/locks on top (fork 终态 free+concurrent+allowRepeat)
    const free = this.freeDraft();
    const concurrent = this.concurrentDraft() || free;
    const skips = this.isSolo || concurrent ? 0 : this.gd.bandDraft.skipsPerPlayer;
    const untimed = this.soloUntimed;
    this.draft = {
      order, idx: 0, picks: {}, skipsLeft: Object.fromEntries(order.map((pid) => [pid, skips])), untimed, turnDeadline: 0,
      /** playerId → the strategy highlighted in the draft screen (g.bandFocus) */
      focus: new Map(),
      ...(concurrent ? { concurrent: true } : {}),
      // 自由选策略: `picks` are the locked (final) choices, `holds` the tentative ones (playerId → bandId)
      ...(free ? { free: true, holds: {} } : {}),
    };
    this.setDeadline(0);
    this.startDraftTurn();
    this.markPublic();
  }

  /**
   * Whether this match's drafts — the strategy draft and 机变 — are made by every seat at once (`draft.concurrent` /
   * `sp.concurrent`): the expanded-capacity rooms (移植自用户分支，concurrentDraft), where repeats are allowed and a
   * pick takes nothing from another seat but equipment stock. One countdown for the whole step (strategy:
   * BAND_TURN_SECONDS, 机变: spFirst); whoever is still deciding when it runs out gets what a turn that runs out
   * gives; no skip; AI seats pick at once — with 「AI 队友最后选择」 once no human is still deciding (_botMayPick).
   * The step ends as soon as nobody is left to decide. Ordinary rooms keep the turns.
   */
  concurrentDraft() { return !!this.capacityExperiment && !this.isSolo; }

  /**
   * 自由选策略（维护者决定 2026-11-08，移植自用户分支 rel33; the owner's strategy draft of 2026-11-05 「改成额定倒计时，
   * 玩家可以同时自由选择策略，选择完成之后还可以取消选别的策略。倒计时结束则固定所选择的策略」）: every co-op match that
   * is not untimed — two or more humans — drafts concurrently (`draft.free`, on top of `draft.concurrent`) with ONE
   * countdown of BAND_TURN_SECONDS for the step. A seat holds a strategy (g.bandHold; `draft.holds`), may switch it or
   * cancel it (g.bandCancel) and 锁定 it (g.bandLock) — the lock is final (`draft.picks`); g.band locks at once (a page
   * that predates the flow). A held strategy is 队友已选 for the others (bandTaken) unless the room allows repeats
   * (capacityExperiment / bandDupes). The step ends once every seat has locked; when the countdown runs out every hold
   * is fixed, and a human holding nothing gets timeoutBand. AI seats lock at once — with 「AI 队友最后选择」 once no
   * human is left deciding (_botMayPick), the countdown's end included. Solo and a single human (soloUntimed) keep the
   * turns.
   */
  freeDraft() { return !this.isSolo && !this.soloUntimed; }

  /** 「AI 队友最后选择」 in a concurrent draft: an AI seat picks once none of `deciding` is a human. */
  _botMayPick(ps, deciding) { return !this.aiPicksLast || !ps.isBot || !deciding.some((p) => p && !p.isBot); }

  /**
   * The co-op room option 「AI 队友最后选择」 (this.aiPicksLast, GitHub #338): every human seat before every AI seat, each
   * group in the order the draft drew (a stable partition applied AFTER the shuffle — no extra random draw: the order
   * with the option off is unchanged, and with it on every random stream stands where it would without it; only the
   * picks made in the new order can differ). A human is any seat that is not an AI seat (room.addBot): under AI 托管,
   * disconnected or departed it still counts as a human. Used by the strategy draft and the 机变 draft
   * (MatchSpDraft.enterSpDraft).
   * @param {string[]} order playerIds in drawn order
   * @returns {string[]}
   */
  humansFirst(order) {
    if (!this.aiPicksLast) return order;
    const bot = (pid) => !!this.players.get(pid)?.isBot;
    return [...order.filter((pid) => !bot(pid)), ...order.filter(bot)];
  }

  draftTurn() {
    const d = this.draft;
    if (!d || d.concurrent) return null;
    return d.order[d.idx] ?? null;
  }

  /** Real ms of one strategy-draft turn (BAND_TURN_SECONDS × timerScale). */
  bandTurnMs() { return this.scaled(BAND_TURN_SECONDS * 1000); }

  startDraftTurn() {
    const d = this.draft;
    if (d.concurrent) { this._concurrentBandStep(); return; }
    this.cancel(this._turnTimer);
    this._turnTimer = null;
    if (this.test) this.setDeadline(0);
    while (d.idx < d.order.length && d.picks[d.order[d.idx]]) d.idx++; // loop-cap: draft order
    if (d.idx >= d.order.length) {
      d.turnDeadline = 0;
      this.deadline = 0;
      this.later(0, () => this.finishBandDraft(false));
      return;
    }
    const token = ++this._turnToken;
    if (!d.untimed) {
      const ms = this.bandTurnMs();
      d.turnDeadline = this.sched.now() + ms;
      // the step's countdown IS the turn's (one number everywhere)
      this.deadline = d.turnDeadline;
      const expire = () => {
        if (this.phase !== PHASE.BAND_DRAFT || token !== this._turnToken) return;
        const pid = this.draftTurn();
        if (pid) this._applyBand(this.players.get(pid), this.timeoutBand(pid));
      };
      if (this.test) { this.setDeadline(ms / 1000 / (this.timerScale || 1), expire); d.turnDeadline = this.deadline; }
      else this._turnTimer = this.later(ms, expire);
    } else {
      d.turnDeadline = 0;
      this.deadline = 0;
    }
    const cur = this.players.get(this.draftTurn());
    if (cur && cur.botControlled) this.scheduleBandBot();
    this.markPublic();
  }

  /**
   * A concurrent strategy draft (concurrentDraft) at its start and after each pick: ends once every seat has picked;
   * else arms the step's one countdown (the first time) and lets every AI / AI 托管 seat still deciding pick.
   */
  _concurrentBandStep() {
    const d = this.draft;
    if (d.done) return;
    if (d.order.every((pid) => d.picks[pid])) {
      d.done = true;
      this.cancel(this._turnTimer);
      this._turnTimer = null;
      // 自由选策略: its countdown is the phase timer in a test match (startDraftTurn's setDeadline) — release it
      if (this.test && d.free) this.setDeadline(0);
      d.turnDeadline = 0;
      this.deadline = 0;
      this.later(0, () => this.finishBandDraft(false));
      this.markPublic();
      return;
    }
    if (!d.armed) {
      d.armed = true;
      const token = ++this._turnToken;
      if (!d.untimed) {
        const ms = this.bandTurnMs();
        const expire = () => {
          if (this.phase !== PHASE.BAND_DRAFT || token !== this._turnToken || this.draft !== d) return;
          // 自由选策略: the countdown fixes every hold first, then the still-deciding humans get timeoutBand
          if (d.free) { this._fixFreeDraft(d); return; }
          // whoever is still deciding: the highlighted strategy, else the default (timeoutBand), in draft order
          for (const pid of d.order) if (!d.picks[pid] && this.players.get(pid)) this._applyBand(this.players.get(pid), this.timeoutBand(pid));
        };
        d.turnDeadline = this.sched.now() + ms;
        this.deadline = d.turnDeadline;
        // 自由选策略: a test match's timers can be held (g.test timers off), as a turn's are (startDraftTurn)
        if (this.test && d.free) { this.setDeadline(ms / 1000 / (this.timerScale || 1), expire); d.turnDeadline = this.deadline; }
        else this._turnTimer = this.later(ms, expire);
      } else {
        d.turnDeadline = 0;
        this.deadline = 0;
      }
    }
    const deciding = d.order.filter((pid) => !d.picks[pid]).map((pid) => this.players.get(pid));
    for (const ps of deciding) if (ps && ps.botControlled && this._botMayPick(ps, deciding)) this.scheduleBandBot(ps);
    this.markPublic();
  }

  /**
   * 自由选策略: the countdown ran out — every hold is fixed, then every human still deciding (held nothing; offline
   * included) gets timeoutBand — its highlighted strategy while free, else the default — in draft order (the holds
   * first, so no default takes a held strategy). A dev manual seat (externalAI manualWait) joins the humans: its
   * expired window is left to the phase timer as for a human (externalAI.manualFail — no bot fallback; the turn-based
   * draft's expire never had an isBot distinction). The AI seats still deciding (「AI 队友最后选择」) pick next: no
   * human is left deciding (_concurrentBandStep, through the last _applyBand).
   * @param {any} d this.draft
   */
  _fixFreeDraft(d) {
    const holds = d.holds || {};
    for (const pid of d.order) {
      const ps = this.players.get(pid), id = holds[pid];
      if (ps && !d.picks[pid] && typeof id === 'string' && this.gd.bandAllowed(id) && !this.bandTaken(id, pid)) this._applyBand(ps, id);
    }
    for (const pid of d.order) {
      const ps = this.players.get(pid);
      if (ps && !d.picks[pid] && (!ps.isBot || this._manualBandSeat(ps))) this._applyBand(ps, this.timeoutBand(pid));
    }
    if (!d.done) this._concurrentBandStep();
  }

  /**
   * A dev manual seat (externalAI manualWait): its expired window is left to the phase timer as for a human, so the
   * free draft's countdown picks for it like for a human. The external strategy is the only one with a decide hook
   * (botStrategies.js), so the seat's bot identifies it; a release has no external host (externalAI absent).
   * @param {any} ps
   */
  _manualBandSeat(ps) {
    return !!this.externalAI?.config?.manualWait && typeof this.botFor(ps)?.decide === 'function';
  }

  /** 自由选策略: the hold of `ps` while it can still be locked (allowed, nobody else holds it), else null. */
  heldBand(ps) {
    const d = this.draft;
    const id = d?.free && ps ? d.holds?.[ps.playerId] : null;
    return typeof id === 'string' && this.gd.bandAllowed(id) && !this.bandTaken(id, ps.playerId) ? id : null;
  }

  /**
   * An AI seat's (or an AI 托管 seat's) turn: it picks at once (user playtest #4 item 4 — nobody waits on the AI). A
   * concurrent draft names the seat (`target`; once per seat while one is queued).
   */
  scheduleBandBot(target = null) {
    const token = this._turnToken;
    const d = this.draft;
    if (d?.concurrent) {
      if (!target || d.botQueued?.has(target.playerId)) return;
      (d.botQueued ||= new Set()).add(target.playerId);
    }
    this.later(0, () => {
      if (d?.concurrent) d.botQueued.delete(target.playerId);
      if (this.phase !== PHASE.BAND_DRAFT || token !== this._turnToken || this.draft !== d) return;
      const ps = d.concurrent ? target : this.players.get(this.draftTurn());
      if (!ps || !ps.botControlled || d.picks[ps.playerId]) return;
      // 自由选策略: a human under AI 托管 (or gone) locks the strategy it held
      const held = this.heldBand(ps);
      if (held) { this._applyBand(ps, held); return; }
      // a co-op seat gone before its pick has no game of its own to play: whatever strategy plays the AI seats, it drafts
      // by the team's rule (botPickBand's departedWeight: Touch while nobody else holds it, never 歌利亚; stardust 6dc796d1)
      const bot = !this.isSolo && ps.alive === false ? LEGACY_BOT : this.botFor(ps);
      // an AI seat the room designated a strategy for (room.setBotBand, 移植自用户分支) takes it — held for it, so still free
      const own = this.designatedBand(ps);
      if (own) { this._applyBand(ps, own, { dedupe: true }); return; }
      const fallback = () => {
        // a strategy a teammate already took is not selectable (队友已选): the bot re-draws, else the first free one
        let id = bot.pickBand(this, ps);
        for (let k = 0; k < 8 && this.bandTaken(id, ps.playerId); k++) id = bot.pickBand(this, ps);
        if (this.bandTaken(id, ps.playerId)) id = this.gd.bandIds().find((b) => !this.bandTaken(b, ps.playerId)) || id;
        this._applyBand(ps, id, { dedupe: true });
      };
      if (bot.decide?.(this, ps, { kind: 'band',
        valid: () => this.phase === PHASE.BAND_DRAFT && token === this._turnToken,
        complete: () => token !== this._turnToken || !!this.draft?.picks[ps.playerId], fallback })) return;
      fallback();
    });
  }

  /**
   * Whether `bandId` was already picked by another player of this draft. Research 09 §5 / DESIGN §14 corrections:
   * the strategy draft marks a teammate's pick as 队友已选 and it cannot be chosen again (co-op). The automatic
   * assignments — a turn that runs out, the AI's pick (also for a departed seat, scheduleBandBot) — obey the same rule:
   * see timeoutBand / defaultBand.
   * 「允许重复策略」 (bandDupes, 本仓新设) stands the guard down; a strategy the room designated for an AI seat
   * (room.setBotBand, 移植自用户分支) counts as taken for everybody else until that seat picks it.
   * 扩编房间（capacityExperiment）同样 repeats：一个策略可以多人同持（移植自用户分支 bandTaken），无 reserved。
   */
  bandTaken(bandId, playerId) {
    if (this.bandDupes || this.capacityExperiment) return false;
    const picks = this.draft?.picks || {};
    for (const [pid, id] of Object.entries(picks)) if (pid !== playerId && id === bandId) return true;
    // 自由选策略: a teammate's tentative choice too (first come, first served — 移植自用户分支 rel33)
    if (this.draft?.free) for (const [pid, id] of Object.entries(this.draft.holds || {})) if (pid !== playerId && id === bandId && !picks[pid]) return true;
    for (const [pid, id] of this.botBands || []) if (pid !== playerId && id === bandId && !picks[pid]) return true;
    return false;
  }

  /**
   * The designated strategies still held (room.setBotBand, 移植自用户分支): bandId → the AI seat's playerId, for every AI
   * seat that has not picked yet; {} when the room designated nothing. m.public draft.reserved.
   * 扩编房间（capacityExperiment） repeats：无人占座，恒为 {}（移植自用户分支 reservedBands）。
   * @returns {Record<string, string>}
   */
  reservedBands() {
    const out = {};
    if (this.capacityExperiment) return out;
    const picks = this.draft?.picks || {};
    for (const [pid, id] of this.botBands || []) if (!picks[pid]) out[id] = pid;
    return out;
  }

  /**
   * The strategy the room designated for this AI seat (room.setBotBand, 移植自用户分支) while it can take it — allowed by
   * the mode and held by nobody else —, else null (the seat picks as without the option).
   * @param {any} ps
   * @returns {string | null}
   */
  designatedBand(ps) {
    const id = ps && this.botBands?.get(ps.playerId);
    return id && this.gd.bandAllowed(id) && !this.bandTaken(id, ps.playerId) ? id : null;
  }

  /**
   * The strategy an automatic assignment gives `playerId` (a timed-out turn without a usable highlight, timeoutBand; a
   * seat still to pick when finishBandDraft ends the draft): the official default 「华法琳」 (bandDraft.timeoutBandId)
   * while no teammate holds it, else the first strategy of the mode (sortId order, gd.bandIds) that nobody else picked —
   * never a duplicate (队友已选; the client shows the same choice: public/js/screens/bandDraft.js timeoutBand). Solo drafts
   * have no teammates, so it is always the default.
   * @param {string} playerId
   */
  defaultBand(playerId) {
    const def = this.gd.bandDraft.timeoutBandId;
    // 华法琳禁用（disableDuckLord，容量房间）：默认策略被禁时取第一个可用的（移植自用户分支 defaultBand；
    // gamedata.bandAllowed/bandDraft 的禁用规则由其归属模块落地）
    if (!this.bandTaken(def, playerId) && (!this.disableDuckLord || this.gd.bandAllowed(def))) return def;
    return this.gd.bandIds().find((b) => !this.bandTaken(b, playerId)) || (this.disableDuckLord ? this.gd.defaultBandId : def);
  }

  /**
   * What a turn that runs out assigns (user playtest #4 item 4): the strategy the player has highlighted in the draft
   * screen (g.bandFocus — the detail pane's band, the one 确认选择 would take) while it is allowed and no teammate holds
   * it, else defaultBand.
   * @param {string} playerId
   */
  timeoutBand(playerId) {
    const f = this.draft && this.draft.focus instanceof Map ? this.draft.focus.get(playerId) : null;
    if (typeof f === 'string' && this.gd.bandAllowed(f) && !this.bandTaken(f, playerId)) return f;
    return this.defaultBand(playerId);
  }

  /**
   * g.bandFocus { bandId? }: the strategy the player highlights in the draft screen (any time before its pick; also
   * while waiting for its turn). A missing / null bandId clears it. Only a timed-out turn reads it (timeoutBand).
   */
  bandFocus(ps, bandId) {
    if (this.phase !== PHASE.BAND_DRAFT || !this.draft) return fail(ERR.WRONG_PHASE);
    const d = this.draft;
    if (d.picks[ps.playerId]) return fail(ERR.ALREADY);
    if (!(d.focus instanceof Map)) d.focus = new Map();
    if (bandId == null) { d.focus.delete(ps.playerId); return OK; }
    if (typeof bandId !== 'string' || !this.gd.bandAllowed(bandId)) return fail(ERR.BAD_TARGET);
    d.focus.set(ps.playerId, bandId);
    return OK;
  }

  /** g.band: the final pick — a turn's; in a free draft (自由选策略) hold + 锁定 at once (a page that predates g.bandLock). */
  pickBand(ps, bandId) {
    if (this.phase !== PHASE.BAND_DRAFT || !this.draft) return fail(ERR.WRONG_PHASE);
    if (this.draft.picks[ps.playerId]) return fail(ERR.ALREADY);
    // 并发草稿没有回合（concurrentDraft）：任何仍在决定的席位随时可锁（移植自用户分支 pickBand）
    if (!this.draft.concurrent && this.draftTurn() !== ps.playerId) return fail(ERR.NOT_YOUR_TURN);
    if (this.draft.free && !this.draft.order.includes(ps.playerId)) return fail(ERR.BAD_TARGET);
    if (typeof bandId !== 'string' || !this.gd.bandAllowed(bandId)) return fail(ERR.BAD_TARGET);
    if (this.bandTaken(bandId, ps.playerId)) return fail(ERR.BAD_TARGET, '队友已选'); // i18n-ignore: developer detail (players see ERR_TEXT)
    this._applyBand(ps, bandId);
    return OK;
  }

  /**
   * g.bandHold { bandId } (自由选策略，维护者决定 2026-11-08，移植自用户分支 rel33): the seat's tentative choice — a new one
   * replaces the old (the old is free again at once); refused once locked, for a strategy a teammate holds or locked
   * (队友已选) and outside a free draft. It is also the highlighted strategy (g.bandFocus).
   */
  holdBand(ps, bandId) {
    const d = this.draft;
    if (this.phase !== PHASE.BAND_DRAFT || !d) return fail(ERR.WRONG_PHASE);
    if (!d.free) return fail(ERR.WRONG_PHASE, 'not a free draft');
    if (!d.order.includes(ps.playerId)) return fail(ERR.BAD_TARGET);
    if (d.picks[ps.playerId]) return fail(ERR.ALREADY);
    if (typeof bandId !== 'string' || !this.gd.bandAllowed(bandId)) return fail(ERR.BAD_TARGET);
    if (this.bandTaken(bandId, ps.playerId)) return fail(ERR.BAD_TARGET, '队友已选'); // i18n-ignore: developer detail (players see ERR_TEXT)
    if (d.holds?.[ps.playerId] === bandId) return OK;
    (d.holds ||= {})[ps.playerId] = bandId;
    if (!(d.focus instanceof Map)) d.focus = new Map();
    d.focus.set(ps.playerId, bandId);
    this.markPublic();
    return OK;
  }

  /** g.bandCancel (自由选策略): drop the tentative choice — the strategy is free again; nothing held is no error. */
  cancelBand(ps) {
    const d = this.draft;
    if (this.phase !== PHASE.BAND_DRAFT || !d) return fail(ERR.WRONG_PHASE);
    if (!d.free) return fail(ERR.WRONG_PHASE, 'not a free draft');
    if (d.picks[ps.playerId]) return fail(ERR.ALREADY);
    if (d.holds && d.holds[ps.playerId] != null) {
      delete d.holds[ps.playerId];
      this.markPublic();
    }
    return OK;
  }

  /**
   * g.bandLock (自由选策略): 锁定 the tentative choice — final (draft.picks, the seat's strategy and LP); the step ends
   * once every seat has locked (_concurrentBandStep). Refused without a hold.
   */
  lockBand(ps) {
    const d = this.draft;
    if (this.phase !== PHASE.BAND_DRAFT || !d) return fail(ERR.WRONG_PHASE);
    if (!d.free) return fail(ERR.WRONG_PHASE, 'not a free draft');
    if (d.picks[ps.playerId]) return fail(ERR.ALREADY);
    const id = d.holds?.[ps.playerId];
    if (typeof id !== 'string') return fail(ERR.BAD_TARGET, 'nothing held');
    if (!this.gd.bandAllowed(id) || this.bandTaken(id, ps.playerId)) return fail(ERR.BAD_TARGET, '队友已选'); // i18n-ignore: developer detail (players see ERR_TEXT)
    this._applyBand(ps, id);
    return OK;
  }

  _applyBand(ps, bandId, { dedupe = false } = {}) {
    const d = this.draft;
    if (!d || !ps || d.picks[ps.playerId]) return;
    let id = this.gd.bandAllowed(bandId) ? bandId : this.defaultBand(ps.playerId);
    if (dedupe && this.bandTaken(id, ps.playerId)) id = this.gd.bandIds().find((b) => !this.bandTaken(b, ps.playerId)) || id;
    if (d.holds) delete d.holds[ps.playerId]; // 自由选策略: a locked seat is never in holds
    d.picks[ps.playerId] = id;
    ps.bandId = id;
    // the strategy's starting LP is a living seat's: one gone before its pick (its turn is the AI's) keeps the 0 it left
    // with (_quit), in m.public and the result as well (stardust 78f1e0ec)
    if (ps.alive) ps.lp = this.gd.startLp(id);
    this.markPrivate(ps);
    this.markPublic();
    this.startDraftTurn();
  }

  skipBand(ps) {
    if (this.phase !== PHASE.BAND_DRAFT || !this.draft) return fail(ERR.WRONG_PHASE);
    const d = this.draft;
    if (this.isSolo) return fail(ERR.WRONG_PHASE, 'no skip in solo');
    if (d.concurrent) return fail(ERR.WRONG_PHASE, 'no skip when everybody picks at once');
    if (d.picks[ps.playerId]) return fail(ERR.ALREADY);
    if (this.draftTurn() !== ps.playerId) return fail(ERR.NOT_YOUR_TURN);
    if (!(d.skipsLeft[ps.playerId] > 0)) return fail(ERR.ALREADY, 'no skip left');
    if (d.order.length - d.idx <= 1) return fail(ERR.BAD_TARGET, 'nobody to pass to');
    d.skipsLeft[ps.playerId]--;
    d.order.splice(d.idx, 1);
    // the skipper goes to the end; with 「AI 队友最后选择」 to the end of the humans still to pick — behind them, ahead of
    // the AI seats — and to the very end only when no other human is left to pass to [ASSUMED: the option's intent,
    // humans before AI, kept through a skip; no source, a remake option]
    let at = d.order.length;
    if (this.aiPicksLast) {
      for (let j = d.order.length - 1; j >= d.idx; j--) {
        if (!this.players.get(d.order[j])?.isBot) { at = j + 1; break; }
      }
    }
    d.order.splice(at, 0, ps.playerId);
    this.startDraftTurn();
    return OK;
  }

  finishBandDraft(timeout) {
    if (this.phase !== PHASE.BAND_DRAFT) return;
    this.cancel(this._turnTimer);
    this._turnTimer = null;
    for (const ps of this.order) {
      if (!this.draft.picks[ps.playerId]) {
        // one after another in seat order, so each default sees the ones assigned before it (no duplicates)
        const id = this.defaultBand(ps.playerId);
        this.draft.picks[ps.playerId] = id;
        ps.bandId = id;
        if (ps.alive) ps.lp = this.gd.startLp(id); // a seat gone before its pick keeps its 0 (_applyBand)
      }
      this.markPrivate(ps);
    }
    void timeout;
    this.enterBattleCheck();
  }

  enterBattleCheck() {
    this.phase = PHASE.BATTLE_CHECK;
    this.setDeadline(this.gd.timer('battleCheck'), () => this.afterBattleCheck(), { silent: this.soloUntimed });
    this.markPublic();
  }

  /**
   * BATTLE_CHECK is over: R1 is about to begin. A plugin window declared at `battleCheck` for this round opens here —
   * "before the round begins", the host's own step first (docs/PLUGINS.md §10b) — and holds R1 back until it closes; a
   * content set without a window continues exactly as before (`openOfferWindow` returns before it touches anything).
   */
  afterBattleCheck() {
    this.startRound(1);
  }

  startRound(r, afterStart = null) {
    // Every round, including boss rounds. [ASSUMED] Expire nonblocking windows at the next round.
    for (const w of this.offerWin) this._closeOffer(w);
    this.offersDispose(); // A test-console round jump must discard the older continuation too.
    const step = () => { this._startRoundAfterOffers(r); afterStart?.(); };
    if (this.openOfferWindow('battleCheck', r) !== 'open') { step(); return; }
    this._offerResume = step;
  }

  _startRoundAfterOffers(r) {
    this.phase = PHASE.ROUND_START;
    this.round = r;
    this.fields = [];
    this.watchers.clear();
    this.unitePlan = null;
    // 容量联防接力跨轮状态随本轮清零（combat.js 在战斗开始时写入实际存活数）
    this._normalAliveCount = 0;
    this._uniteRelay = null;
    this.uniteResultView = null;
    this.sp = null;
    this.wave = null;
    this.bossWaves = null;
    this.bossPairsRound = null;
    const alive = this.alivePlayers();
    // the round's enemies (shared composition, generated now so the prep preview is exact). Planned BEFORE the players'
    // round start: its recompute() checks the board on the field the player deploys on this round (deployFieldOf reads
    // the boss pairing), so R14 → R15 never re-checks a boss-field board against the normal field (user playtest #5
    // item 7). rngWaves is used only here, so the order leaves every random stream unchanged.
    const isBoss = r === this.gd.bossRound || r === this.gd.hiddenRound;
    if (this.gd.mode.enemyDifficulty) {
      this.enemyDifficultyHistory ??= [];
      const plan = this.enemyDifficultyHistory.find(p => p.round === r) ?? rollEnemyDifficulty(this.gd.mode.enemyDifficulty,
        createRng(deriveSeed(this.seed, `enemyDifficulty:${r}`)), { round: r, boss: isBoss });
      this.gd.roundDifficulty = plan;
      if (plan && !this.enemyDifficultyHistory.some(p => p.round === r)) this.enemyDifficultyHistory.push(plan);
    }
    if (isBoss) {
      this._planBossWaves();
    } else {
      this.wave = buildNormalWave(this.gd, this.rngWaves, this.factions, r);
    }
    for (const ps of alive) ps.startRound(r);
    for (const ps of alive) this.dispatch(ps, 'onRoundStart', { round: r });
    // an eliminated player's pending 信标 gift still goes to its teammate (effects flagged afterElimination; GitHub #86)
    for (const ps of this.order) {
      if (ps.alive) continue;
      try { this.dispatcher.dispatchEliminated(ps, 'onRoundStart', { round: r }); } catch (e) { this.reportError('dispatch onRoundStart (eliminated)', e); }
    }
    for (const ps of alive) ps.recompute();
    this.setDeadline(DELAYS.ROUND_START / 1000, () => this.afterRoundStart(), { silent: this.soloUntimed });
    this.markPublic();
    // eliminated humans and spectator seats scout the board of the player they follow through the round's prep, not
    // their own empty board (community report of 2026-10-06, item 56; MatchWatch._followScout)
    for (const ps of this._viewers()) this._followScout(ps);
  }

  /** The round's pairs and their templates, generated before the prep preview / board validation. */
  _planBossWaves() {
    const r = this.round;
    const hidden = r === this.gd.hiddenRound && r !== this.gd.bossRound;
    const bossId = hidden ? this.hiddenBossId : this.bossId;
    // Pairing uses an independent seeded draw, consuming no shop, wave, draft or battle randomness. The Hidden Core
    // draws its pairs and sides anew (GitHub #845: the official R15 of BV1VCXyBjEN1 p1 pairs 1-2 / 3-4 after an R14 of
    // 1-4 / 2-3; DESIGN §35.27, superseding §30.12's kept partners) from a stream of its own, so the Final Assault's
    // draw is unchanged; a player who changes half keeps the board (bossFieldPlacement mirrors it, the halves' deploy
    // maps are identical). Only the round's first plan draws anew: a re-plan after a departure in its round start, 机变
    // draft or prep (platform.js _quit) keeps the intact pairs and re-pairs the orphan, as the Final Assault does.
    const fresh = hidden && this.bossPairsRound !== r;
    const groups = pairPlayers(this.alivePlayers(), createRng(deriveSeed(this.seed, bossPairSalt(this.gd, r))), fresh ? null : this.bossPairs);
    this.bossPairs = groups.map(g => g.map(p => p.playerId));
    this.bossPairsRound = r;
    this.bossWaves = groups.map((g) => ({
      players: g.map((p) => p.playerId),
      wave: buildBossWave(this.gd, this.rngWaves, this.factions, r, { bossId, solo: this.isSolo || g.length === 1 }),
    }));
  }

  afterRoundStart() {
    if (this.gd.spRounds().includes(this.round)) this.enterSpDraft();
    else this.beforePrepOffers();
  }

  beforePrepOffers() {
    // The official round start and its draw/draft finish first; only entering prep waits.
    this.sp = null;
    const step = () => this.enterPrep();
    if (this.openOfferWindow('prep', this.round) !== 'open') { step(); return; }
    this._offerResume = step;
  }
}
