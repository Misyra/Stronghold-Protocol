// server/match/Match.js — the match & meta engine: state machine, timers, round loop, co-op orchestration,
// broadcasting views (DESIGN §6, §8). Rules are documented in the module headers of ./PlayerState.js, ./pool.js,
// ./board.js, ./bondsMeta.js, ./effectsMeta.js, ./choices.js, ./waves.js, ./unite.js, ./finalAssault.js,
// ./results.js, ./bot.js and in docs/META.md.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// MATCH INTERFACE (platform contract: server/lobby.js ⇄ server/match/Match.js)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
//
// new Match(opts)
//   opts.roomCode    string                     4-letter room code (logging only)
//   opts.mode        'solo' | 'coop'
//   opts.difficulty  'FUNNY'|'NORMAL'|'HARD'|'ABYSS'
//   opts.modeId      string                     modeIdFor(mode, difficulty), e.g. 'mode_multi_hard'
//   opts.aiPicksLast boolean (optional)         the co-op room option 「AI 队友最后选择」 (room.setAiPicksLast, GitHub #338):
//                                              the strategy and 机变 drafts put every human seat before every AI seat
//                                              (MatchPhases.humansFirst); only `true` turns it on; ignored in solo
//   opts.seats       Array<{ seat: 0..(capacity-1), playerId: string, name: string, isBot: boolean, connected: boolean,
//                            loadout?: { [baseChessId]: { skill: index, module: uniEquipId|'none'|null } } | null,
//                            ops?: { [charId]: { potential: 1–6, cultivate: 0–3 } } | null,
//                            notOwned?: string[] | null,
//                            diy?: { [slotBaseId]: { charId, skillIndex, uniEquipId } } | null }>
//                    sorted by seat, ordinary 1–4 entries; opt-in friend-room capacity up to 20 (opts.experimental
//                    playerCapacity, shared/playerCapacity.js; Match.playerCapacity / capacityExperiment /
//                    twentyPlayerMode). Solo stays one seat.
//                    Bot playerIds start with 'ai_'. Seat indexes may have gaps (e.g. seats 0 and 2).
//                    `loadout` (DESIGN §16, optional): the human's operator loadout, already checked by the lobby
//                    (shared/protocol.js checkLoadout); PlayerState re-checks it against opts.data and ignores it for bots.
//                    `ops` (0.2.2, optional): the human's per-operator 潜能 / 练度 (checkLoadoutOps; missing = 潜能 6, 精英2
//                    Lv.60 — the owner's decision of 2026-10-08), re-checked and changed like the loadout (INFO_CHECK);
//                    bots fight with the defaults.
//                    `notOwned` (0.2.0 补位, optional): the base chess ids the human marked as not owned (干员持有) — fixed
//                    for the match; those chess fight as their stand-ins (PlayerState setNotOwned; bots own everything).
//                    `diy` (0.2.0 自选编队, optional): the human's 自选 picks (shared/protocol.js checkDiyPicks) — fixed for
//                    the match; the slotted operators join the human's own shop (PlayerState setDiy / initDiyStock).
//   opts.kitted      string[] (optional)        the operators a 自选 slot may field in this room (the content set's
//                                              list, lobby.kittedFor). Absent on a vanilla match, so setDiy keeps
//                                              KITTED_CHARS and a normal match stays byte-identical. A modded room
//                                              always passes it (local match, match host, test journal / replay).
//   opts.spectators  string[] (optional)        the room's spectator seats (remake feature, community report #26;
//                                              server/lobby.js): never players — see addSpectator below
//   opts.hostId      string (optional)          the room's current host (server/lobby.js room.hostId): the executor a
//                                              bot layout rehearsal is delegated to (DESIGN §14, botRehearsalDelegate);
//                                              setHost follows a migration while the match runs
//   opts.seed        uint32                     master seed for all match randomness
//   opts.matchNo     integer ≥ 1 (optional)     the room's match number (lobby: room.matchCount + 1); with the seed it
//                                              makes this match's battleIds unique within the room (DESIGN §14)
//   opts.cs          string (optional)          the content hash of the room's content set (DESIGN §32,
//                                              server/plugins/identity.js; 64 hex digits): copied into every BattleSpec
//                                              as `cs` — the sim never reads it; absent (or malformed) ⇒ specs carry none
//   opts.vs          string (optional)          the room's visual set of cosmetic plugins (DESIGN §32.6; 64 hex digits):
//                                              copied into every BattleSpec as `vs` (replays name the art) — never read
//   opts.requireCs   boolean (optional)         a room with gameplay plugins (DESIGN §32.6; the lobby sets it, the match
//                                              then runs in a match host, server/match/host/): a b.result whose
//                                              `cs` is missing or not opts.cs is refused like an implausible one — the
//                                              server simulates that battle itself
//   opts.version     string (optional)          a non-default official version's registry id (DESIGN §35.23,
//                                              shared/versions.js; the lobby passes it for such a room only, the match
//                                              then runs in that version's match host on its data): this.version, the
//                                              test journal's init.options.version, the external AI's context.gameVersion,
//                                              m.public / m.result `version` (the page reads a replayed result with it).
//                                              Absent, unknown or 'act2autochess' ⇒ this.version null (the default)
//   opts.data        frozen game data (server/data.js getData()); may lack keys while data is generated
//   opts.log         { info, warn, error, debug }
//   opts.now         () => ms epoch             injectable clock (Date.now in production)
//   opts.send(playerId, msg) → boolean          unicast; never throws; silently drops for bots, disconnected
//                                              or departed players (they get a full resync on reconnect).
//                                              `b.snap` frames may be dropped under backpressure.
//   opts.broadcast(msg) → void                  to every connected, non-departed human of the room.
//   opts.onEnd(summary) → void                  call EXACTLY ONCE when the match is over, after m.result was
//                                              sent. The platform then (synchronously) returns the room to
//                                              LOBBY and (asynchronously, next macrotask) calls dispose().
//                                              `summary` is free-form JSON (kept as room.lastSummary).
//   opts.onRemove(playerId, { reason, rounds }) → void   (optional) the match removed a human for good (the AFK rule,
//                                              reason 'afk', right after it sent the player m.removed): the platform
//                                              detaches the seat exactly like a g.leave, whose onLeave(playerId) follows
//                                              at once or later (the match quits the seat itself either way)
//
// start()                   Called once, right after construction. Must broadcast the first m.public and send
//                           each human its m.private. May call onEnd synchronously (the platform copes).
// handle(playerId, msg)     A validated 'g.*' intent or client-side combat report 'b.progress' / 'b.result'
//                           (msg passed validateC2S; never 'g.leave', which the
//   → { ok: true }          platform turns into onLeave). Return { error: ERR code (shared/constants.js),
//   | { error, detail? }    detail?: string } to reject. Must not throw (if it does, the platform logs and
//                           replies ERR.INTERNAL). Replies ('ok'/'error' with rid) are sent by the platform.
// onDisconnect(playerId)    A human's socket dropped. The seat is kept; apply the auto-play policy.
// onReconnect(playerId)     The human is back (new socket with its token) or re-sent hello on a live socket
//                           (a resync request). May be called without a preceding onDisconnect. Resend full
//                           state: m.public, m.private and, if a battle is on (client-side combat), the
//                           b.start of the field the player is on / watching (server-run mode: m.field + b.snap).
// setLoadout(playerId, loadout, ops?) → { ok } | { error, detail? }   (DESIGN §16; optional for the platform) a new
//                           checked operator loadout (and its 潜能 / 练度 `ops`, 0.2.2) from room.loadout. Accepted only
//                           during INFO_CHECK (the briefing's 干员调配 entry); afterwards the match's loadout is locked
//                           (WRONG_PHASE). A room whose prepLoadout rule is prep also accepts one merge during PREP
//                           while that seat has not pressed 准备 (DESIGN §34.15).
// onLeave(playerId)         The human quit permanently (g.leave, room.leave, or the 10-minute reconnect
//                           window expired). They will never return under this playerId in this match;
//                           treat as quit (AI takes over / eliminated per DESIGN). No onDisconnect follows.
// dispose()                 Stop every timer/interval and release resources. Idempotent. After dispose the
//                           platform ignores send/broadcast/onEnd from this instance.
// addSpectator(id)          (optional for the platform) A spectator seat joined during the match, came back or asked
//                           for a resync: register it (idempotent) and resend what an ELIMINATED player watching sees —
//                           m.public and, while a battle runs, the b.start (watch) of the field it watches (default: the
//                           field of the player it follows — the one it last watched, else the first player still in;
//                           server-run mode: m.field + b.snap), in a prep phase that player's board (m.field prep), or
//                           m.result once ended. A spectator gets
//                           every broadcast through the platform, never an m.private / m.toast / m.unitStats, is never
//                           a field's player or authority, and is shown fields like an eliminated player in every phase.
//                           handle(id, msg) answers only its 'g.watch' (anything else → SPECTATOR; the platform routes
//                           nothing else of it).
// removeSpectator(id)       The spectator left (room.leave / g.leave, removed by the host, reconnect window expired).
// setHost(playerId)         The room's host changed (server/lobby.js migrateHost; optional for the platform): the
//                           current executor of a delegated bot rehearsal (opts.hostId / opts.botRehearsalDelegate) —
//                           a running task of the previous host falls back to the server, later ones ask the new host.
//
// Bot seats never produce intents or hooks: the match drives bots itself (server/match/bot.js).
// Messages the match emits are the S2C 'm.*' / 'b.*' frames of DESIGN §8.2 (room.* frames are platform-owned).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
//
// Client-side combat (DESIGN §14; the default): every battle is described by a JSON BattleSpec (server/sim/spec.js).
// A normal field's owner (a connected human) simulates it in the browser and reports b.progress / b.result; a 联防 or
// boss pair field is simulated by its lowest-seat connected human (the other humans run display-only replicas).
// Bots, departed / disconnected players and fields without a connected human are simulated by the server: normal and
// 联防 fields headlessly at once (the result is released at the battle's natural end for the teammates' progress UI),
// boss fields in real time without snapshots (they share the pool). A silent authority (deadline = time limit + 15 s)
// or a disconnected one loses the field to the server, which re-simulates the spec; an implausible b.result is
// replaced by the server's own simulation (fields.js validateClientResult). The shared boss pool, the team LP and the
// overtime drain live here (b.pool ≤ 4 Hz, b.end; m.public follows a boss fight at ~1 Hz); the first end condition the
// server registers decides the Final Assault (pool 0 → victory, team LP 0 → defeat; nothing reported after a defeat is
// credited — _finalEnding, user playtest #6 item 5). No b.snap / b.ev is sent in
// this mode; g.watch hands out specs. battleIds are `<seed36>[-<matchNo36>].<round>.<seq>[.<fieldId>]` (≤ 64 chars):
// unique across the matches of a room, so a report that crossed into the next match is ignored like any stale one; a
// duplicate b.result (a browser re-sending one it believes lost) is answered ok and changes nothing.
// Bot layout rehearsals (opts.botRehearsalDelegate, off for a directly constructed Match; online rooms pass true from
// server/lobby.js hostRehearsalDefault): a bot prep's candidate layouts go to the current
// host's browser as one b.rehearsal frame — its module Worker simulates them off the page's main thread with the same
// sim, seeds and scoring and answers b.rehearsalResult with the index of its pick (server/sim/rehearsal.js). A timeout,
// a host that changed / disconnected / left or a task this client cannot run makes the server simulate the very same
// candidates itself; the task is dropped either way, so a late answer is ignored (server/match/match/rehearsal.js).
// Solo pause (g.pause { on }, setPause): freezes the field clocks, result deadlines, server release timers, the boss
// clock and the server pacers; m.public.paused; resume shifts every clock / deadline by the pause.
// Live LP (user playtest #3 item 2): during COMBAT / 联防 m.public players[].pendingLp = min(lpCapPerRound, the counted
// leaks of the player's own battle so far) (_pendingLpView; omitted when 0) — the teammates' rows of the team panel
// show lp − pendingLp; the settlement lands with the SETTLE view, where it is gone. 联防 (user playtest #6 item 7): a
// leaker's players[].uniteLeft = its enemies still standing on the 联防 field (not spawned yet, alive, or through again;
// uncapped, live: the authority's b.progress `left`, the server-run timeline or battle; exact once the field has its
// result — _uniteLeft) and pendingLp = min(lpCapPerRound, uniteLeft): the counter falls as the helpers kill them (and
// rises when one of them splits or summons — the children are billed to the same leaker).
// User playtest #4: a match with a single human (独立模拟, or a 同盟 room started alone / with AI teammates) times no
// phase outside its battles (soloUntimed); the co-op strategy draft has ONE countdown — BAND_TURN_SECONDS per turn,
// published as m.public.deadline — AI seats pick at once and a turn that runs out takes the highlighted strategy
// (g.bandFocus → timeoutBand); g.unitStats answers m.unitStats: the stats the board's units start their next battle with.
//   opts.afkRemoveRounds  integer ≥ 0 (default AFK_REMOVE_ROUNDS = 2; 0 = off): the AFK rule — see the leave policy below
//   opts.clientCombat  default true (env SP_COMBAT=server → false: the legacy server-run + snapshot streaming mode)
//   opts.verify        'off' | 'sample' | 'all' (env SP_VERIFY, default 'off'): re-simulate accepted client results
//                      ('sample': ~1 in 8, in later slices, mismatches logged; 'all': before accepting — the
//                      server's result wins on a mismatch)
//   opts.botRehearsalDelegate  offer each bot prep's layout rehearsal to the current host's browser instead (DESIGN §14).
//                      The lobby passes true for every online room unless SP_BOT_REHEARSAL=server|off|0|false
//                      (server/lobby.js hostRehearsalDefault, maintainer decision 2026-11-05); a Match constructed
//                      directly (tests, tools, golden, replay, studio) defaults off (env SP_BOT_REHEARSAL=host opts in).
//                      MatchRehearsal — the server simulates a rehearsal the host did not answer with the same
//                      candidates, seeds and scoring.
//
// Engine-only extra options (tests / tools; the lobby never passes them):
//   opts.scheduler     RealScheduler (default, uses opts.now) | VirtualScheduler (./scheduler.js)
//   opts.registry      MetaRegistry (default: built-ins + content, ./effectsMeta.js getDefaultRegistry())
//   opts.BattleClass   Battle implementation (default server/sim/Battle.js; tests inject test/match/fakeBattle.js)
//   opts.battleContent 'full' | 'generic' | 'none' (sim content mode, default 'full')
//   opts.timerScale    multiplier on every real-time phase timer (default 1)
//   opts.combatSpeed   game seconds per real second while battles run in real time (default 2, the forced 2×)
//   opts.botRehearsal  candidate layouts a bot simulates per prep before placing (default 6, 0 = heuristic only;
//                      a whole battle per candidate: ~20–300 ms of CPU each, see server/match/bot.js createRehearsal)
//   opts.botStrategy  a registered ID or trusted server-side strategy object; defaults to SP_BOT_STRATEGY / 'legacy'
//   opts.botStrategySeats  per-seat overrides { [seat 0..3]: ID | object } or 'seat:id,…'; defaults to
//                      SP_BOT_STRATEGY_SEATS (none); a seat not listed plays opts.botStrategy (getBotStrategySeats)
//   opts.botSliceMs    wall-clock ms of rehearsal per scheduler callback (default 8 with a real scheduler, unbounded
//                      with a virtual one); the rest runs in later callbacks (scheduleBotPrep)
//   opts.botRehearsalDelegateMs  wall-clock ms the host has to answer a delegated rehearsal (default 3000) — never an
//                      extension of the phase: the prep deadline stays the phase's own (MatchPrep.endPrep). Warm window
//                      of the adaptive pair: a host that has not answered one yet gets opts.botRehearsalColdMs instead
//                      (default 7000; SP_BOT_REHEARSAL_ANSWER_MS / SP_BOT_REHEARSAL_COLD_ANSWER_MS, 0 = fixed window)
//   opts.headlessSliceMs  wall-clock ms per callback of a server-run normal / 联防 field (client-side combat: bots,
//                      takeovers, result verification; default 8 with a real scheduler, at once with a virtual one)
//   opts.battlePool      SP_BATTLE_POOL (default off): a server-run normal / 联防 field's headless battle runs in a
//                      simulation-pool worker (the 'battle' task, server/workers/simulation.js) instead of this
//                      thread's slices; a missing / refusing / failing pool falls back to the slices. boss fields
//                      (sharedBoss CreditPool) and SP_COMBAT=server's FieldRunner streaming stay on this thread.
// Seats may be all bots (tools/matchrun.mjs); the lobby always has ≥ 1 human.
//
// Diagnostics: m.errors / m.errorCount (engine), m.dispatcher.errors / .errorsByKey (meta handlers), m.simErrors
// (count reported by battle results) and m.simErrorLog (Map key → { label, who, message, stack, battles, count }
// of the unique errors each finished battle recorded in battle.errors). tools/matchrun.mjs --errors prints them.
//
// Disconnect / leave policy (research 06 §10.3 + DESIGN §6.6):
//   * disconnected human: the seat keeps playing its last lineup; draft turns and prep auto-resolve at their
//     deadlines (band → 华法琳, 机变 → a random remaining card, prep → auto-ready with temp auto-resolved). Nothing is
//     bought for them unless they toggled "AI 托管" (g.autoplay { on: true }), which lets the bot play the seat.
//   * departed human (onLeave): 中途退出 counts as elimination (research 00-INDEX §3, 01 §9, 06 §7 / §10.3) — every
//     copy the seat holds returns to the shared pool at once, the seat leaves the round loop, the Final Assault
//     pairing and the boss pool; its own running normal battle is force-ended. The seat shows status 'left'. When no
//     human is left at all the match ends ('abandoned'); when nobody alive is left it ends as 'eliminated'.
//   * idle human (挂机移出, opts.afkRemoveRounds; matches that started with ≥ 2 humans): as each round's PREP ends, before
//     its battle, an alive human seat without an accepted substantive intent (common.js AFK_ACTIONS) since the previous
//     check gains an idle round, one with such an intent — or under AI 托管 at that moment — resets to 0 (the first
//     check counts from the match start: strategy draft, 机变). At afkRemoveRounds the seat is removed like a departed
//     human: m.removed { reason: 'afk', rounds } to it, m.notice { kind: 'afkRemoved', playerId, name, rounds } to
//     everyone else in the match (spectator seats included), opts.onRemove, onLeave (MatchPlatform._checkIdle). One idle
//     round short of it the seat gets a warn toast and m.private afkWarn through its next prep.
//
// Code layout: this file keeps the constructor (options, seats, the per-match setup, the state fields); the methods
// live in server/match/match/, one module per concern, and are installed on Match.prototype below in a fixed order,
// with the descriptors of class methods (non-enumerable; `this` is the match, subclasses and `super` calls work as
// before):
//   platform.js      the interface above: start, handle, setLoadout, disconnect / reconnect / resync, leave, the AFK
//                    rule's removal, dispose
//   infra.js         error isolation, timers and the phase deadline, player lists, bonds in the pool, deploy field,
//                    meta dispatch
//   messaging.js     send / broadcast / toasts / tickers, dirty marks, flush (m.private per player, m.public throttled)
//   views.js         m.public (statuses, field progress, pendingLp / uniteLeft), the nextEnemies preview, the prep
//                    scout's m.field
//   watch.js         spectator seats, g.watch, who is shown which field, resend on reconnect, prep-scout pushes
//   intents.js       the g.* / b.* router, emotes, AI 托管, g.unitStats
//   pause.js         the solo pause
//   phases.js        INFO_CHECK, BAND_DRAFT (the strategy draft), BATTLE_CHECK, ROUND_START
//   spDraft.js       SP_DRAFT (机变) and the rolls the meta effects ask for (bounties, item ids, pools)
//   prep.js          PREP: its start, the AI seats' sliced preps, Ready, the deadline, its end
//   combat.js        battle construction, COMBAT (both modes), the per-field results, then 联防 or SETTLE
//   clientCombat.js  client-side combat bookkeeping: field records, the field clock, authority, b.start, result
//                    deadlines and releases, server runs, field completion
//   rehearsal.js     the bot layout rehearsal delegated to the current host's browser: the b.rehearsal task, its answer,
//                    its timeout and the server takeover (DESIGN §14)
//   reports.js       b.progress / b.result (validation, held boss results), SP_VERIFY
//   unitePhase.js    联防 (UNITE) in both modes and the leakers' live counts
//   bossRounds.js    FINAL_ASSAULT / HIDDEN_CORE: boss fields, the shared pool, plausibility budgets, the boss clock,
//                    b.pool, the merged team LP, overtime, bounties after a boss field
//   poolGroups.js    the capacity experiment's seat groups (pool.js createPoolGroups): buildPoolGroups / routePools /
//                    poolFor / itemPoolFor — 多人同盟的分组卡池与装备库存路由
//   settle.js        SETTLE and RESULT
//   common.js        what the modules share (FLOW_TICKER_PRIORITY, DELAYS, BAND_TURN_SECONDS — re-exported here, OK,
//                    fail, BOSS_CLOCK_MS)

import { PHASE, modeIdFor } from '../../shared/constants.js';
import { experimentalOptions } from '../../shared/experimental.js';
import { roomCapacity } from '../../shared/playerCapacity.js';
import { isContentHash } from '../../shared/plugins/identity.js';
import { DEFAULT_VERSION, versionById } from '../../shared/versions.js';
import { Battle } from '../sim/Battle.js';
import { DataSource } from '../sim/simdata.js';
import { createRng, deriveSeed } from '../sim/rng.js';
import { GameData } from './gamedata.js';
import { RealScheduler } from './scheduler.js';
import { SharedPool, createItemPools, drawDisabledBonds } from './pool.js';
import { PlayerState } from './PlayerState.js';
import { EffectDispatcher, getDefaultRegistry } from './effectsMeta.js';
import { setupMatchWaves } from './waves.js';
import { getBotStrategy, getBotStrategySeats } from './botStrategies.js';
import { GAME_SPEED, HEADLESS_SLICE_MS } from './fields.js';
import { MatchPlatform } from './match/platform.js';
import { MatchInfra } from './match/infra.js';
import { MatchMessaging } from './match/messaging.js';
import { MatchViews } from './match/views.js';
import { MatchWatch } from './match/watch.js';
import { MatchIntents } from './match/intents.js';
import { MatchPause } from './match/pause.js';
import { MatchPhases } from './match/phases.js';
import { MatchSetupVote } from './match/setupVote.js';
import { MatchSpeedVote } from './match/speedVote.js';
import { MatchKickVote } from './match/kickVote.js';
import { MatchSpDraft } from './match/spDraft.js';
import { MatchPrep } from './match/prep.js';
import { MatchCombat } from './match/combat.js';
import { MatchClientCombat, battlePoolDefault } from './match/clientCombat.js';
import { MatchRehearsal, REHEARSAL_ANSWER_MS, REHEARSAL_COLD_ANSWER_MS } from './match/rehearsal.js';
import { MatchBotPlan } from './match/botplan.js';
import { MatchReports } from './match/reports.js';
import { MatchUnite } from './match/unitePhase.js';
import { MatchBoss } from './match/bossRounds.js';
import { MatchPoolGroups } from './match/poolGroups.js';
import { MatchSettle } from './match/settle.js';
import { AFK_REMOVE_ROUNDS } from './match/common.js';
import { installTestTrace } from './testTrace.js';
import { MatchTestCommands } from './match/testCommands.js';
import { MatchOffers } from './match/offers.js';
import { createExternalAI } from './llmGate.js';
import { DamageBoard } from './damageBoard.js';

export { FLOW_TICKER_PRIORITY, DELAYS, BAND_TURN_SECONDS, AFK_REMOVE_ROUNDS } from './match/common.js';

/**
 * §37.47 [ASSUMED]: 6 (was 3) — every distinct layout variant of a normal round (the positional plan and the five
 * REHEARSAL_VARIANTS; 8 rehearsed exactly the same games). In one rehearsal of six the winner was past the third candidate
 * (终极 solo, 419 rehearsals: hold 8 and kill 3 won 12 %); 终极 1–320 solo +2.19 ± 0.90, co-op +5.60 ± 1.65 (wins 73 → 92),
 * for about a third more rehearsal time per prep. More layouts only in the Final Assault changed nothing.
 */
const BOT_REHEARSAL_DEFAULT = 6;
/** Wall-clock ms of bot layout rehearsal per scheduler callback (real time; virtual time runs it in one go). */
const BOT_SLICE_MS = 8;
const env = (k) => (typeof process !== 'undefined' && process.env ? process.env[k] : undefined);
/** Default combat mode: client-side unless SP_COMBAT=server. */
const envClientCombat = () => String(env('SP_COMBAT') || '').toLowerCase() !== 'server';
/**
 * SP_VERIFY → 'off' | 'sample' | 'all'. `off` (the default) accepts any result that is plausible for its spec;
 * `sample` is a diagnostic canary, not a guard — about one result in eight is re-simulated AFTER it was accepted and
 * a difference is only logged (`verifyStats.mismatches`), which is what catches a client whose data or code drifted
 * from the server's; `all` re-simulates before accepting and the server's result wins on a mismatch.
 */
export function parseVerify(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'all' || s === 'sample' ? s : 'off';
}
/** Default of the bot rehearsal delegation for a directly constructed match: off — SP_BOT_REHEARSAL=host opts in.
 *  Online rooms do not rely on this: the lobby passes an explicit true/false (hostRehearsalDefault, 2026-11-05). */
const envBotRehearsal = () => String(env('SP_BOT_REHEARSAL') || '').trim().toLowerCase() === 'host';
/** SP_BOT_PLAN_POOL=1 opts the bot placement planning into the simulation pool (default off: the inline path). */
const envBotPlanPool = () => String(env('SP_BOT_PLAN_POOL') || '').trim() === '1';
/** Candidate layouts per prep when `opts.botRehearsal` is absent: `SP_BOT_REHEARSAL_COUNT` (0–8), else the engine
 *  default. The deployment can lower it to 3 to cut rehearsal time (docs/DEPLOY.md). */
const envBotRehearsalCount = () => {
  const raw = String(env('SP_BOT_REHEARSAL_COUNT') ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 8) : null;
};
/** The warm answer window when `opts.botRehearsalDelegateMs` is absent: `SP_BOT_REHEARSAL_ANSWER_MS` (integer > 0), else
 *  REHEARSAL_ANSWER_MS. Garbage keeps the default (the deployment knob must not silently disarm the fallback). */
const envBotRehearsalAnswerMs = () => {
  const n = Number(String(env('SP_BOT_REHEARSAL_ANSWER_MS') ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : null;
};
/** The cold-start answer window when `opts.botRehearsalColdMs` is absent: `SP_BOT_REHEARSAL_COLD_ANSWER_MS`
 *  (integer ≥ 0; 0 pins the fixed warm window for every task), else REHEARSAL_COLD_ANSWER_MS. */
const envBotRehearsalColdMs = () => {
  const raw = String(env('SP_BOT_REHEARSAL_COLD_ANSWER_MS') ?? '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
};
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

const dsCache = new WeakMap();
function dataSourceFor(data) {
  if (!data || typeof data !== 'object' || !data.chess) return undefined;
  let ds = dsCache.get(data);
  if (!ds) { ds = new DataSource(data, null); dsCache.set(data, ds); }
  return ds;
}

export class Match {
  /** @param {object} opts see MATCH INTERFACE above */
  constructor(opts) {
    if (!opts || !Array.isArray(opts.seats) || opts.seats.length === 0) throw new TypeError('Match: seats required');
    if (typeof opts.send !== 'function' || typeof opts.broadcast !== 'function' || typeof opts.onEnd !== 'function') {
      throw new TypeError('Match: send/broadcast/onEnd callbacks required');
    }
    this.opts = opts;
    this.roomCode = opts.roomCode ?? '----';
    this.mode = opts.mode === 'solo' ? 'solo' : 'coop';
    this.difficulty = opts.difficulty;
    this.modeId = opts.modeId || modeIdFor(this.mode, opts.difficulty);
    this.seed = (Number(opts.seed) >>> 0) || 1;
    this.log = opts.log || noopLog;
    this.sendFn = opts.send;
    this.broadcastFn = opts.broadcast;
    this.onEndFn = opts.onEnd;
    this.data = opts.data && typeof opts.data === 'object' ? opts.data : {};
    if (this.data.config?.version && !Object.hasOwn(this.data.config.modes || {}, this.modeId)) {
      throw new RangeError(`Match: mode ${this.modeId} is unavailable in ${this.data.config.version.id}`);
    }
    /** the room's content hash (opts.cs, DESIGN §32): every BattleSpec carries it */
    this.cs = isContentHash(opts.cs) ? opts.cs : null;
    /** the room's visual set (opts.vs, DESIGN §32.6): every BattleSpec names it */
    this.vs = isContentHash(opts.vs) ? opts.vs : null;
    /** a room with gameplay plugins (opts.requireCs): a client result must name this match's cs (reports.js) */
    this.requireCs = opts.requireCs === true && !!this.cs;
    /** a non-default official version's id (opts.version, DESIGN §35.23), else null (the default, act2autochess) */
    this.version = typeof opts.version === 'string' && opts.version !== DEFAULT_VERSION && versionById(opts.version) ? opts.version : null;
    // [ASSUMED] Only an array is a content list. Omitting the key (every vanilla match) leaves setDiy on KITTED_CHARS.
    // A copy so a caller's freeze or later mutation cannot change the check, and so the key stays off public views.
    if (Array.isArray(opts.kitted)) this.diyKitted = Object.freeze(opts.kitted.filter((id) => typeof id === 'string'));
    // The room's rule switches (DESIGN §34.15). Omitted on a vanilla match, so its own keys stay the same.
    if (opts.rules && typeof opts.rules === 'object' && !Array.isArray(opts.rules)) this.rules = Object.freeze({ ...opts.rules });
    /**
     * The room-owned experimental options this match started with (server/lobby.js startMatchWith; shared/experimental.js):
     * locked and normalized (experimentalOptions — an invalid shape, capacity or duck-lord switch throws), fixed for the
     * match. 联动干员 is no longer one of them — the collab 6★ are ordinary 自选 picks (2026-11-03). Direct engine
     * fixtures keep the legacy option names (opts.revivalEnabled / opts.disableSharedPool).
     */
    this.experimental = experimentalOptions(opts.experimental ?? {
      revivalEnabled: opts.revivalEnabled === true, disableSharedPool: opts.disableSharedPool === true,
    });
    /**
     * The interaction windows this match's content set declares (PLUGIN API v2, docs/PLUGINS.md §10b): the normalized
     * `offers` of the plugins the host installed, handed in as `opts.offers` before construction so test journals
     * and both host transports capture the same declaration snapshot. `[]` for every match whose set declares none, and then
     * no window code ever runs (MatchOffers.openOfferWindow returns before it touches the phase).
     * @type {object[]}
     */
    this.offers = Array.isArray(opts.offers) ? opts.offers : [];
    /** @type {any[]} the windows open right now (MatchOffers) */
    this.offerWin = [];
    /** @type {Map<object, any>} window → its deadline timer (tracked so dispose cancels it) */
    this._offerTimers = new Map();
    /** what runs once the last open window closes (a held-back round start / prep) */
    this._offerResume = null;
    /** window sequence (diagnostics and messages) */
    this.offerSeq = 0;
    this.gd = new GameData(this.data, this.modeId);
    if (!this.difficulty) this.difficulty = this.gd.difficulty;
    this.isSolo = this.mode === 'solo' || this.gd.isSolo;
    /** 多人同盟容量（移植自用户分支，shared/playerCapacity.js）: the room's seat count; a solo room stays one seat */
    this.playerCapacity = roomCapacity(this.isSolo ? 'solo' : this.mode, this.experimental);
    /** the capacity experiment: an opt-in co-op room past the ordinary four — drafts repeat, pools group */
    this.capacityExperiment = !this.isSolo && this.playerCapacity > 4;
    /** the 20-seat variant: fixed consecutive four-seat pool chunks (pool.js createPoolGroups) */
    this.twentyPlayerMode = this.capacityExperiment && this.playerCapacity === 20;
    /** 华法琳禁用 (experimental.disableDuckLord, capacity rooms only): the default band is out (gamedata bandAllowed) */
    this.disableDuckLord = this.capacityExperiment && this.experimental.disableDuckLord === true;
    this.gd.disableDuckLord = this.disableDuckLord;
    /** the room's private-pool switch (experimental.disableSharedPool): every seat its own complete pool (poolGroups) */
    this.disableSharedPool = this.experimental.disableSharedPool;
    /** AI 联防置后 (experimental.uniteHumansFirst, 移植自用户分支 rel29): 联防 helper 先在真人里挑, AI 队友与 AI 托管垫后 (unite.js helperOrder) */
    this.uniteHumansFirst = this.experimental.uniteHumansFirst === true;
    /** 「AI 队友最后选择」 (opts.aiPicksLast, GitHub #338): humans draft before AI seats (MatchPhases.humansFirst) */
    this.aiPicksLast = !this.isSolo && opts.aiPicksLast === true;
    /** 「允许重复策略」 (opts.bandDupes, 本仓新设): the strategy draft lets several doctors hold the same strategy */
    this.bandDupes = !this.isSolo && opts.bandDupes === true;
    /** 挂机移出 (opts.afkRemoveRounds): idle rounds in a row that remove a human seat; 0 = off (MatchPlatform._checkIdle) */
    this.afkRemoveRounds = Number.isInteger(opts.afkRemoveRounds) && opts.afkRemoveRounds >= 0 ? Math.min(opts.afkRemoveRounds, 100) : AFK_REMOVE_ROUNDS;
    this.ownsScheduler = !opts.scheduler;
    this.sched = opts.scheduler || new RealScheduler({ now: opts.now || Date.now, onError: (e) => this.reportError('timer', e) });
    this.registry = opts.registry || getDefaultRegistry();
    this.dispatcher = new EffectDispatcher(this, this.registry);
    this.BattleClass = typeof opts.BattleClass === 'function' ? opts.BattleClass : Battle;
    this.battleContent = opts.battleContent || 'full';
    this.timerScale = Number.isFinite(opts.timerScale) && opts.timerScale >= 0 ? opts.timerScale : 1;
    this.gameSpeed = Number.isFinite(opts.combatSpeed) && opts.combatSpeed > 0 ? Math.min(opts.combatSpeed, 200) : GAME_SPEED;
    /** 战斗 2 倍速投票（g.speedVote，match/speedVote.js）：已投换档赞成的 playerId；全员赞成 → 下一场战斗开始前换档 */
    this.speedVotes = [];
    /** layouts a bot rehearses per prep with the real simulation (bot.js; 0 = heuristic placement only) */
    this.botRehearsal = Number.isInteger(opts.botRehearsal) && opts.botRehearsal >= 0
      ? Math.min(opts.botRehearsal, 8)
      : envBotRehearsalCount() ?? BOT_REHEARSAL_DEFAULT;
    this.bot = getBotStrategy(opts.botStrategy ?? env('SP_BOT_STRATEGY'));
    /** per-seat overrides of this.bot (seat → strategy; empty by default — botFor) */
    this.seatBots = getBotStrategySeats(opts.botStrategySeats ?? env('SP_BOT_STRATEGY_SEATS'));
    /** wall-clock budget of one rehearsal slice (scheduleBotPrep) */
    this.botSliceMs = Number.isFinite(opts.botSliceMs) && opts.botSliceMs > 0 ? opts.botSliceMs : this.sched.virtual ? Infinity : BOT_SLICE_MS;
    /**
     * Offer a bot's layout rehearsal to the current host's browser (DESIGN §14): `opts.botRehearsalDelegate`. A direct
     * construction defaults off (env SP_BOT_REHEARSAL=host opts in); the lobby passes true for online rooms unless
     * SP_BOT_REHEARSAL=server|off|0|false (server/lobby.js hostRehearsalDefault, 2026-11-05). The server simulates a
     * rehearsal the host did not answer (see MatchRehearsal).
     */
    this.botRehearsalDelegate = opts.botRehearsalDelegate != null ? !!opts.botRehearsalDelegate : envBotRehearsal();
    /** wall-clock ms the host has to answer a delegated rehearsal (engine option: tests shorten it; the warm window of
     *  the adaptive pair below — opts first, then SP_BOT_REHEARSAL_ANSWER_MS, then the engine default) */
    this.botRehearsalDelegateMs = Number.isFinite(opts.botRehearsalDelegateMs) && opts.botRehearsalDelegateMs > 0 ? opts.botRehearsalDelegateMs : envBotRehearsalAnswerMs() ?? REHEARSAL_ANSWER_MS;
    /**
     * Wall-clock ms a host answers its FIRST delegated rehearsal in (MatchRehearsal.delegateWindowMs): the cold-start
     * window covers a browser Worker still loading the /sim/ module graph — the eb679687 loop timed that first task
     * into the pool and made both sides work. 0 pins the fixed window (the pre-adaptive behaviour). Engine option
     * first (tests), then SP_BOT_REHEARSAL_COLD_ANSWER_MS, then the engine default.
     */
    this.botRehearsalColdMs = Number.isFinite(opts.botRehearsalColdMs) && opts.botRehearsalColdMs >= 0 ? opts.botRehearsalColdMs : envBotRehearsalColdMs() ?? REHEARSAL_COLD_ANSWER_MS;
    /**
     * SP_BOT_PLAN_POOL（默认关）: hand the final arrange's first candidate-plan batch to the simulation pool
     * (match/match/botplan.js + botPlanTask.js). Needs a pool (opts.simPool — poolPlan re-checks) and a plan task
     * that answers before the next seat's prep touches the shared rngBots stream; every failure shape falls back to
     * the inline path, so the flag can only save main-thread CPU, never change a layout.
     */
    this.botPlanPoolOn = envBotPlanPool();
    /** how the bot-plan pool tasks ended (MatchBotPlan) — pooled / applied / inline fallbacks (the tests read it) */
    this.botPlanPoolStats = { pooled: 0, accepted: 0, fallbacks: 0 };
    /** successful delegated answers per host player id (MatchRehearsal): ≥1 makes that host warm (the warm window) */
    this._rehearsalHostAnswers = new Map();
    /** the room's current host (opts.hostId; server/lobby.js room.hostId — setHost follows a migration) */
    this.hostId = typeof opts.hostId === 'string' ? opts.hostId : null;
    /**
     * 开发者控制台 (opts.consoleEnabled, room.console.enable — 移植自用户分支): the room's opt-in, fixed for the whole
     * match. The grants (MatchIntents.consoleGrant) check the per-player quotas (CONSOLE_ROUND_LIMIT / CONSOLE_TOTAL_LIMIT).
     */
    this.consoleEnabled = opts.consoleEnabled === true;
    /**
     * Match test mode (DESIGN §34.8 phase 2). opts.test is only forwarded for a room created with the flag.
     * The extra state exists only then, and public / result views omit the keys while this is false, so a
     * normal match stays byte-identical.
     */
    this.test = opts.test === true;
    if (this.test) {
      /** phase deadlines are armed. false holds the callback (g.test timers) instead of scaling time to 0. */
      this.testTimers = true;
      /** successful g.test commands this match (m.result.testActions) */
      this.testActions = 0;
      /** @type {{ seq: number, playerId: string, cmd: string, args: object, at: number, ok: boolean, code?: string }[]} */
      this.testLog = [];
      /** @type {Map<string, number[]>} command → scheduler timestamps inside the rate window */
      this._testRate = new Map();
      this._testSeq = 0;
      /** the phase callback held while testTimers is false */
      this._testHeld = null;
      /** the last callback setDeadline armed, so timers can be turned off mid-phase */
      this._testArmed = null;
      /** false once the input journal stops logging (the replay decoder's line cap) */
      this.testReplayable = true;
      /** replay: stop a sliced callback after this many steps; null while recording */
      this._testSliceBudget = null;
      /** steps taken by the timer callback now running (the journal's `steps`) */
      this._testSliceCount = 0;
    }
    /** @type {Map<string, { id: string, job: any, executor: string, timer: any }>} delegated rehearsals in flight */
    this._rehearsalTasks = new Map();
    this._rehearsalSeq = 0;
    /** how this match's delegated rehearsals ended (the log lines above; the tests read it) */
    this.rehearsalStats = { delegated: 0, answered: 0, takeovers: 0 };
    /**
     * The server's own simulation pool (server/workers/roomPool.js), or null when the operator started none. It is a
     * placement decision only: `poolRehearsal` submits the same candidates the local run would simulate and falls back
     * to simulating them here whenever the pool is absent, busy or broken.
     */
    this.simPool = opts.simPool || null;
    /** how the bot rehearsals that were offered to `simPool` ended — separate from rehearsalStats (its keys are asserted) */
    this.rehearsalPoolStats = { pooled: 0, accepted: 0, fallbacks: 0 };
    this.ds = dataSourceFor(this.data);
    /** client-side combat (DESIGN §14) — see the header */
    this.clientCombat = opts.clientCombat != null ? !!opts.clientCombat : envClientCombat();
    /** SP_BATTLE_POOL (clientCombat.js): server-run normal / 联防 fields hand their battle to the simulation pool.
     * The env default never pools a virtual scheduler (tests / tools step those synchronously); opts.battlePool
     * explicitly opts a match in or out (tests with a stub or real pool). */
    this.battlePool = opts.battlePool != null ? !!opts.battlePool : (battlePoolDefault() && !this.sched.virtual);
    this.verifyMode = parseVerify(opts.verify ?? env('SP_VERIFY'));
    /** wall-clock ms per slice of a server-run normal / 联防 field (virtual time: at once) */
    this.headlessSliceMs = Number.isFinite(opts.headlessSliceMs) && opts.headlessSliceMs > 0 ? opts.headlessSliceMs : this.sched.virtual ? Infinity : HEADLESS_SLICE_MS;
    this.verifyStats = { checked: 0, mismatches: 0, rejected: 0, takeovers: 0 };
    this._battleSeq = 0;
    /** solo pause (g.pause, DESIGN §14): the field clocks / deadlines are frozen while true (m.public.paused) */
    this.paused = false;
    this._pausedAt = 0;
    /** real ms spent paused this match (diagnostics) */
    this.pausedMs = 0;
    /** boss rounds (client-side combat): the throttled m.public refresh (_bossPublic) */
    this._bossPubTimer = null;
    this._bossPubAt = -Infinity;
    this._bossClockOn = false;
    /**
     * battleId prefix (DESIGN §14): the seed (+ the room's match number) — a b.progress / b.result that crossed into the
     * next match of the room (the same socket, the same field ids) never names a battle of this match.
     */
    this.battlePrefix = `${this.seed.toString(36)}${Number.isInteger(opts.matchNo) && opts.matchNo > 0 ? `-${opts.matchNo.toString(36)}` : ''}`;
    if (opts.seats.length > this.playerCapacity) throw new RangeError('Match: seats exceed room capacity');
    this._progressTimer = null;
    this._bossClock = null;
    this._lastPoolAt = -Infinity;
    this._poolTimer = null;
    this._lastPoolKey = '';
    this.pacer = null;

    const rng = (name) => createRng(deriveSeed(this.seed, name));
    this.rngSetup = rng('setup');
    this.rngShop = rng('shop');
    this.rngWaves = rng('waves');
    this.rngDraft = rng('draft');
    this.rngBots = rng('bots');
    this.rngMeta = rng('meta');

    /** @type {Map<string, PlayerState>} */
    this.players = new Map();
    const seen = new Set(), seatIndexes = new Set();
    for (const s of opts.seats) {
      if (!s || typeof s.playerId !== 'string' || seen.has(s.playerId)) continue;
      if (!Number.isInteger(s.seat) || s.seat < 0 || s.seat >= this.playerCapacity || seatIndexes.has(s.seat)) {
        throw new TypeError('Match: unique seat index within room capacity required');
      }
      seen.add(s.playerId);
      seatIndexes.add(s.seat);
      this.players.set(s.playerId, new PlayerState(this, s));
    }
    if (!this.players.size) throw new TypeError('Match: seats required');
    /**
     * Strategies the room designated for AI seats (opts.seats[].band, room.setBotBand, 移植自用户分支): AI playerId →
     * bandId, in seat order. The AI seat takes its strategy in the draft, held for it until then (phases.js bandTaken /
     * reservedBands).
     * @type {Map<string, string>}
     */
    this.botBands = new Map();
    for (const s of opts.seats) {
      const ps = s && typeof s.playerId === 'string' ? this.players.get(s.playerId) : null;
      if (ps?.isBot && typeof s.band === 'string' && s.band) this.botBands.set(ps.playerId, s.band);
    }
    this.order = [...this.players.values()].sort((a, b) => a.seat - b.seat);
    /**
     * Spectator seats (opts.spectators / addSpectator): playerId → a stand-in every watch path treats like an eliminated
     * human (alive false; no PlayerState, never a field's player or authority).
     * @type {Map<string, { playerId: string, isBot: false, left: false, alive: false, connected: true, spectator: true }>}
     */
    this.spectators = new Map();
    for (const id of Array.isArray(opts.spectators) ? opts.spectators : []) this._spectator(id);
    /**
     * Exactly one human seat at the start (独立模拟, or a 同盟 room started alone / with AI teammates only): nobody waits
     * on anybody, so no phase outside a battle is timed — soloUntimed (user playtest #4 item 3). The mode's own rules
     * (draft order and skip, 6 机变 cards, 联防 …) stay.
     */
    this.loneHuman = this.order.filter((p) => !p.isBot).length === 1;

    // per-match setup (DESIGN §6.5)
    const setup = setupMatchWaves(this.gd, this.rngSetup);
    this.stageId = setup.stageId;
    this.stage = this.stageId ? this.gd.stage(this.stageId) : null;
    this.factions = setup.factions;
    this.bossId = setup.bossId;
    this.hiddenBossId = setup.hiddenBossId;
    const bans = drawDisabledBonds(this.gd, this.rngSetup);
    this.disabledBonds = bans.drawn;
    this.staticInactiveBonds = bans.staticOff;
    this.bannedChess = bans.banned;
    // 容量房间（移植自用户分支）: one pool per seat group (pool.js createPoolGroups via MatchPoolGroups.buildPoolGroups);
    // `pool` remains the ordinary diagnostic/bond-availability view; transactions always route via poolFor / ps.pool.
    this.poolGroups = this.buildPoolGroups(bans.banned);
    this.pool = this.disableSharedPool ? new SharedPool(this.gd, { banned: bans.banned }) : this.poolGroups[0].pool;
    this.playerPools = this.routePools(this.poolGroups);
    // equipment stock follows the same groups (pool.js createItemPools); `itemPool` is the first group's — the only one
    // in an ordinary match — and every transaction routes via itemPoolFor / ps.itemPool
    this.playerItemPools = createItemPools(this.gd, this.poolGroups, (id) => this.players.get(id));
    this.itemPool = this.playerItemPools.get(this.poolGroups[0].playerIds[0]);
    // 自选编队 (0.2.0): each human's slotted DIY pieces get their own stock — none for one whose bonds are all off this
    // match (player/diy.js initDiyStock); no randomness is drawn here
    const off = new Set([...bans.drawn, ...bans.staticOff]);
    for (const ps of this.order) ps.initDiyStock(off);

    this.phase = PHASE.LOBBY;
    this.round = 0;
    this.deadline = 0;
    /** Final Assault / Hidden Core: ms epoch when the overtime drain starts (m.public.overtimeAt) */
    this.overtimeAt = 0;
    this.uidSeq = 0;
    this.ended = false;
    this.disposed = false;
    this.startedAt = this.sched.now();
    /** @type {Set<any>} */
    this._timers = new Set();
    this._phaseTimer = null;
    this._infoAdvanceTimer = null;
    this.setupRevision = 0;
    this.setupVote = null;
    this._setupVoteSeq = 0;
    /** @type {Map<string, number>} last accepted 重刷本局 start per seat (30 s cooldown; DESIGN §28.21) */
    this._rerollStartAt = new Map();
    // 投票移出(移植自用户分支, kickVote.js): the open vote, its id sequence, targetId → the round a vote on it
    // failed, playerId → the last proposal ms
    this.kickVote = null;
    this._kickVoteSeq = 0;
    /** @type {Map<string, number>} */
    this._kickFailed = new Map();
    /** @type {Map<string, number>} */
    this._kickVoteAt = new Map();
    this._turnTimer = null;
    this._pubDirty = false;
    /** 持久化脏计数(移植自用户分支, snapshot.js persistVersion): markPublic/markPrivate 增量, 见 messaging.js */
    this._persistRev = 0;
    this._pubTimer = null;
    this._lastPubAt = -Infinity;
    this._lastPubJson = '';
    /** flushSoon 的合并 timer(messaging.js)与上次私有视图实发时刻(真实 ms) */
    this._flushTimer = null;
    this._lastPrivFlushAt = -Infinity;
    /** @type {Set<PlayerState>} */
    this._privDirty = new Set();
    this.errors = [];
    this.errorCount = 0;
    this.simErrors = 0;
    /** @type {Map<string, { label: string, who: string, message: string, stack: string|null, battles: number, count: number }>} */
    this.simErrorLog = new Map();
    this._prepEndQueued = false;

    this.draft = null;
    this.sp = null;
    this.wave = null;
    this.bossWaves = null;
    this.bossPairs = null; // drawn for the Final Assault, drawn anew for the Hidden Core (GitHub #845, DESIGN §35.27)
    this.bossPairsRound = null; // the round whose first plan drew bossPairs (a re-plan after a departure keeps them)
    this.fields = [];
    this.runner = null;
    /** playerId → fieldId */
    this.watchers = new Map();
    /**
     * Watch preference (community report of 2026-10-06, item 56; the idea of PR #189): viewer playerId → the player it
     * last chose to watch with a manual g.watch. Every phase reset starts an eliminated human or a spectator seat on that
     * player again (its prep board, its battle field) — else the first player still in — instead of its own empty board.
     */
    this.watchPref = new Map();
    this.lastResults = new Map();
    /** The finished battle's own game-time seconds per player (combat._finishCombat; the onBattleResult ev's `time`). */
    this.lastResultTimes = new Map();
    this.unitePlan = null;
    /** 本轮普通战斗开始时的存活席位数（combat.js 写入；容量联防接力以 ≥8 判定，round start 先归零） */
    this._normalAliveCount = 0;
    /** 联防接力（容量房间 ≥8 人，unitePhase.js startUnite）：{ rounds: [{ plan, result, survivors, view }] } */
    this._uniteRelay = null;
    /** 伤害/治疗结算板 (fork feature, server/match/damageBoard.js): every finished field's result folded in, cumulative
     * across the match; read-only metadata, exposed as m.public.damage (views.js) — reconnects and spectator seats
     * included. Nothing in the sim / settlement reads it, so no golden result moves. */
    this.damageBoard = new DamageBoard();
    /** 联防 outcome for the SETTLE view: { through, helpers, leakers, losses } (settle()), null when no 联防 resolved */
    this.uniteResultView = null;
    /** server-run 联防: the leakers' counts last published (_uniteTick) */
    this._uniteLeftKey = null;
    /** 联防: { plan, bounds } — per leaker the most survivors settlement can bill (_uniteLeft's clamp) */
    this._uniteBounds = null;
    this.teamLp = null;
    this.bossPool = null;
    this.hiddenLayerSum = 0;
    this.hiddenReached = false;
    this.outcome = null;
    this._turnToken = 0;
    // [ASSUMED] A real scheduler keeps the 8 ms bot and headless slices, including a test match,
    // so one callback cannot run to HARD_CAP_SECONDS. Virtual time stays unbounded (the defaults
    // above). The input journal records the steps that callback took; replay stops there.
    this.externalAI = createExternalAI(this, opts);
    if (this.test && opts.journal !== false) installTestTrace(this, opts);
  }
}

// the method modules, in this order (a name defined twice is an error, never a silent override)
for (const part of [MatchPlatform, MatchInfra, MatchMessaging, MatchViews, MatchWatch, MatchIntents, MatchPause, MatchPhases, MatchSetupVote, MatchKickVote, MatchSpeedVote, MatchSpDraft, MatchPrep, MatchCombat, MatchClientCombat, MatchRehearsal, MatchBotPlan, MatchReports, MatchUnite, MatchBoss, MatchPoolGroups, MatchSettle, MatchTestCommands, MatchOffers]) {
  for (const key of Reflect.ownKeys(part.prototype)) {
    if (key === 'constructor') continue;
    if (Object.prototype.hasOwnProperty.call(Match.prototype, key)) throw new Error(`Match.${String(key)} is defined twice`);
    Object.defineProperty(Match.prototype, key, Object.getOwnPropertyDescriptor(part.prototype, key));
  }
}
