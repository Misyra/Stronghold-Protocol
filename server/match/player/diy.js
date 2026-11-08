// server/match/player/diy.js — PlayerState methods: 自选编队 (0.2.0 DIY; research 0.2.0 §2, the owner's decisions of
// 2026-10-05) — the human's picks for the four DIY slots and what a slotted operator changes in the player's own state.
//   * setDiy: the seat's picks when the match started (seats[].diy, server/lobby.js room.diy), re-checked against this
//     match's data and kit registry (shared/protocol.js checkDiyPicks, server/sim/content/kits/index.js KITTED_CHARS) and
//     fixed for the match — an out-of-match setting: a change during a match applies to the next one. Bots field no 自选
//     piece [ASSUMED]. `diy` = { [slotBaseId]: { charId, skillIndex, uniEquipId } } (frozen; uniEquipId null = none).
//   * the player's data view (diyGameData): with picks, `ps.gd` is a view of the match's GameData whose chess(id) is the
//     composed 自选 record of a slotted slot, both forms (shared/diy.js diyRecord: the slot's identity — tier, price, sell
//     price, the 3 → elite merge, status: E2 Lv1 skill rank 4 / E2 Lv60 rank 7 with the module at stage 1 at tier 5, 3 at
//     tier 6 — and the operator's body: name, class, position, stats, range, the pick's skill and module, no 特质, the
//     bonds derived from its factions; `diyFor` = the slot, `charId` = the operator). Every rule that reads a record
//     through ps.gd — bonds (bondsMeta), the 特质 / meta effects (effectsMeta makeCtx), placement and summon ranges, the
//     AI 托管 evaluation, names in toasts and tickers — sees the operator. A player without picks keeps the match's
//     GameData itself: nothing changes for anyone else. token(id) also finds the 自选 summons (data/backups.json
//     `tokens`) and placeableTokens() reads their variant of the owner form (`<charId>@<statusKey>`, shared/diy.js
//     diyTokenOwner), so a placeable 自选 summon comes to the hand like any operator's (PRTS 卫戍协议/帮助 §战斗部署).
//   * the per-player stock (initDiyStock, called by the match once its bans are drawn): each slotted DIY piece has copies
//     of its own — the tier's pool copies, 8 at tier 5 and 5 at tier 6 [ASSUMED: research 0.2.0 §2.5, the excel has no
//     stock field] — drawn by this player only; it never enters the shared pool (PR #71's shared shop was the mistake to
//     avoid); in co-op its copies double like the shared pool's (gamedata.js poolCopies × coopPoolMultiplier: 16 / 10 —
//     the maintainer's decision of 2026-10-15, GitHub #650, DESIGN §32.14.31). A piece all of whose bonds are switched
//     off this match (本局禁用: the drawn bans and the mode's static list)
//     gets no stock and so leaves the shop, like a preset chess whose bonds are all off (PRTS 卫戍协议：盟约 "禁用盟约有可能
//     影响自选的支援干员"); 协防 (emptyShip) is never banned, so a prototype always stays. poolOf(baseId) routes every copy
//     taken or returned for a slotted slot to that stock (buy, reward picks, merges, promotions, sells, temp, elimination).
//   * the shop's draws (diyRollEntries): the stock of each slotted slot joins this player's copy-weighted shop rolls,
//     weighted like any chess of its tier, once the 调度中心 has reached the slot's shopLevel (activity_table
//     shopLevelDisplayDataDict lists the tier-5 slots at level 5 and the tier-6 slots at level 6; PRTS 帮助 "仅在调度中心
//     等级 ≥ 干员所在等阶" is that persistent shop). The price is the slot's (any chess of its tier: 4).
//   * the promotion reward (pushRewardOffer with no explicit ids) draws diyStockEntries() under the reward tier
//     min(shopLevel + 1, 6): a tier-5 自选 piece can appear when the 调度中心 reaches 4, a tier-6 piece when it reaches
//     5, one shop level before the ordinary shop. 卫戍协议/帮助 干员晋升 names that refresh and no second pool; the owner
//     decided on 2026-10-12 that it includes 自选 of the newly reached tier. 0.2.0 had [ASSUMED] the shop-level gate
//     for this refresh too (DESIGN §25); §30.23 reverses it. A piece is not guaranteed. Banned slots and `left <= 0`
//     stay out. Explicit-id offers do not use this draw.
//   * random grants (diyStockEntries, 0.2.0 WE2 #9): an effect, reward or 机变 card that grants this player a random
//     operator from the pool draws its stock too — 「自选干员放入后模拟中的补给池随机范围也将被相应扩大」 (bilibili), "调度中心
//     随机资源的范围将被扩大" (PRTS 新手教程) — under the roll's own tier rules (the effect's tier / maxTier: no 调度中心 gate,
//     as for a preset chess) and filters (bonds read through the player's data view).
//   * 自选候补 (Stardust fork rel26 2d3ec08e, feedback #114; the owner's decision of 2026-11-02: four equal candidates per
//     tier, any two play; shared/diy.js DIY_BENCH_SIZE / resolveDiySlots): the seat's picks may hold more candidates per
//     tier than the tier has slots (`diyPreset`: every checked pick, slots and bench keys, in the player's order). The
//     constructor fields the seat's slots as they are; while the briefing (INFO_CHECK) is open the match fields the
//     candidates the player chose (g.diyChoose → chooseDiy, `diyChoice`), else the default against the drawn bans
//     (resolveDiy at every INFO_CHECK entry — the start and a 重刷本局 — and after each choice), and rebuilds the stock;
//     from the strategy draft on the slots are fixed. A checkpoint carries the fielded slots (`diy`) plus the whole
//     preset (`diyPreset`) and the choice (`diyChoice`), so a restore fields the same slots — and an old checkpoint
//     without a preset still restores by its slots alone.
// Installed on PlayerState.prototype by server/match/PlayerState.js (a method container: never instantiated; `this` is
// the player state).

import { KITTED_CHARS } from '../../sim/content/kits/index.js';
import { checkDiyPicks } from '../../../shared/protocol.js';
import { diyRecord, diySlot, diyTokenOwner, diySlotIds, diyKeySlotId, diyCandidates, diyTierSlotIds, diyBenchId,
  hasDiyChoice, resolveDiySlots, diyPickOff, diyPickOffBonds } from '../../../shared/diy.js';
import { atPotential } from '../../../shared/potential.js';

const posIntOr = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The copies of a player's slotted DIY pieces — the shared pool's copy interface (has / cap / left / take / give) for
 * those base ids only. `entries`: baseId → { cap, left, tier, shopLevel }.
 */
export class DiyStock {
  constructor() {
    /** @type {Map<string, { cap: number, left: number, tier: number, shopLevel: number }>} */
    this.entries = new Map();
  }

  has(baseId) { return this.entries.has(baseId); }
  cap(baseId) { return this.entries.get(baseId)?.cap ?? 0; }
  left(baseId) { return Math.max(0, this.entries.get(baseId)?.left ?? 0); }

  /** Take up to n copies; returns the number taken (0 for a base id without stock). */
  take(baseId, n = 1, { overdraw = false } = {}) {
    const e = this.entries.get(baseId);
    if (!e || !(n > 0)) return 0;
    const k = overdraw ? Math.floor(n) : Math.min(Math.max(0, e.left), Math.floor(n));
    e.left -= k;
    return k;
  }

  /** Return n copies (clamped at the cap); returns the number returned. */
  give(baseId, n = 1) {
    const e = this.entries.get(baseId);
    if (!e || !(n > 0)) return 0;
    const k = Math.min(e.cap - e.left, Math.floor(n));
    e.left += k;
    return k;
  }

  /** { baseId: left } (tests / diagnostics). */
  snapshot() {
    const o = {};
    for (const [id, e] of this.entries) o[id] = Math.max(0, e.left);
    return o;
  }
}

/**
 * The player's view of the match's GameData (see the header): `records` maps the ids of the slotted slots (normal and
 * elite) to their composed 自选 records; every other lookup is the match's own.
 * @param {import('../gamedata.js').GameData} gd
 * @param {Map<string, object>} records
 * @returns {import('../gamedata.js').GameData}
 */
export function diyGameData(gd, records) {
  const view = Object.create(gd);
  const backups = isObj(gd.raw && gd.raw.backups) ? gd.raw.backups : null;
  const diyTokens = backups && isObj(backups.tokens) ? backups.tokens : {};
  const tokenOf = (id) => (typeof id === 'string' && Object.hasOwn(diyTokens, id) && isObj(diyTokens[id]) ? diyTokens[id] : null);
  Object.defineProperties(view, {
    /** the match's own GameData (the view is per player) */
    matchData: { value: gd },
    chess: { value: (id) => (typeof id === 'string' && records.has(id) ? records.get(id) : gd.chess(id)) },
    token: { value: (id) => gd.token(id) || tokenOf(id) },
    /**
     * GameData.placeableTokens for a slotted slot: the summons its record lists (the pick's skill and talents) that are
     * placeable, by the variant of the owner form (`bySkill[skillIndex]` sources) — the deploy limit as the count (PRTS
     * 卫戍协议/帮助 "根据召唤物部署数量上限（非初始持有量）"), the active module's own when its variant has one (`byModule`:
     * 望's TRP-X "可同时部署的陷阱数量提升", 6 → 7 棋子; SUM-Y stage 2+ 4 drones / summons). The data's deploy limit holds the
     * token's own talent additions (tools/build-data.mjs tokenTalentDeckBonus, 0.2.0): 麦哲伦 / 令 / 电弧 3, 白铁 2, 夜莺 3 幻影 —
     * at the owner's potential (`loadout.potential`, PlayerState.loadoutFor; 0.2.2: 望's 棋子 6 below 潜能3, 7 from it).
     */
    placeableTokens: {
      value: (chessId, loadout = null) => {
        const rec = typeof chessId === 'string' && records.has(chessId) ? records.get(chessId) : null;
        if (!rec) return gd.placeableTokens(chessId, loadout);
        const owner = diyTokenOwner(rec.charId, rec.status);
        const out = [];
        for (const tid of Array.isArray(rec.tokens) ? rec.tokens : []) {
          const t = tokenOf(tid);
          if (!t || t.kind !== 'summon' || t.placeable !== true) continue;
          const v = isObj(t.variants) ? atPotential(t.variants[owner] ?? null, loadout?.potential) : null;
          if (v) {
            const alt = loadout && Number.isInteger(loadout.skillIndex) && v.bySkill ? v.bySkill[loadout.skillIndex] : null;
            const src = Array.isArray(alt?.sources) ? alt.sources : Array.isArray(v.sources) ? v.sources : [];
            if (!src.includes('talent') && !src.includes('skill')) continue;
          }
          const mid = rec.module && rec.module.active ? rec.module.id : null;
          const vm = v && mid && isObj(v.byModule) ? v.byModule[mid] ?? null : null;
          out.push({ tokenId: tid, count: Math.min(posIntOr(vm?.stats?.deployLimit, posIntOr(v?.stats?.deployLimit, posIntOr(t.deployLimit, 1))), 9) });
        }
        return out;
      },
    },
  });
  return view;
}

export class PlayerDiy {
  /**
   * Fix the 自选 picks for the match (see the header): the seat's picks re-checked against this match's data and kits;
   * a pick whose records cannot be composed is dropped. The seat's slots are fielded as they are (a 候补 choice changes
   * them in the briefing: resolveDiy). With picks, `this.gd` becomes the player's data view.
   * @param {any} picks `{ [slotBaseId | benchKey]: { charId, skillIndex?, uniEquipId? } | null }`
   * @param {{ kitted?: Iterable<string> }} [opts] the operators with a kit (default: the registry's
   *   KITTED_CHARS; tests may widen it to slot an operator whose kit is still being written)
   * @returns {boolean} false when the picks are malformed (nothing changes) or the player is a bot
   */
  setDiy(picks, { kitted = KITTED_CHARS } = {}) {
    if (this.isBot) return false;
    const data = this.m.gd.raw;
    const res = checkDiyPicks(picks, { data, kitted });
    if (!res || !('ok' in res)) {
      this.m.log?.warn?.(`[match ${this.m.roomCode}] 自选 picks of ${this.playerId} ignored: ${res && res.detail}`);
      return false;
    }
    // A lenient check keeps the legal picks and drops the rest without failing; say so rather than fielding a silently
    // different roster from the one the page showed.
    if (res.dropped > 0) this.m.log?.warn?.(`[match ${this.m.roomCode}] 自选 picks of ${this.playerId}: ${res.dropped} dropped`);
    const preset = {};
    for (const [key, pick] of Object.entries(res.picks)) {
      const at = diyKeySlotId(key, data);
      let ok;
      try { ok = !!at && !!diyRecord(at, pick, { elite: false, data }) && !!diyRecord(at, pick, { elite: true, data }); } catch { ok = false; }
      if (ok) preset[key] = Object.freeze({ charId: pick.charId, skillIndex: pick.skillIndex, uniEquipId: pick.uniEquipId ?? null });
    }
    this.diyPreset = Object.freeze(preset);
    const slotted = {};
    for (const id of diySlotIds(data)) if (preset[id]) slotted[id] = preset[id];
    this.applyDiySlots(slotted);
    return true;
  }

  /**
   * Field `slotPicks` (slot base id → checked pick) in the 自选 slots: their composed records (normal and elite), `diy`
   * and the player's data view. A pick whose records cannot be composed leaves its slot empty.
   * @param {Record<string, { charId: string, skillIndex: number, uniEquipId: string|null }>} slotPicks
   */
  applyDiySlots(slotPicks) {
    const gd = this.m.gd;
    const data = gd.raw;
    const kept = {};
    const records = new Map();
    for (const [slotId, pick] of Object.entries(slotPicks || {})) {
      const slot = diySlot(slotId, data);
      let normal;
      let golden;
      try {
        normal = diyRecord(slotId, pick, { elite: false, data });
        golden = diyRecord(slotId, pick, { elite: true, data });
      } catch { normal = null; golden = null; }
      if (!slot || !normal || !golden) continue;
      records.set(slot.baseId, Object.freeze(normal));
      records.set(slot.goldenId, Object.freeze(golden));
      kept[slot.baseId] = Object.freeze({ charId: pick.charId, skillIndex: pick.skillIndex, uniEquipId: pick.uniEquipId ?? null });
    }
    this.diy = Object.freeze(kept);
    this._diyRecords = records;
    this.gd = records.size ? diyGameData(gd, records) : gd;
  }

  /** 候补 (see the header): whether this player's preset leaves a choice (a tier with more candidates than slots). */
  hasDiyChoice() {
    return !this.isBot && hasDiyChoice(this.diyPreset, this.m.gd.raw);
  }

  /**
   * 候补 (see the header): field the candidates the player chose — else the default — against the bans `off` (shared/diy.js
   * resolveDiySlots). Returns true when the slots changed: the caller rebuilds the stock (initDiyStock).
   * @param {Set<string>} off the match's drawn and static bans
   */
  resolveDiy(off) {
    if (!this.hasDiyChoice()) return false;
    const next = resolveDiySlots(this.diyPreset, this.m.gd.raw, { choice: this.diyChoice, off });
    const cur = this.diy || {};
    const same = Object.keys(next).length === Object.keys(cur).length
      && Object.entries(next).every(([id, p]) => cur[id] && cur[id].charId === p.charId && cur[id].skillIndex === p.skillIndex && (cur[id].uniEquipId ?? null) === (p.uniEquipId ?? null));
    if (same) return false;
    this.applyDiySlots(next);
    this.invalidateDeployMap?.();
    return true;
  }

  /**
   * g.diyChoose (候补): the candidates of `tier` that fill its slots — exactly min(slots, candidates) distinct charIds of
   * the tier's candidates. Records the choice only (the match fields it: resolveDiy).
   * @param {unknown} tier @param {unknown} charIds
   * @returns {{ ok: true } | { error: string }}
   */
  chooseDiy(tier, charIds) {
    const data = this.m.gd.raw;
    const list = Number.isInteger(tier) ? diyCandidates(this.diyPreset, data).get(tier) : null;
    const slots = Number.isInteger(tier) ? diyTierSlotIds(tier, data).length : 0;
    if (!list || list.length <= slots) return { error: `no 自选 choice at tier ${tier}` }; // i18n-ignore: developer detail
    const ids = Array.isArray(charIds) ? charIds : [];
    const n = Math.min(slots, list.length);
    if (ids.length !== n || new Set(ids).size !== n) return { error: `choose ${n} distinct candidates` }; // i18n-ignore: developer detail
    if (!ids.every((id) => list.some((c) => c.pick.charId === id))) return { error: 'not a candidate of the tier' }; // i18n-ignore: developer detail
    this.diyChoice = Object.freeze({ ...(this.diyChoice || {}), [tier]: Object.freeze([...ids]) });
    return { ok: true };
  }

  /**
   * The candidates not slotted now as bench keys in preset order (a checkpoint's seats: server/match/matchRestore.js
   * seatEntries — so a fresh match built from the checkpoint's players fields the same slots before its state lands).
   * @returns {Record<string, { charId: string, skillIndex: number, uniEquipId: string|null }>}
   */
  diyBenchSeat() {
    const out = {};
    if (this.isBot) return out;
    const data = this.m.gd.raw;
    for (const [tier, list] of diyCandidates(this.diyPreset, data)) {
      const slotted = new Set(diyTierSlotIds(tier, data).map((id) => this.diy?.[id]?.charId).filter(Boolean));
      list.filter((c) => !slotted.has(c.pick.charId)).forEach((c, i) => { out[diyBenchId(tier, i + 1)] = { ...c.pick }; });
    }
    return out;
  }

  /**
   * m.private `diyChoice` (候补, the briefing only): per tier with a choice, its slot count, the candidates in the player's
   * order (`banned`: those of its bonds switched off this match, when any; `off`: all of them — no stock), the ones
   * fielded now and whether the player chose.
   * @param {Set<string>} off
   */
  diyChoiceView(off) {
    const data = this.m.gd.raw;
    const tiers = [];
    for (const [tier, list] of diyCandidates(this.diyPreset, data)) {
      const slotIds = diyTierSlotIds(tier, data);
      if (list.length <= slotIds.length) continue;
      const fielded = new Set(slotIds.map((id) => this.diy?.[id]?.charId).filter(Boolean));
      tiers.push({
        tier, slots: slotIds.length,
        candidates: list.map((c) => {
          const banned = diyPickOffBonds(data, c.pick.charId, off);
          return { ...c.pick, ...(banned.length ? { banned } : {}), ...(diyPickOff(data, c.pick.charId, off) ? { off: true } : {}) };
        }),
        chosen: list.filter((c) => fielded.has(c.pick.charId)).map((c) => c.pick.charId),
        picked: Array.isArray(this.diyChoice?.[tier]),
      });
    }
    return { tiers };
  }

  /**
   * The stock of each slotted DIY piece (see the header), once the match has drawn its bans: `off` = the bonds switched
   * off this match (drawn + the mode's static list). A piece all of whose bonds are off gets none (`diyBanned`).
   * @param {Set<string>} off
   */
  initDiyStock(off = new Set()) {
    const { stock, banned } = this.buildDiyStock(off);
    this.diyStock = stock;
    this.diyBanned = banned;
  }

  /** Prepare stock without mutating this player, so setup rerolls can commit all players together. */
  buildDiyStock(off = new Set()) {
    const stock = new DiyStock();
    const banned = [];
    const gd = this.m.gd;
    for (const slotId of Object.keys(this.diy || {})) {
      const rec = this._diyRecords.get(slotId);
      const slot = diySlot(slotId, gd.raw);
      if (!rec || !slot) continue;
      const bonds = Array.isArray(rec.bonds) ? rec.bonds : [];
      if (bonds.length > 0 && bonds.every((b) => off.has(b))) { banned.push(slotId); continue; }
      const cap = gd.poolCopies(slotId);
      if (!(cap > 0)) continue;
      stock.entries.set(slotId, { cap, left: cap, tier: gd.tierOf(slotId), shopLevel: slot.shopLevel });
    }
    return { stock, banned: Object.freeze(banned) };
  }

  /** The copy accounting of base chess `baseId` for this player: its own stock for a slotted DIY slot, else the shared pool. */
  poolOf(baseId) {
    return this.diyStock && this.diyStock.has(baseId) ? this.diyStock : this.pool;
  }

  /**
   * The stock entries this player's ordinary shop draws from now ([baseId, entry] with copies left and the 调度中心 at
   * the slot's shopLevel), or null (none — the shared pool's roll alone, exactly as without picks). The promotion
   * reward does not use this gate (`diyStockEntries`).
   * @returns {Array<[string, { cap: number, left: number, tier: number, shopLevel: number }]> | null}
   */
  diyRollEntries() {
    if (!this.diyStock || !this.diyStock.entries.size) return null;
    const out = [];
    for (const [id, e] of this.diyStock.entries) if (e.left > 0 && this.shop.level >= e.shopLevel) out.push([id, e]);
    return out.length ? out : null;
  }

  /**
   * The stock entries a random grant, and the promotion reward's temporary refresh, draw besides the shared pool
   * (see the header): every slotted piece with copies left, whatever the 调度中心 level (the roll's own tier rules
   * apply), or null (none).
   * @returns {Array<[string, { cap: number, left: number, tier: number, shopLevel: number }]> | null}
   */
  diyStockEntries() {
    if (!this.diyStock || !this.diyStock.entries.size) return null;
    const out = [...this.diyStock.entries].filter(([, e]) => e.left > 0);
    return out.length ? out : null;
  }

  /**
   * The 自选 pick a chess id (normal or elite) of this player fields — its slot's — or null (not a slotted slot).
   * @param {string} id
   * @returns {{ charId: string, skillIndex: number, uniEquipId: string|null } | null}
   */
  diyPickOf(id) {
    const rec = this._diyRecords && typeof id === 'string' ? this._diyRecords.get(id) : null;
    return rec ? this.diy[rec.diyFor] ?? null : null;
  }
}
