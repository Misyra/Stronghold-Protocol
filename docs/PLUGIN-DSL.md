# 插件 DSL（P2）

给插件作者。这里只描述数据，不执行任何插件代码。编译器是 `server/sim/content/dsl/compile.js` 的 `compileDsl(spec, { bb, chess, def })`，返回的东西和官方 kit 函数返回的 Kit 相同。备战效果走 `server/match/dslMeta.js`。词表的机器可读副本是 `schemas/dsl.schema.json`。设计记录在 DESIGN §32.7。

原版对局不读这些文件。`kitOf` 何时根据干员数据里的 `dsl` 字段调用编译器，由数据插件那一部分接入；在那之前，测试把编译结果放进 `makeBattle({ kits })`。

## 1. 一份规格长什么样

```json
{ "dsl": 1,
  "pluginId": "my-plugin",
  "budget": 8000,
  "skill": { "kind": "duration", "mods": { "atkPct": { "bb": "atk" } } },
  "talents": [ { "when": "battleStart", "do": [ { "dp": { "amount": 1, "fx": false } } ] } ],
  "meta": { "key": "effect:dsl-my-plugin", "on": [ { "when": "income", "if": { "round": 3 }, "do": [ { "funds": { "amount": 15, "setIncome": true } } ] } ] } }
```

- `dsl` 只能是 `1`。
- `pluginId` 是 1–64 位字母、数字、下划线或连字符。不写时按 `dsl` 计预算。
- `budget` 可省略。[ASSUMED] 省略时每场战斗、每个插件 8000 次动作。写了就必须是 1 到 10000000 的整数。
- `skill` 是当前选中的默认技能。`skills` 按技能 id 再给别的技能。持续、技力、初始技力省略时沿用干员数据；弹药省略会被引擎当成 0，所以弹药技能必须写 `ammo`。`kind` 不要省，省了引擎会当成瞬发。
- 技能回调写在 `on` 里：`start` / `end` / `hit` / `attack` / `tick`。`on.start` 在引擎发出 `skillStart` 之前运行，不要再写一条 `skillStart` 天赋去做同一件事。

不接受 `loop`、`while`、`for`、`code`、`js`、`eval`、`external`、`script`、`import`。没有循环，也没有战斗之外的状态。

## 2. 触发器

`always`、`deploy`、`battleStart`、`attack`、`hitDealt`、`hitTaken`、`kill`、`allyDeath`、`skillStart`、`skillEnd`、`every`、`hpBelow`。

[ASSUMED] 对应关系：

| 触发器 | 引擎钩子 |
|---|---|
| `always` | 安装时跑一次，不是每帧轮询 |
| `deploy` | `deploy`，且就是这个单位 |
| `battleStart` | `battleStart` |
| `attack` | `attack`，攻击者是这个单位，目标取第一个 |
| `hitDealt` | `hit`，来源是这个单位；带 `dsl` 标签的伤害不再进入 |
| `hitTaken` | `damaged`，目标是这个单位，并且是敌方的一次攻击（流失、元素、无来源、反击、反射不算）；带 `dsl` 的也不进入 |
| `kill` | `kill`，击杀者是这个单位 |
| `allyDeath` | 另一个友方死亡，且属于同一个主人 |
| `skillStart` / `skillEnd` | 同名钩子，单位是这个单位 |
| `every` | `battle.every`。`seconds` 不能小于 1/30。第一次在一个间隔之后 |
| `hpBelow` | `hpRatio` 跌破 `below` 的那一下；回到线以上之前不会再触发 |

`cooldown` 是秒，记在这次安装上，重新部署（`deploySeq` 变了）就清掉。两个相同干员不共用冷却。单位已经倒下时，除了 `battleStart`、`always`、`allyDeath`、`deploy`，动作不跑。

条件全部成立才跑动作。`chance` 用这场战斗的 `battle.rng`，并且最后才抽：前面的条件没过，不会消耗随机数。随机没中不扣动作预算。

## 3. 条件、目标、取值

条件：`chance`、`targetHas`（状态或同名 buff）、`selfHpBelow`、`enemiesInRange`（当前范围内的敌人数 ≥ n）、`bondActive`（`{ "id", "tier" }`，层数达到 `tier` 且盟约开着）、`skillActive`（`true` 表示技能开着；字符串表示技能 id 正好是它）。

目标：`self`、`target`、`source`、`alliesInRange`、`enemiesInRange`、`enemiesInRadius`、`lowestHpAlly`、`allAllies`。

[ASSUMED] `enemiesInRadius` 写成 `{ "enemiesInRadius": 1.5 }`，走技能可选的半径（不能选不可选中的，也不能选没被揭露的隐匿）。`lowestHpAlly` 只含范围内已经受伤的友方。`allAllies` 是这个单位的友方。省略目标时动作打在自己身上。

取值只做加减乘除：

- 数字。
- `{ "bb": "atk" }`，读这次技能的黑板。可以带 `default`。
- `{ "talent": [0, "cost"] }`，第 0 个具名天赋的黑板（跳过 index 为 −1 的项）。
- `{ "mul": [ ... ] }`、`{ "add": [ ... ] }`、`{ "min": [ ... ] }`、`{ "max": [ ... ] }`。
- [ASSUMED] `{ "sub": [ ... ] }`、`{ "div": [ ... ] }` 表示减和除。字面量除以 0 在校验阶段就拒绝。运行时除以 0 得到 0，不会得到无穷大。
- [ASSUMED] `{ "trait": "atk" }` 读特性黑板。`{ "stat": "atk", "of": "self" }` 在动作发生时读单位当前属性，`of` 可以是 `self`、`target`、`source`、`lastSpawn`。`{ "batMod": { "bb": "base_attack_time" } }` 走引擎的攻击间隔换算，并带上技能说明，因为原始的 `base_attack_time` 是秒数而不是百分比。

非有限数当成 0。空的 `min` / `max` 是 0。

## 4. 动作

每个动作都走引擎已有的助手，不新开一条伤害管线。

| 动作 | 助手 | 要点 |
|---|---|---|
| `buff` | `addBuff` | 带 `plugin:<id>` 标签。不写持续时间就是引擎的默认（一直在） |
| `status` | `applyStatus` | `key`、`duration`，可选 `value` |
| `damage` | `dealDamage` | 自动加上 `dsl` 标签，因此不会再触发本插件的 `hitDealt`。`isSkill`、`canDodge`、`isAttack` 只有写了才传。不要默认当成普攻 |
| `heal` | `heal` | |
| `sp` | 给技力 | 原因按天赋回复 |
| `dp` | `addDp` | [ASSUMED] `fx: true` 时即使费用是 0 也播 `dp` 特效 |
| `push` / `pull` | `push` / `pull` | |
| `spawnToken` | `spawnToken` | 见下文 |
| `layers` | `addLayers` | `bond` 是盟约 id |
| `shield` | `addBuff` 的护盾 | [ASSUMED] 默认可见，`visible: false` 才隐藏 |
| `fx` | `fx` | `kind`，可选 `at`（`self` / `target` / `source` / `lastSpawn`）、`radius`、`skill`、`token`、`n`、`dur`。`id: false` 时不写单位 id |

[ASSUMED] `damage.lose: true` 改为生命流失（`loseHp`）。`minRemain` 表示流失后生命会低于这个数时，这次不流失。`damage.from` 为 `"lastSpawn"` 时，伤害来源是刚召唤的单位。

[ASSUMED] `then` 可以写在动作旁边，也可以写在该动作的参数里（德克萨斯「打两下再晕眩」用的是参数里的写法）。两处都写，校验报 `PLUGIN_DSL_ACTION`。对伤害、状态、buff、治疗、技力、推、拉、护盾，它在每个目标结算完之后、下一个目标之前跑。其他动作整个做完再跑一次。`then` 最多套 4 层。`times` 是这一个伤害节点重复 1 到 8 次，目标倒下就停；它不是循环语法。

[ASSUMED] `spawnToken` 的 `tile` 是 `"around"`（周围能站的空格）或绝对坐标 `{ "r", "c" }`，没有相对偏移。`token` 可以是字符串，也可以是 `{ "override": true, "match": ["shadow", "doll"], "fallback": "…" }`：先用干员的 `overrideTokenKey`，再用子串匹配自己的 token 列表。`mem` 把召唤物记到单位内存。`fx: true` 播 `summon`。`stop: true` 时，找不到格子或召唤失败就停下后面的动作。

技能上的 `mods`、`ammo`、攻击倍率在编译 Kit 时就算成数字，因为引擎要把数字存在技能规格上。动作列表里的 `{ "stat" }` 仍在触发时再算。

## 5. 预算和重入

按执行次数，不按时间，所以每台机器结果一样。一个动作节点算 1 次，打中几个人都算 1 次。超出之后只停这个插件在这一场里的效果：取消它的计时器，卸掉它打过 `plugin:<id>` 标签的 buff，已经由引擎挂上的技能 buff 保留到技能结束。记一条 `plugin:<id>` 错误（`battle._handlerError`，对局会抄进 `m.simErrorLog`）。超出的那一次动作不执行。别的插件继续。

自己造成的伤害带 `dsl`，默认不再进入自己的 `hitDealt` / `hitTaken`，避免一条触发链把自己打成循环。这是引擎重入规则的 DSL 侧做法。

## 6. 备战

`meta.on` 的每一条：`when` 是 `roundStart`、`income`、`buy`、`sell`、`refresh`、`merge`、`levelUp`、`battleResult` 之一，`do` 里是 `funds`、`layers`、`gainItem`。`meta.key` 必须是 MetaRegistry 的注册键，例如 `band:band_lmlee` 或 `effect:dsl-my-plugin`。

`funds` 默认调用 `addFunds`。[ASSUMED] `setIncome: true` 改为直接写这次收入事件的 `ev.income`（截成整数，最小是 0），条件不成立时不动原来的数。这是「某一回合的收入等于某个数」的写法，包括写成 0。`layers` 调用 `addLayers`，`gainItem` 调用 `grantItem`。

[ASSUMED] 备战侧没有按次数计的动作预算。条件里可以写 `round`（整数，等于 `ctx.round`）。

调用 `registerDslMeta(registry, spec)` 注册。它不会在加载时写进默认注册表。

## 7. 和官方效果对齐过的写法

这些规格在测试里和官方 kit 打同一场，事件流一致。官方 kit 本身没有改。

持续：地灵，攻击力提升。不写 `duration`，沿用数据里的 25 秒。

```json
{ "dsl": 1, "pluginId": "rewrite-skgoat", "skill": { "kind": "duration", "mods": { "atkPct": { "bb": "atk" } } } }
```

弹药：隐现的默认技能。弹药必须写出来。攻击间隔用 `batMod`。对照窗口短于 20 秒，所以不写「上场一段时间后加弹药」的天赋。

```json
{ "dsl": 1, "pluginId": "rewrite-inside",
  "skill": { "kind": "ammo", "ammo": { "bb": "attack@trigger_time" },
    "mods": { "atkPct": { "bb": "atk" }, "batPct": { "batMod": { "bb": "base_attack_time" } }, "taunt": -1 },
    "targeting": { "priority": "ranged" } } }
```

天赋触发：德克萨斯。剑雨先加费用并播特效，再对技能范围内每个敌人打两下法术伤害，然后晕眩。开场天赋加 1 点费用且不播特效。技能范围用 `targeting.rangeGrid: "skill"` 且 `noRangeExtend: true`，这样 `enemiesInRange` 用的是技能格子、扩展为 0，和官方把格子传进助手的结果相同。

召唤：风丸。流失当前生命的一半（剩余不足 1 时不流失），在周围召唤替身，播召唤和折纸特效，再由替身对半径 1.5 内的敌人造成法术伤害。技能结束时收回替身的那一下没有写进 DSL；对照在技能持续时间（20 秒）之内停住。

备战：老鲤。第 1、2 回合收入写成 0，第 3 回合写成 15，用 `setIncome: true`。这不是战斗事件流，而是备战派发里 `ev.income` 的结果。

## 8. 错误码

校验器返回 `{ ok, problems: [{ code, path, zh }] }`，不抛错。编译时才抛，信息里带有这些码。它们先留在 DSL 自己的代码里，之后并进统一的错误目录。

`PLUGIN_DSL_SHAPE`、`PLUGIN_DSL_VERSION`、`PLUGIN_DSL_PLUGIN_ID`、`PLUGIN_DSL_BUDGET`、`PLUGIN_DSL_LOOP`、`PLUGIN_DSL_TRIGGER`、`PLUGIN_DSL_CONDITION`、`PLUGIN_DSL_ACTION`、`PLUGIN_DSL_TARGET`、`PLUGIN_DSL_EVERY`、`PLUGIN_DSL_NUMBER`、`PLUGIN_DSL_DIV0`、`PLUGIN_DSL_VALUE`、`PLUGIN_DSL_SKILL`、`PLUGIN_DSL_META`、`PLUGIN_DSL_TALENT`。

说明文字是给作者看的中文，不是对局里的界面文案。
