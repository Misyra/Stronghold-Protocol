// server/match/match/spDraft.js — Match methods: the 机变 draft (SP_DRAFT: turn order, timers, AI picks, the card applied
// by choices.js applyCard), the personal bounty choice of the Art 教鞭 (offerBountyChoice / pickPersonalChoice /
// autoPickPersonalChoice: held by the player inside PREP — no phase, no timer of its own) and the rolls the meta effects
// ask for — bounties (addBounty), item ids (rollItemId) and choices.json pools (rollPool).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, ERR } from '../../../shared/constants.js';
import { generateDraft, applyCard, bountyBattles, isMultiRoundBounty, bountyCard } from '../choices.js';
import { onPickCard } from '../botEmotes.js';
import { weightedPick } from '../waves.js';
import { OK, fail, DELAYS } from './common.js';

/** Cards of the personal choice (PRTS 卫戍协议：盟约 下半 §法术 教鞭: "于3个战术特训的悬赏任务中选择一项"). */
const PERSONAL_OFFER_SIZE = 3;

export class MatchSpDraft {
  enterSpDraft() {
    const draft = generateDraft(this.gd, this.rngDraft, this.round, { stageId: this.stageId,
      bondAvailable: (bondId) => this.bondLive(bondId), itemAvailable: id => this.spItemAvailable(id) });
    const alive = this.alivePlayers();
    if (!draft || !alive.length) { this.beforePrepOffers(); return; }
    this.phase = PHASE.SP_DRAFT;
    let order = alive.map((p) => p.playerId);
    if (!this.isSolo) this.rngDraft.shuffle(order);
    // 「AI 队友最后选择」 (GitHub #338): humans before AI seats, after the same shuffle (MatchPhases.humansFirst)
    order = this.humansFirst(order);
    // untimed: solo and any single-human match (soloUntimed); the co-op order / 6 cards stay
    const untimed = this.soloUntimed;
    // an expanded-capacity room: every seat picks at once (MatchPhases.concurrentDraft, 移植自用户分支)
    const concurrent = this.concurrentDraft();
    this.sp = { ...draft, order, idx: 0, picks: {}, taken: {}, untimed, turnDeadline: 0, ...(concurrent ? { concurrent: true } : {}) };
    this.setDeadline(0);
    this.startSpTurn();
    this.markPublic();
  }

  /** The seat whose turn it is; null in a concurrent draft (MatchPhases.concurrentDraft). */
  spTurn() {
    const s = this.sp;
    if (!s || s.concurrent) return null;
    return s.order[s.idx] ?? null;
  }

  /** Whether `ps` still has its 机变 pick to make: alive, no card yet, and one of the cards is available to it. */
  spPending(ps) {
    const s = this.sp;
    return !!s && !!ps && ps.alive && s.picks[ps.playerId] == null && s.cards.some((c) => this.spCardAvailable(c, ps));
  }

  /**
   * `player`: the seat about to pick (default: the one whose turn it is) — an item card checks that seat's stock
   * （容量房间：其卡池组的装备库存）；扩编房间 repeats，taken 不再挡别的席位（移植自用户分支 spCardAvailable）。
   */
  spCardAvailable(card, player = this.spTurn()) {
    return !!card && (this.capacityExperiment || this.sp?.taken[card.idx] == null)
      && (card.kind !== 'item' || this.spItemAvailable(card.id, player));
  }

  /**
   * Whether an item card can still be taken: from `player`'s equipment stock (Match itemPoolFor), or — no picker: the
   * draw itself, the public view after the last turn — from the stock of any alive seat (one group: the match's stock).
   */
  spItemAvailable(id, player = null) {
    if (player) return this.itemPoolFor(player).canGain(id);
    return this.alivePlayers().some((p) => this.itemPoolFor(p).canGain(id));
  }

  startSpTurn() {
    const s = this.sp;
    if (s.concurrent) { this._concurrentSpStep(); return; }
    this.cancel(this._turnTimer);
    this._turnTimer = null;
    // a seat whose equipment stock holds none of the cards is passed over (an experimental room's other groups may
    // still pick; in a one-stock match nobody after it can, so the draft ends as before)
    while (s.idx < s.order.length) { // loop-cap: draft order
      const ps = this.players.get(s.order[s.idx]);
      if (ps && ps.alive && s.picks[ps.playerId] == null && s.cards.some(c => this.spCardAvailable(c, ps))) break;
      s.idx++;
    }
    const available = s.cards.filter(c => this.spCardAvailable(c)).map(c => c.idx);
    if (s.idx >= s.order.length || !available.length) { this.setDeadline(0); this.later(0, () => this.finishSpDraft()); return; }
    const token = ++this._turnToken;
    if (!s.untimed) {
      const first = s.idx === 0;
      const secs = this.isSolo && this.gd.config.version?.rules?.soloTimed ? 150 : first ? this.gd.timer('spFirst') : this.gd.timer('spTurn');
      this.setDeadline(secs, () => {
        if (this.phase !== PHASE.SP_DRAFT || token !== this._turnToken) return;
        const ps = this.players.get(this.spTurn());
        if (!ps) return;
        const avail = s.cards.filter(c => this.spCardAvailable(c)).map(c => c.idx);
        if (!avail.length) { this.finishSpDraft(); return; }
        this._applyCard(ps, avail[Math.floor(this.rngDraft() * avail.length)]);
      });
      s.turnDeadline = this.deadline;
    } else {
      this.setDeadline(0);
    }
    const cur = this.players.get(this.spTurn());
    if (cur && cur.botControlled) this.scheduleSpBot();
    this.markPublic();
  }

  /**
   * A concurrent 机变 draft (MatchPhases.concurrentDraft) at its start and after each pick: ends once nobody has a pick
   * left to make (spPending); else arms the step's one countdown (spFirst, the first time) and lets every AI / AI 托管
   * seat still deciding pick. A countdown that runs out gives each seat still deciding one of the cards it can take at
   * random, in draft order — like a turn that runs out.
   */
  _concurrentSpStep() {
    const s = this.sp;
    if (s.done) return;
    const deciding = s.order.map((pid) => this.players.get(pid)).filter((ps) => this.spPending(ps));
    if (!deciding.length) {
      s.done = true;
      s.turnDeadline = 0;
      this.setDeadline(0);
      this.later(0, () => this.finishSpDraft());
      this.markPublic();
      return;
    }
    if (!s.armed) {
      s.armed = true;
      const token = ++this._turnToken;
      if (!s.untimed) {
        this.setDeadline(this.gd.timer('spFirst'), () => {
          if (this.phase !== PHASE.SP_DRAFT || token !== this._turnToken || this.sp !== s) return;
          for (const pid of s.order) {
            const ps = this.players.get(pid);
            if (!this.spPending(ps)) continue;
            const avail = s.cards.filter((c) => this.spCardAvailable(c, ps)).map((c) => c.idx);
            this._applyCard(ps, avail[Math.floor(this.rngDraft() * avail.length)]);
          }
          this._concurrentSpStep();
        });
        s.turnDeadline = this.deadline;
      } else {
        this.setDeadline(0);
      }
    }
    for (const ps of deciding) if (ps.botControlled && this._botMayPick(ps, deciding)) this.scheduleSpBot(ps);
    this.markPublic();
  }

  /** An AI / AI 托管 seat's pick after DELAYS.BOT_ACTION. A concurrent draft names the seat (`target`; once while queued). */
  scheduleSpBot(target = null) {
    const token = this._turnToken;
    const s = this.sp;
    if (s?.concurrent) {
      if (!target || s.botQueued?.has(target.playerId)) return;
      (s.botQueued ||= new Set()).add(target.playerId);
    }
    this.later(this.scaled(DELAYS.BOT_ACTION), () => {
      if (s?.concurrent) s.botQueued.delete(target.playerId);
      if (this.phase !== PHASE.SP_DRAFT || token !== this._turnToken || !this.sp || this.sp !== s) return;
      const ps = s.concurrent ? target : this.players.get(this.spTurn());
      if (!ps || !ps.botControlled || !this.spPending(ps)) return;
      const avail = s.cards.filter(c => this.spCardAvailable(c, ps)).map(c => c.idx);
      if (!avail.length) return;
      const fallback = () => this._applyCard(ps, this.botFor(ps).pickCard(this, ps, s.cards, avail));
      if (this.botFor(ps).decide?.(this, ps, { kind: 'card',
        valid: () => this.phase === PHASE.SP_DRAFT && token === this._turnToken,
        complete: () => this.sp?.picks[ps.playerId] != null, fallback })) return;
      fallback();
    });
  }

  pickCard(ps, idx) {
    if (this.phase !== PHASE.SP_DRAFT || !this.sp) return fail(ERR.WRONG_PHASE);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (this.sp.picks[ps.playerId] != null) return fail(ERR.ALREADY);
    // 并发草稿没有回合（concurrentDraft）：任何仍有可选卡片的席位随时可确认
    if (!this.sp.concurrent && this.spTurn() !== ps.playerId) return fail(ERR.NOT_YOUR_TURN);
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.sp.cards.length) return fail(ERR.BAD_TARGET);
    if (!this.spCardAvailable(this.sp.cards[idx], ps)) return fail(ERR.SOLD_OUT);
    this._applyCard(ps, idx);
    return OK;
  }

  _applyCard(ps, idx) {
    const s = this.sp;
    if (!s || s.picks[ps.playerId] != null || !this.spCardAvailable(s.cards[idx], ps)) return;
    // 扩编房间 repeats：每个确认席位拿自己的一份克隆（nested content mutations 隔离），taken 只留首位展示元数据
    const card = this.capacityExperiment ? structuredClone(s.cards[idx]) : s.cards[idx];
    if (!card) return;
    s.picks[ps.playerId] = idx;
    // Repeatable drafts keep the first picker only as display metadata, never as a slot lock.
    if (s.taken[idx] == null) s.taken[idx] = ps.playerId;
    try { applyCard(this, ps, card); } catch (e) { this.reportError(`applyCard ${card.id}`, e); }
    this.markPrivate(ps);
    // a concurrent draft: an item card can empty its group's stock — the seats still deciding see it in m.private spBlocked
    if (s.concurrent && card.kind === 'item') for (const p of this.alivePlayers()) if (p !== ps && s.picks[p.playerId] == null) this.markPrivate(p);
    this.markPublic();
    onPickCard(this, ps, card); // AI bots say "思考" when they take a bounty (enabled by default; SP_BOT_EMOTES=0 silences it)
    this.startSpTurn();
  }

  finishSpDraft() {
    if (this.phase !== PHASE.SP_DRAFT) return;
    this.cancel(this._turnTimer);
    this._turnTimer = null;
    this.beforePrepOffers();
  }

  /**
   * 教鞭 (content/items/meta.js, ctx.offerBountyChoice): the Art opens a PERSONAL choice (act2autochess choice event
   * `hunter_band_1`, choiceType PERSONAL_CHOOSE) between up to three of `candidates` — drawn once from the meta rng, kept in
   * `ps.personalChoice` (m.private only) until the owner confirms one with `g.choice { idx, choiceId }`. It lives inside
   * PREP: no phase of its own and no timer — the prep's deadline resolves it (prepDeadline), Ready is refused while it is
   * pending (PlayerPrep.setReady). Refused — before an rng draw or an id is used, so the Art stays in the hand — when it
   * is not the player's PREP, a choice is already open or no card is left to offer.
   * @param {import('../PlayerState.js').PlayerState} ps @param {any[]} candidates cards.bounty entries
   * @param {string} sourceItemId the Art
   */
  offerBountyChoice(ps, candidates, sourceItemId) {
    if (this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (ps.ready) return fail(ERR.WRONG_PHASE, 'ready');
    if (ps.personalChoice) return fail(ERR.BAD_TARGET, '请先完成当前教鞭选择'); // i18n-ignore: developer error detail
    if (!candidates.length) return fail(ERR.BAD_TARGET, '当前没有可用的战术特训'); // i18n-ignore: developer error detail
    const cards = this.rngMeta.shuffle(candidates.slice()).slice(0, PERSONAL_OFFER_SIZE);
    ps.personalChoice = { id: `${this.battlePrefix}.choice.${this.nextUid()}`, round: this.round, sourceItemId, cards };
    ps.dirty();
    return OK;
  }

  /** g.choice { idx, choiceId }: the owner's pick of its open personal choice — the card becomes a bounty on its next battles. */
  pickPersonalChoice(ps, idx, choiceId) {
    if (this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (ps.ready) return fail(ERR.WRONG_PHASE, 'ready');
    const pending = ps.personalChoice;
    if (!pending || pending.id !== choiceId || pending.round !== this.round) return fail(ERR.BAD_TARGET);
    if (!Number.isInteger(idx) || idx < 0 || idx >= pending.cards.length) return fail(ERR.BAD_TARGET);
    if (!this.addBounty(ps, pending.cards[idx])) return fail(ERR.BAD_TARGET);
    ps.personalChoice = null;
    ps.dirty();
    return OK;
  }

  /**
   * The pick made for a player who did not make it. 'bot': an AI seat or a human under AI 托管 — the bounty scorer of the
   * 机变 draft (bot.js botPickCard: the expected pay minus the expected LP lost against the own board, the bots' seeded rng
   * only breaks ties); 'random': the prep's deadline and a seat the engine finishes by other means — one of the cards at
   * random from the meta rng, like a 机变 turn that runs out. Nothing pending: nothing happens, no rng draw.
   */
  autoPickPersonalChoice(ps, mode) {
    const pending = ps.personalChoice;
    if (!pending) return undefined;
    const indices = pending.cards.map((c, i) => i);
    const idx = mode === 'bot'
      ? this.botFor(ps).pickCard(this, ps, pending.cards.map((c) => bountyCard(this.gd, c)), indices)
      : this.rngMeta.pick(indices);
    return this.pickPersonalChoice(ps, idx, pending.id);
  }

  addBounty(ps, card) {
    if (!ps || !card || !this.gd.enemy(card.enemyKey)) return null;
    // a multi-round card lasts MULTI_ROUND_BOUNTY_BATTLES battles (choices.js; the user's call after playtest #6)
    const rounds = bountyBattles(card);
    const b = {
      id: `bounty:${this.nextUid()}`,
      card: { effectId: card.effectId ?? card.id ?? null, name: card.name ?? '悬赏', desc: card.desc ?? '', tier: card.tier ?? 1, coin: Math.max(0, Math.trunc(Number(card.coin) || 0)), payout: card.payout === 'perfect' ? 'perfect' : 'kill', rounds, multiRound: isMultiRoundBounty(card), enemyKey: card.enemyKey, count: Math.max(1, Math.min(20, Number.isInteger(card.count) ? card.count : 1)) }, // i18n-ignore: a data-less card's fallback name
      roundsLeft: rounds,
    };
    ps.bounties.push(b);
    ps.dirty();
    return b.id;
  }

  /** Random item id: a choices.json server pool ({ pool }), a tier, or ≤ maxTier shop-eligible items — among those the
   * drawing seat's equipment stock (`player`, Match itemPoolFor) still holds.
   * `also` (pool_equip_kathe: 突变细胞) joins the draw even though it is shopExcluded. The shop item slot does not
   * read it. `pick` still drops ids that `canGain` refuses, so an empty shop item stays out and an uncapped `also`
   * id can still be drawn. `exclude` removes ids before sampling (Cathy's match-long allowance / distinct choices). */
  rollItemId({ pool = null, tier = null, maxTier = 6, shopLevel = 6, player = null, exclude = [] } = {}) {
    const pools = this.gd.choices.pools && typeof this.gd.choices.pools === 'object' ? this.gd.choices.pools : {};
    const p = typeof pool === 'string' && Object.hasOwn(pools, pool) ? pools[pool] : null;
    const rng = this.rngMeta;
    const stock = this.itemPoolFor(player);
    const pick = (ids, weights = null) => stock.pick(rng, exclude.length ? ids.filter((id) => !exclude.includes(id)) : ids, weights);
    const tierList = (lo, hi) => { const out = []; for (let t = lo; t <= hi; t++) for (const id of this.gd.shopItemsByTier[t] || []) out.push(id); return out; };
    const also = p && Array.isArray(p.also) ? p.also.filter((id) => typeof id === 'string' && this.gd.item(id)) : [];
    const withAlso = (list) => {
      const out = list.slice();
      for (const id of also) if (!out.includes(id)) out.push(id);
      return out;
    };
    if (p && p.kind === 'equip') {
      if (Array.isArray(p.weighted) && p.weighted.length) {
        const pairs = p.weighted.filter((x) => Array.isArray(x) && this.gd.item(x[0]) && stock.canGain(x[0]));
        for (const id of also) if (!pairs.some((x) => x[0] === id)) pairs.push([id, 1]);
        return pick(pairs.map(x => x[0]), new Map(pairs));
      }
      if (Array.isArray(p.items) && p.items.length) {
        const items = p.items.filter((id) => this.gd.item(id));
        return pick(withAlso(items));
      }
      let list;
      if (Array.isArray(p.tiers) && p.tiers.length) list = p.tiers.flatMap((t) => this.gd.shopItemsByTier[t] || []);
      else list = tierList(1, p.maxTier === 'shopLevel' ? Math.max(1, Math.min(6, shopLevel)) : 6);
      return pick(withAlso(list));
    }
    const list = Number.isInteger(tier) ? tierList(tier, tier) : tierList(1, Math.max(1, Math.min(6, maxTier)));
    return pick(list);
  }

  /**
   * Roll a choices.json pool (ctx.rollPool). Equip pools → rollItemId. Chess pools: an `items` (uniform) or `weighted`
   * list — only chess with a free pool copy (or outside the pool) qualify — else a copy-weighted draw from the shared
   * pool filtered by `tier` / `minTier` / `maxTier` (number or 'shopLevel') / `bond`; `golden: true` yields the elite id.
   * `extra` (the drawing player's 自选 stock, player/diy.js diyStockEntries) joins that shared-pool draw, `chessOf` reads the
   * bonds (the player's data view: a slotted slot's operator) — 0.2.0 WE2. 抽取按 `player`（Match poolFor）路由到其
   * 卡池组（容量房间）。
   * @returns {{ kind: 'item'|'chess', id: string, golden?: boolean } | null}
   */
  rollPool(poolId, { shopLevel = 6, player = null, extra = null, chessOf = null, exclude = [] } = {}) {
    const pools = this.gd.choices.pools && typeof this.gd.choices.pools === 'object' ? this.gd.choices.pools : {};
    const p = typeof poolId === 'string' && Object.hasOwn(pools, poolId) ? pools[poolId] : null;
    if (!p || typeof p !== 'object') return null;
    const lvl = Math.max(1, Math.min(6, Number.isInteger(shopLevel) ? shopLevel : 6));
    if (p.kind === 'equip') {
      const id = this.rollItemId({ pool: poolId, shopLevel: lvl, player, exclude });
      return id ? { kind: 'item', id } : null;
    }
    if (p.kind !== 'chess') return null;
    const stock = this.poolFor(player);
    const ps = typeof player === 'string' ? this.players.get(player) : player;
    const rng = this.rngMeta;
    const free = (id) => {
      if (typeof id !== 'string' || !this.gd.chess(id)) return false;
      const base = this.gd.baseIdOf(id);
      const copies = typeof ps?.poolOf === 'function' ? ps.poolOf(base) : stock;
      return !copies.has(base) || copies.left(base) > 0;
    };
    let id = null;
    if (Array.isArray(p.weighted) && p.weighted.length) {
      const pairs = p.weighted.filter((x) => Array.isArray(x) && free(x[0]));
      id = pairs.length ? weightedPick(rng, pairs) : null;
    } else if (Array.isArray(p.items) && p.items.length) {
      const list = p.items.filter(free);
      id = list.length ? list[Math.floor(rng() * list.length)] : null;
    } else {
      const maxTier = p.maxTier === 'shopLevel' ? lvl : Number.isInteger(p.maxTier) ? p.maxTier : 6;
      const minTier = Number.isInteger(p.minTier) ? p.minTier : 1;
      const bond = typeof p.bond === 'string' ? p.bond : null;
      const recOf = typeof chessOf === 'function' ? chessOf : (cid) => this.gd.chess(cid);
      id = stock.roll(rng, {
        tier: Number.isInteger(p.tier) ? p.tier : null,
        maxTier,
        filter: (cid, e) => e.tier >= minTier && (!bond || (Array.isArray(recOf(cid)?.bonds) && recOf(cid).bonds.includes(bond))),
        extra,
      });
    }
    if (!id) return null;
    const golden = !!p.golden;
    return { kind: 'chess', id: golden ? this.gd.goldenIdOf(id) || id : id, golden };
  }
}
