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

2026-10-18 修 凛御银灰 S3 变革已至 打不到空中单位（用户试玩：全是飞行敌人的波次它一次都不放）。数据里 S3 的触发是
`ACTIVE_RANGE`，它的条件（「技能要跑的范围里有敌人」）用干员**基础** profile 判定，而他是近战 PIONEER（`canHitFly` false），
飞行单位永远不算——技能一直就绪却永不释放；S3 的 `targeting` 也没声明 `canHitFly`，即便开启也打不到。**引擎保持与上游
`copy/xinhai` 完全一致**（`git diff copy/xinhai -- server/sim` 只剩本文件这一处内容），修法全在 kit：S3 自己释放技能
（`battle.every` → `sk.activate`，MANUAL 技能允许的自释放，见 skills.js `opCooling`）、`targeting` 声明 `canHitFly`、
beforeAttack 的「同一直线多目标」用 `AIR` profile 选敌人。完整重算 287 场景，只有两个带 `chess_char_5_14` 的场景改变：
`roster-043`（`act1autochess_h03` 有飞行敌人）与 `roster-044`（精英形态）——击杀 / 漏怪 / 回合数与引擎版修法完全相同，
只有 `snaps`（逐 10 秒的状态摘要）以及 `roster-044` 的 `statusApplied` 3252 → 3250（0.25 s 自释放节奏的时序差）动了。

## The corpus

2026-10-13 固定赠品装备库存改用主上游 0.2.5 的实现（`requirePool: false` + `isUnlimitedGiftItem`：赠品照常占 1/2 份、允许超过库存上限）。本分支 2026-10-11 移植 xinhai `1cf48618` 的「赠品占 0 份」provenance 模型整体移除，`piece.itemPoolCopies`、`pool.occupied()` 与 `test/match/passive-item-stock.test.js` 一起走；固定赠品的覆盖由上游的 `test/match/community-round30.test.js` 承担。完整重算 287 场景：与基线零变化——语料没有触发赠送与库存耗尽的交互路径。

| family | what runs |
|---|---|
| `roster` | 49 battles: every visible chess record (normal and elite) with every selectable skill and module (DESIGN §16), 12 operators per battle on a real stage (all 11 in turn) against the round's real wave three times over, every non-leader enemy kind of `data/enemies.json` as extra spawns (half of them bounties), placeable summons on the board, every equipment item, band, battle-side 机变 card and stage map card in turn, bonds from the board |
| `bonds` | 46 battles: every bond at its activation threshold (1 layer) and at its top tier (999 layers) |
| `fields` | 22 battles: every Final Assault / Hidden Core leader on a pair and a solo template (shared pool, 200 s cap) and the 联防 field with 1 and 2 helpers on the round's stage, both halves (carried HP / SP, a knocked-out operator, two leakers' enemies) |
| `matches` | Full matches in virtual time: bot-only solo and co-op, server-run combat, boosted Hidden Core runs, partially owned human rosters and a human with no NORMAL operators (AI 托管, offline; `standIns` records the fielded stand-ins per round), and human 自选 picks with 调度中心 level 5 from the first prep (`diy` records shop draws and deployed pieces). `matchScenarios()` lists every configuration. |
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

The original stand-in / DIY seeds remain as outcome regressions even when they field no such operator. The
`coop2-NORMAL-1-unowned-roster` scenario supplies no owned NORMAL operators, so stand-in coverage does not depend on
the bot choosing one of a small set of missing operators. `coop2-NORMAL-5-coverage-diy` covers the DIY path.
