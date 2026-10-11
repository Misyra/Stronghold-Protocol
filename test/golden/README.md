# Golden results

The simulation is deterministic: the same seed and inputs give the same battle and the same match, bit for bit. These
files record the exact outcome of a fixed corpus of seeded scenarios, so a change that alters gameplay — even one meant
to be a pure refactor that only reorders random draws, hook order or iteration order — fails loudly instead of slipping
through.

- `tools/golden.mjs` builds the corpus from `data/*.json` (fixed order, fixed seeds) and reduces every scenario to a
  digest. Its header documents the families and the digest fields.
- `test/golden/<family>.json` hold the digests (`roster`, `bonds`, `fields`, `matches`, `standins`, `diy`).
- `test/golden.test.js` recomputes them and compares. On a mismatch it prints the scenario, the field and old → new.

2026-10-07 移植 xinhai-ai/Stronghold-Protocol `57d75e52` 的 #282 联防修复：保留本回合地形和各援助者的设备改造，逃脱模板只提供重入批次与路线。当前分支完整比对确认 6 个 matches 改变：
`coop2-NORMAL-3`、`coop2-HARD-4`、`coop3-ABYSS-5`、`coop4-ABYSS-7`、`coop2-NORMAL-8-serverrun`、`coop2-NORMAL-14-standins`。
同时修正黄金场景构造，让 `unite-1`、`unite-2` 也传入本回合 stageId；仅更新这 8 个基线，其余 275 场景不变。差异来自保留阻挡物后的寻路、伤害与漏怪变化及后续回合结果。

## The corpus

2026-10-11 移植 xinhai `1cf48618`（干员被动/特质赠送装备不占用、不受共享装备库存限制，装备实例以可选
`itemPoolCopies` 记录真实占用）。本地按官方语料完整重算 287 场景：零场景变化——官方基线的 20 场对局与
267 场战斗都没有触发赠送与库存耗尽的交互路径（xinhai 分支仅 `coop4-FUNNY-6` 变化，来自其既有语料差异）。
豁免、混合合成占用与快照恢复由 `test/match/passive-item-stock.test.js` 覆盖。

| family | what runs |
|---|---|
| `roster` | 49 battles: every visible chess record (normal and elite) with every selectable skill and module (DESIGN §16), 12 operators per battle on a real stage (all 11 in turn) against the round's real wave three times over, every non-leader enemy kind of `data/enemies.json` as extra spawns (half of them bounties), placeable summons on the board, every equipment item, band, battle-side 机变 card and stage map card in turn, bonds from the board |
| `bonds` | 46 battles: every bond at its activation threshold (1 layer) and at its top tier (999 layers) |
| `fields` | 22 battles: every Final Assault / Hidden Core leader on a pair and a solo template (shared pool, 200 s cap) and the 联防 field with 1 and 2 helpers on the round's stage, both halves (carried HP / SP, a knocked-out operator, two leakers' enemies) |
| `matches` | 20 matches to the end in virtual time: 16 bot-only (solo 标准 / 险境 / 绝境 / 终极 × 2 seeds, co-op 2 / 3 / 4, one server-run combat match, two runs boosted to the Hidden Core), one co-op match whose human seat (AI 托管, offline) does not own 9 NORMAL chess — they fight as their 补位 stand-ins (its digest lists them per round, `standIns`) — and one whose human seat slots 自选 picks (推进之王 and prototypes) with its 调度中心 at level 5 from the first prep: its own shop draws them and its AI fields 推进之王 (its digest lists per round the 自选 shop draws and the fielded pieces, `diy`) |
| `standins` | 10 battles: every NORMAL chess record (normal and elite, 110) fielded as its 补位 stand-in (`standIn: true`: the stand-in's body, backup skill / module and kit — all 17 stand-ins, every skill a chess names for them), 12 per battle by strength band, laid out by the stand-in's position on a real stage, against the round's real wave three times over plus 8 ground enemy kinds (melee stand-ins always meet an enemy), an item each, bonds from the board |
| `diy` | battles of 自选 pieces (a DIY slot with its `diy` pick, `shared/diy.js`): every owned 6★ with an operator kit (`kits/index.js OPERATOR_KITS`) in each form of tiers 5 and 6 (normal; elite with no module and with each module) under each skill, then every prototype pick with a kit at its locked selection, normal and elite, 12 per battle against the round's real wave; a new operator kit adds its scenarios (the battle count grows with the kits) |

Battles go through the production BattleSpec path (`server/sim/spec.js`, as browsers and the server's headless fields
run them); matches construct `Match` directly with a `VirtualScheduler`. Every option is explicit, so a change to a
test-harness default never moves a digest.

What a digest ignores on purpose (it does not affect gameplay): object key order, engine unit ids (snapshot ids are
renumbered by first appearance, units are named by board uid or def id), board piece uids, the order of client events
within a tick (they are counted, not hashed) and wall-clock time. Damage / healing sums are rounded to integers and HP
to 2 decimals.

`npm test` runs the fast subset (the scenarios marked `"fast": true`: every chess record with its default loadout,
every stage and every non-leader enemy kind, every bond at its top tier, six fields, seven matches, the five stand-in
battles of the normal records, the first 自选 battle of the operator kits and of the prototypes — 62 of the 151). `GOLDEN_FULL=1` checks everything.

## Workflow

```sh
GOLDEN_FULL=1 node --test test/golden.test.js   # the whole corpus (≈ 20 s with 4 worker threads)
node --test test/golden.test.js                 # the fast subset
npm run golden                                  # the same comparison from the tool (all families, a short report)
npm run golden:update                           # recompute and rewrite test/golden/*.json
node tools/golden.mjs --twice                   # determinism: the corpus twice in one process, the second pass reversed
```

- **A refactor commit must never change these files.** Run `GOLDEN_FULL=1 node --test test/golden.test.js` before
  committing it. If a digest moves, the refactor changed behaviour: find out why (the first differing value of `snaps`
  says when two runs parted, in 10-game-second steps) instead of updating the files.
- **An intended gameplay change** (a fix, new content, a data rebuild): run `npm run golden:update` and commit the
  changed files together with the change, saying in the commit message which scenarios moved and why.
- **Reviewing the diff:** every scenario is a block of its own and every unit / enemy / round is one line, so a diff
  shows which scenarios moved and which values changed. A change confined to the scenarios that contain the touched
  operator, enemy or rule is expected; a change everywhere (every `rngDraws`, every `snaps`) means something global
  moved — the RNG draw order, the tick order, a shared rule.
- **Adding to the corpus** (a new family, more scenarios, a new digest field) changes the files by design: do it in a
  commit of its own, never together with a refactor.
- A new engine hook, event or chess record does not change the digests of the existing scenarios by itself — the
  hook list is frozen in the tool and the corpus is regenerated only on `golden:update` — but new data records do join
  the corpus there (the roster family enumerates `data/chess.json`).

After the measured shared-stock update (DESIGN §29.8), the original stand-in / DIY seeds remain as outcome regressions even when they field no such operator. Companion seeds `coop2-NORMAL-1-coverage-standins` and `coop2-NORMAL-5-coverage-diy` exercise those full paths; the corpus now contains 287 scenarios.
