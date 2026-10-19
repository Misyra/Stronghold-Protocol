# 干员皮肤 (Operator skins)

> **This fork (2026-10-18, after 0.3.1):** the game wears the built-in **catalogue**, and a cosmetic plugin adds rows
> to it. Normative for the catalogue, its ids and the wire is [OPERATOR-SKINS.md](OPERATOR-SKINS.md); what this document
> keeps is the OVERLAY schema below and the display rules (设置「显示其他玩家的皮肤」, the picker's two rules).
>
> * An appearance is an outfit of `shared/skin-catalogue.js` (276 outfits over 174 operators; generated, no URLs), chosen
>   per OPERATOR — `room.skins { choices }` = `{ [charId]: admittedSkinId }`, one entry covering a normal chess, its
>   elite and a 自选 slot fielding that operator. The server refuses any map the catalogue does not admit
>   (`shared/skins.js isSkinChoices`).
> * There is **no catalogue file** and **no install message** any more: upstream's `data/skins.json` and
>   `room.skin.install` are gone. This server's owner installs an outfit's files with `tools/install-skins.mjs`
>   (`data/skins-installed.json` records what landed, `data/assets.json` carries the URLs). The picker lists the whole
>   catalogue and marks the outfits this server does not have as 未安装 — they cannot be picked.
> * A stored choice is keyed per chess in the browser (`sp.pref.skins`) because that is what the 干员调配 roster, the
>   自选 slots and the 商店立绘 choice are keyed by; `ui/skins.js skinChoicesOf` translates it to the operator-keyed map
>   at the wire, and nothing else does.
> * The overlay path below is unchanged as a SCHEMA: it is what a cosmetic plugin (and the studio, and the Forge import)
>   writes into the composed manifest for `chars[charId].illust` / `chars[charId].skins[skinId]`. That manifest is what
>   the renderer draws from, and `shared/skins.js manifestSkinKey` translates a catalogue id to the official id it is
>   keyed by.

An operator's Spine model and its pictures can be replaced by one of its official alternative outfits (时装). This
document is the normative reference for that feature; the art itself is **never** downloaded or written by the server —
it comes from a **cosmetic plugin's overlay** (docs/PLUGINS.md §9), which the server's owner installs in `plugins/` and
each player switches on for themself.

> 上游 #652 被关闭的原因写在这里，因为它是这个设计的出发点：**服务器不提供安装通道**。当时的 `room.skin.install`
> 让任何已连接的客户端都能让服务器去网上下载文件并改写所有客户端共读的 `data/assets.json`，而随包发布的
> `data/skins-installed.json` 又会让更新校验对不上。本实现没有安装报文、不写 `data/` 下的任何文件、不随包发布任何
> 安装状态：皮肤属于插件，插件怎么落地是 `plugins/` 目录（安装、studio、ZIP）本来就有的问题。

## The data: one overlay, no catalogue file

```
plugins/<id>/plugin.json
  └── assets (or a .json file):  chars[<charId>].illust ……     the operator's own 立绘 (one picture)
                                 chars[<charId>].skins[<skinKey>] = { name, group, avatar, avatarE2,
                                                                      portrait, portraitE2, illust,
                                                                      spine: { front, back? } }
        │
        ├── the server checks the overlay (shared/plugins/visual.js, docs/PLUGINS.md §9) and serves it as a document:
        │   /vs/<vs16>/overlay.json — composed on the INSTALLATION's manifest, never on a copy of it
        │
        └── the browser composes it (public/js/cosmetics.js cosmetics.apply) on the manifest it already loaded
                 │
                 └── data.get('assets') — what every screen reads (public/js/data.js setView)
                          │
                          ├── chars[<charId>].skins[<skinKey>]  →  the picker's rows (public/js/ui/skins.js availableSkins)
                          └── chars[<charId>].skins[<skinKey>].spine  →  the model (public/js/assets.js spineEntry { skin })
```

Three properties are load-bearing:

- **A skin key is the KEY, and it is data.** It carries `@` `#` `+` `.` (`char_002_amiya@winter#1`), so it is **not** an
  `isId` (shared/protocol.js `isSkinId`). A plugin that has no official id for a skin may write the stem form
  (`char_102_texas_epoque_7`) [ASSUMED: docs/PLUGINS.md §9]. Whatever writes a skin and whatever wears it must agree on
  that exact string.
- **The choice is keyed by OPERATOR (charId), not by chess.** `chars[<charId>].skins` is the manifest's own grouping, so
  one entry covers an operator's normal piece, its elite (the merge) and a 自选 slot fielding it. The renderer agrees:
  a unit's skin resolves through `d.spine ?? d.charId ?? u.defId` (server/sim/snapshot.js), i.e. the charId.
  Every owner/scout board, hand, temp and battle input resolves the **effective body** with `PlayerState.fieldRecord`:
  a stand-in uses `backup.charId`, a 自选 slot its pick. Official source:
  `activity_table.activity.AUTOCHESS_SEASON.act2autochess.charShopChessDatas` `backupCharId` (for example
  `chess_char_3_01_a`: `char_103_angel` → `char_603_csnipe`). [ASSUMED] Skin choices follow that body too, so an original
  operator's selected outfit never dresses its stand-in; the official table specifies bodies, not this cosmetic UI.
- **A missing piece falls back; nothing is ever a placeholder.** `spineEntry(m, id, { skin })` draws the operator's own
  model when the skin (or its model) is not in the manifest; `avatarUrl` / `portraitUrl` / `illustUrl` fall back to the
  operator's own pictures. The picker shows the operator's portrait on a skin that ships none.

## The switch model: the owner installs, each player switches on

| Who | What they do | Where it is stored |
|---|---|---|
| The server's owner | Drops the plugin folder into `plugins/` (the studio, a ZIP, or by hand), and switches it on for the **room** if they want a set everyone in that room sees | `plugins/`, a room's `vs` |
| A player | Switches a `scope: ["personal"]` cosmetic plugin on for **themself** — a skin of their own choosing | `sp.pref.cosmetics` (this browser only, never sent) |

A room's **host is not part of it**: an appearance a player wears comes from *their* browser's layers, so a plugin with
`scope: ["personal"]` never appears in the room's 插件 panel and no room setting can force a skin on anyone. Two players
of the same co-op match may therefore see different models for the same piece — see the switch below.

## 设置「显示其他玩家的皮肤」 (default on)

A pure client preference (`settings.otherSkins`, `sp.pref.settings`; **never sent**):

- **on** (the default) — a piece draws the appearance its owner chose, which the match published
  (`Match.publicView().players[].skins`, and `UnitInfo.skin` of every unit);
- **off** — every other seat's piece draws the operator's own model; **this player's own pieces keep their skin**.

The asymmetry is deliberate and is what the setting is for: what you draw is your own choice, what others draw is theirs.
Turning it off hides *their* look from *you* and changes nothing on their screen (public/js/render/app.js `skinOf`). The
renderer decides who is "other" from `UnitInfo.ownerId` and the local `me.playerId`
(public/js/ui/fieldHost.js `setMe`) — never from the seat whose camera happens to be on screen.

[ASSUMED] Switching off retains the received skin ID separately (`sourceSkin`) and derives only the displayed `skin`.
Switching back on restores already loaded units immediately, including a boss partner's read-only prep pieces and
units received while hidden. `room.skins` remains valid in every phase: `Match.setSkins` marks the owner's private
view, which also refreshes existing prep scouts and the boss partner. `fieldHost` forwards public seat choices to
`view.setSkins(players)` on mount and when they change. The current battle's operators use that latest selection
(an omitted `skins` map clears it), even if later spawn metadata carries an older choice. This rebuilds appearance
only: it neither changes the running sim / BattleSpec nor restarts playback. Live refresh timing is a remake UI
choice, not a rule established by the official tables.

## The picker: two display rules

In 干员调配 (`screens/loadout.js Detail`) and in the 自选编队 picker's detail (`screens/diy.js DiyPickerView`), the 皮肤
section sits under the operator's name. 潜能与练度 immediately follows 皮肤 wherever cultivation is offered.
The preserved 0.3.1 order is 皮肤 → 潜能与练度 → 特质 → 技能 → 局内数值 → 模组 in 干员调配, and
皮肤 → 潜能与练度 → 局内数值 → 技能 → 模组 in 自选编队 (prototype picks omit cultivation).
[ASSUMED] This is the existing remake panel order; official tables do not prescribe a skin picker layout.

1. **The section is GLOBAL: every operator shows it, or none does.** The one question `SkinSection` asks is
   `public/js/ui/skins.js hasAnySkinChoices()` — **at least one** operator of the composed manifest has one **wear-able**
   skin (`chars[<charId>].skins[<skinKey>]` with a model this client resolves). While that is false — no plugin at all,
   a plugin that writes only pictures, or only skins that are art without a model — nothing is drawn anywhere, header
   included: an installation without a cosmetic layer looks exactly as it did before this feature.
   While it is true, **every** operator shows the section, including one the plugins wrote no skin for. That operator
   gets the 默认 tile alone, a real picture on it and no empty art box, and the header's note reads `0 套外观`: the count
   is kept at zero on purpose, because the whole point of the global rule is that this box **means something** — "the
   plugin is on, this operator has no 时装". A section hidden per operator said nothing, and left the player unable to
   tell an operator without skins from a plugin that failed to load. This is the **reverse** of the rule this feature
   first shipped with (a per-operator `hasSkinChoices`: 默认 plus a wear-able skin of *that* operator, else no section),
   and it must not be turned back. `hasSkinChoices` remains the single-operator criterion — no production code calls it
   — and is what `hasAnySkinChoices` is counted from, so the two can never disagree about "wear-able".
   The gate counts **wear-able appearances**, never pictures: a plugin that writes only 立绘 (`chars[<charId>].illust`) and
   no skin turns the section on nowhere, and this picker then shows none of its pictures. That is deliberate — the
   section exists to choose a 时装 and its note counts 套外观, so one replaced 立绘 must not put a `0 套外观` box on every
   operator of the installation. A plugin whose 立绘 has to be seen has to give some operator a wear-able skin (then every
   operator's 默认 tile draws the 立绘 it has, per the rule below), or needs a surface of its own. Should the gate ever be
   meant to count a 立绘 as well, the one line that changes is the body of `hasAnySkinChoices`.
2. **A missing layer falls back to the operator's own art** — a skin with no `portrait` shows the operator's portrait
   (its `illust`, then the portrait), never a slash or a placeholder; the tile is dimmed (`.lo-skin--fallback`) so the
   replacement is legible. The enlarged preview (`.lo-skin-preview`, a `Modal`) shows the skin's 立绘.

The 默认 tile is the operator's **real** appearance, not an empty slot: it draws the operator's own 立绘
(`chars[<charId>].illust` — the picture an appearance plugin may write for an operator it gives no skin at all, and this
tile is the only place that picture is seen), else `chars[<charId>].portrait`, else its avatar. The 立绘 wins over the
portrait on purpose, for the same reason the section is global: what a plugin wrote for the operator has to be visible,
and the 1:2 tile crops to the top exactly as it already does for a skin that ships only an illust. It is never empty
while the record has any of the three; an operator the composed manifest does not hold at all (not even a 默认 tile
exists) gets no section rather than an empty grid.

## Where the choice is drawn

The 商店立绘 row is not a preview of somewhere else: the art it picks is the art of the operator **in the screen that
picked it**. Three surfaces read it, all through `ui/assetUrls.js shopPortraitUrl(m, chess, chose)` so the 默认 /
精英二 sentinel and the fallback to the operator's own portrait stay one rule:

| Surface | Read |
|---|---|
| `loadout.js OpCard` — the 干员调配 deck card | `usePortraitPick(chess.chessId)` |
| `loadout.js Detail` — the detail header | `usePortraitPick(chess?.chessId)`, art of `golden || chess` (the 精英二 record when there is one) |
| `diy.js SlotCard` — the 自选 slot card | `portraitFor(rec.chessId)`, redrawn by `SkinSection`'s `onChange` |

A pick writes `ui/skins.js` and therefore only a **subscriber** sees it: a `.get()` in a render is read once, so the two
loadout surfaces subscribe (`usePortraitPick`) instead of reading the store. `screens/diy.js` cannot — its views are
drawn without a hook dispatcher by the tests — so `SkinSection` takes an optional `onChange` it fires after each pick,
and `DiyPanel` bumps a counter with it. The key is `chess.chessId` on all three, the same key `SkinSection` writes and
the server validates; the in-match shop card reads `baseId || chessId` (a piece's own record).
[ASSUMED] That the 干员调配 screen shows the art it just chose is a UI reading of the picker, not an official rule.

## The file: 皮肤配置 travels on its own

A 调配 export carries the picks inside its envelope (`skins` / `portraits` next to `entries`), which is the right shape
for a backup of a loadout and the wrong one for the thing players actually do with skins — carry them to another
server: that file also names skills, modules and 潜能, so importing it costs the receiving install its own loadout, and a
file holding only skins was refused outright (`里面没有有效的调配条目`). So the choice has a second file, of its own, and
nothing else in it (`public/js/ui/skinTransfer.js`):

```json
{ "kind": "stronghold.skins", "v": 1, "exportedAt": "…", "count": 2,
  "skins":     { "char_377_gdkn_2b": "char_377_gdkn_2b@epoque#4" },
  "portraits": { "char_377_gdkn_2b": "e2", "chess_char_5_diy1_a": "char_377_gdkn_2b@epoque#4" } }
```

1. **Keys are what the store stores** — `{ [chessId]: skinId }`, the roster's chess ids and the 自选 slot ids alike
   (`sp.pref.skins` / `sp.pref.skinPortraits`, same key `SkinSection` writes), both maps whole rather than split by the
   tab the player happened to be on. `count` is the number of distinct operators across both maps, not the sum of their
   lengths.
2. **Values are carried, not resolved.** The envelope never asks whether this install has that operator or that skin.
   An id from a server with a different plugin set is kept and simply draws nothing (`assets.js spineEntry` returns
   null) — which is exactly what makes the file portable. A blank value and a non-string are dropped (a blank is "no
   choice", not a value); `__proto__` / `constructor` / `prototype` are refused as keys, as everywhere a stored map is
   parsed.
3. **Import replaces both maps** (`setSkins` + `setPortraits`), and asks for no readiness gate: the other three imports
   sanitise against `chess.json`, a skin id needs no table, so this one works while the data is still loading — and on a
   server whose roster differs. It refuses a file with **no choices at all** — that file would silently wipe the
   selection — and refuses a foreign `kind` (a 调配 file is not a skin file either way round) or a higher `v`; 64 KiB
   cap [ASSUMED], refreshed at a few KB.
4. **Entry points are the screen's own toolbars**, beside the exports that were already there — 导出皮肤 / 导入皮肤
   (`data-testid="skin-export"` / `skin-import`): direct buttons in the 自选编队 toolbar and in the list view's, two
   items in the deck view's 更多 menu. Not in the 皮肤 section: a picker holds the choice, the screen holds every file
   it writes, and the player who came to carry skins across servers looks where the other two exports are. The pair
   therefore also reaches an operator the detail panel is not showing — the export is the whole stored map, not the
   open operator's row. 导出 is disabled while nothing is stored; the screen reads that count through
   `useStore(... skinsStore)` rather than a one-off `get()`, or the item would stay grey after the first pick beside it.
   The modal is the screen's (`kind: 'skins'`, title 导出 / 导入皮肤配置); the download is
   `stronghold-skins-YYYYMMDD-HHmm.json`.
5. **It is an addition, not a replacement.** The 调配 / 自选 exports keep writing their own half of the choices
   (`rosterSkinMap` / `slotSkinMap` in `loadout.js openExport`) and keep reading them back, so an old way of carrying a
   loadout still restores its appearances; a file written now carries both halves and one file is enough for a backup.
   What the standalone file buys is the case a backup cannot serve: a server you are not restoring a loadout onto.

## New files

> Upstream 0.3.1's port log, kept for provenance: the file list and the edit list below describe the ORIGINAL port.
> This fork's current wiring is the note at the top and [OPERATOR-SKINS.md](OPERATOR-SKINS.md) — `data/skins.json`,
> `room.skin.install` and `server/skinInstall.js` no longer exist.

| Path | What |
|---|---|
| `public/js/ui/skins.js` | The client store (`sp.pref.skins`, `{ [charId]: skinId }`, at most `SKIN_LIMITS.entries` pairs: `parseStoredSkins` is the one parse of a stored selection — the store's initial state, every edit and what the sync sends — so the wire's own limit is applied where the selection is read), `availableSkins` (the composed manifest's rows, with `playable` and with art already resolved and fallen back; the 默认 row exists for every operator the manifest holds, also one with no `skins`), `hasAnySkinChoices` (the section's global rule), `hasSkinChoices` (the single-operator criterion, kept for tests and future rules), `chosenSkin` (a stored entry that is not one of this operator's wear-able skins counts as 默认), `setSkin` / `clearSkin` |
| `public/js/ui/skinPicker.js` | The 皮肤 section itself: `SkinSection` (nothing while `hasAnySkinChoices` is false — for every operator alike; the 默认 tile alone for an operator without a skin), `SkinPreview` (the enlarged 立绘), the five-tile grid's markup and the `onChange` hook a parent's art hangs off; no 导出 / 导入 button — the screen's toolbars carry the file, the picker carries the choice |
| `public/js/ui/skinTransfer.js` | 皮肤配置 as a file of its own: `SKIN_EXPORT_KIND` (`stronghold.skins`), `SKIN_TRANSFER_VERSION`, `SKIN_IMPORT_MAX_BYTES`, `skinConfig` / `serializeSkinConfig` / `parseSkinConfig` — the envelope above, and the only reader that accepts it |
| `test/skins-transfer.test.js` | The envelope: what it carries, junk dropped, a foreign `kind`, a newer `v`, an empty file refused, that an unknown operator id survives, and that the toolbar pair is wired while the 皮肤 section itself carries no file buttons — plus that the 调配 / 自选 exports still hold their own half of the choices |
| `test/skins.test.js` | The wire shape (`isSkinId` / `isSkinSelection`), the lobby → Match → PlayerState chain, the public view, reconnect, the sim's UnitInfo, the client's fallbacks, and the absence of the install channel |
| `test/lobby-skins.test.js` | `room.skins` over WebSocket: validation, session and seat storage, the seats handed to the Match, bots, the change made mid-match |
| `test/ui/skin-picker.test.js` | The picker's rules against a composed manifest: the rows, `playable`, the art fallbacks, the global `hasAnySkinChoices` and the per-operator `hasSkinChoices`, `chosenSkin`, and that the section's gate is the global one |
| `docs/SKINS.md` | This document |

## Edits to existing files

| File | Where | What |
|---|---|---|
| `shared/protocol.js` | before `isNotOwnedList` | `SKIN_LIMITS` (256 [ASSUMED]), `isSkinId` (**not** `isId`; the same character class as `isSkinKey`), `isCharId`, `isSkinSelection`, `operatorCharIds`, `checkSkinSelection` |
| `shared/protocol.js` | `C2S` | `'room.skins'` — and **no** `'room.skin.install'` |
| `server/net.js` | `HEAVY_TYPES`, `Session` ctor | `'room.skins'`; `session.skins` |
| `server/lobby.js` | after `freezeDiy`, `onMessage`, after `diy()`, `humanSeat`, `seatSettings`, `startMatch` | `freezeSkins` (charId + skinId, drop operators the room lacks; a bad map is BAD_MSG and does not clear), `case 'room.skins'`, `skins()` — **no phase gate**, unlike the loadout — and the selection riding into the match |
| `server/match/PlayerState.js` | ctor | `this.skins = Object.freeze({})` + `setSkins(seat.skins)` |
| `server/match/player/basics.js` | after `setLoadout` | `skinCharIdOf` / `skinFor` / `setSkins` (bots refused; a bad map refused whole, unknown operators dropped) |
| `server/match/match/platform.js` | after `setLoadout` | `setSkins(playerId, skins)` — any phase, `markPrivate()` (owner, prep scouts, boss partner) and `markPublic()` |
| `server/match/match/views.js` | `publicView().players[]`, `_prepBoardUnits`, the scouted bench | `skins` (omitted when empty), and `skin` on every unit the player owns |
| `server/match/player/round.js` | `battleInput` | the unit's `skin`, from the player's own selection and the piece's operator (a 自选 slot follows its pick) |
| `server/match/player/views.js` | `pieceView` | `skin` on the prep board / hand / temp views |
| `server/sim/units.js`, `server/sim/battle/players.js`, `server/sim/snapshot.js` | `Unit`, `_createAllyFromInput` / `_makeAlly`, `unitInfo` | carried to the client; `skin: u.skin ?? undefined`, so a piece without one adds no key to the wire |
| `public/js/assets.js` | `portraitUrl` / `illustUrl` (new) / `spineEntry` / `hasBackSpine` / `unitPictureUrl` / `skinsOf` / `skinHasModel` | every helper takes `opts.skin` (the skinId) and falls back to the operator's own art |
| `public/js/render/units.js` | `_pictureUrl`, `_modelEntry`, `_wantsBack`, `_loadPicture` | `info.skin` reaches the Spine entry, the diamond and the Front/Back question; the picture's cache key carries the skinId |
| `public/js/render/app.js` | `otherSkins` setting, `ctx.myPlayerId`, `applyInfo`, `refreshSkins`, `setSettings`, `setMe`, `setSkins`, `pieceInfo` | received `sourceSkin` is retained while displayed `skin` follows the switch and latest public selection; a changed appearance drops the view; read-only prep pieces refresh too |
| `public/js/render/app/info.js` | `renderInfo` | `skin` |
| `public/js/ui/loadoutSync.js` | header, `installSkinsSync` | the fourth `installPrefSync` setting (`room.skins { skins }`) |
| `public/js/main.js` | boot | `installSkinsSync({ net })` |
| `public/js/ui/settings.js` | `CosmeticSection` | the 显示其他玩家的皮肤 switch — with or without a cosmetic plugin |
| `public/js/ui/gameLogic/settings.js` | `DEFAULT_SETTINGS`, `sanitizeSettings` | `otherSkins: true` |
| `public/js/ui/fieldHost.js` | mount, store subscription, `OPTIONAL` | `view.setMe` and `view.setSkins` adopt and follow local identity / public seat choices; unmount removes the subscription |
| `public/css/screens/loadout.css` | end | `.lo-skins` / `.lo-skin*` tiles, `.lo-skin-preview` |
| `public/js/ui/skinPicker.js` | header | `onChange(chessId)` after every pick (the screens that draw the art cannot all subscribe), and the optional `io` prop — 导出 / 导入 beside the 皮肤 label (`skin-io-export` / `skin-io-import`) |
| `public/js/screens/loadout.js` | `Detail`, `OpCard`, the io block and modal | `usePortraitPick` on both art surfaces, drawn through `shopPortraitUrl`; `onSkinIO` handed to `Detail` and `DiyPanel`; `kind: 'skins'` in the shared export/import modal (`skinTransfer.js`), no readiness gate on apply |
| `public/js/screens/diy.js` | `SlotCard`, `DiyPanel`, `DiyPanelView` | the card's art from `portraitFor(rec.chessId)`; a 皮肤 button per slot (`diy-skin`) opening `diy-skin-panel` for that one slot; `onSkinChange` redraws the tab after a pick (its views get no hook dispatcher) |
| `public/js/ui/loadoutModel.js`, `public/js/ui/diyModel.js` | `exportPayload`, `exportDiy` | `skins` / `portraits` dropped from both export envelopes; the parsers still return them for a file written before 0.3.2 |
| `public/js/ui/skins.js` | `portraitFor`, `usePortraitPick` | the read the two 干员调配 surfaces subscribe with (`useStore` on one key) |
| `public/css/screens/loadout.css` | picker block | `.lo-skin__io` (the two header buttons), `.diy-skin*` (one slot's section) |
| `public/i18n/*.json` | — | the strings above, in every pack (`node tools/i18n.mjs check --all --strict`) |

## Invariants

- **No `cs`.** An appearance is never part of a room's content set: it changes nothing a battle does, so no battle
  identity moves for it (docs/PLUGINS.md §6).
- **No `server/sim/` rule.** The sim carries `skin` as opaque data (`Unit.skin` → `unitInfo().skin`); no rule reads it
  (`server/sim/units.js` stores it, `battle/players.js` copies it onto the ally, `snapshot.js` publishes it). The same
  seeded battle run with and without a skin returns the same `Battle.result()` (`test/skins.test.js`), and
  `test/golden/*.json` is unchanged. `skin` is listed with the sim fields in `docs/design/engine.md` §5.2 and
  `docs/SIM.md` §2 as display-only.
- **No `data/` write.** Nothing in this feature writes a data file; a plugin's own files are served from
  `plugins/<id>/` under `/p/<id>/<hash>/…` (docs/PLUGINS.md §9).
- **No game art in git.** As ever: skin art belongs to a plugin (or to a locally extracted client), never to this
  repository.
- **A bad map is refused whole.** `isSkinSelection` / `validateC2S` (`room.skins`), the lobby (`freezeSkins` / `skins()`)
  and `PlayerState.setSkins` all require a plain object, a charId key (`isCharId`: official `char_<digits>_<token>` or
  a plugin `char_x_…`, never a chess id) and a skinId value (`isSkinId`). An array, a null-prototype object, one bad
  key or value, or more than 256 entries [ASSUMED] is BAD_MSG and does **not** clear a choice already stored. A charId
  the room's content does not have (`operatorCharIds`: chess records, `backups.units`, `diy.ownedPool`,
  `diy.operators`) is dropped and the rest kept, so the stored map is at most that operator count. An unknown skinId
  of an operator the room does have still draws the default model (`spineEntry`).
- **The client never sends more than the wire accepts.** `SKIN_LIMITS.entries` (256 [ASSUMED]) is applied in
  `public/js/ui/skins.js parseStoredSkins`, the one place a stored selection is read — the store's initial state, every
  edit and the `room.skins` payload the sync prepares. The limit has to be honoured there because an over-long map is not
  trimmed entry by entry on the server: `isSkinSelection` refuses the WHOLE message (BAD_MSG), so nothing would be stored
  and the sync would sit in `error` (public/js/ui/loadoutSync.js `installPrefSync`) instead of saving the rest.
- **A tile never outgrows the panel it sits in.** `.lo-skins` is `repeat(5, minmax(0, 1fr))` (three columns below 900 px,
  where the detail panel is a whole phone width — or a narrow window — and tall enough for the 1:2 box), so a tile is a
  share of the detail panel and its size never moves with how many skins an operator has. The tile draws the appearance's
  1:2 portrait, and on a panel too short for that box it draws the same appearance's 1:1 `avatar` instead —
  `@media (max-width: 1000px) and (max-height: 520px)` at the end of the picker's block in
  `public/css/screens/loadout.css`. That query is a phone in landscape: its detail panel is 193–263 px tall (measured
  740×360 … 932×430) while the 1:2 tile is 264–379 px there, which made 皮肤 the ONE section of that panel a phone could
  not see whole (潜能与练度 / 技能 / 局内数值 / 模组 are 135–163 px in the same panel). Both images of a tile are in the DOM
  (`public/js/ui/skinPicker.js`, `availableSkins().avatar`) and CSS alone decides, so no resize listener and no re-render;
  273/273 of the installed skins ship an `avatar` of their own (measured), and a row whose manifest has none keeps its
  portrait on every screen. A 1:2 box is still what every wider panel draws, with `min-height: max(1.5rem, 130px)` as
  the floor of a narrow one. Portrait is not a case to solve: a portrait phone is covered by 「请将设备横屏」
  (`public/index.html .rotate-hint`, shown by `public/css/theme.css`
  `@media (orientation: portrait) and (max-width: 1024px) { .sp-rotatable .rotate-hint { display: grid } }` for the
  `sp-rotatable` that `public/js/ui/device.js` sets on a coarse pointer whose screen is not landscape).

## Known limitations

- **Bots always wear the default model** (`PlayerState.setSkins` refuses a bot, as `setLoadout` does).
- **The studio does not list skins.** It finds an operator, an enemy or an interface picture by its official name
  (`server/studio/targets.js`), so a skin key is copied from the installation's manifest or written in the stem form.
- **No skin effects and no operator voices** (a separate piece of work; docs/ASSETS.md).
- **A 自选 slot's own record has `charId: null`**, so it wears its **pick's** operator's skin — the slot has no body of
  its own. The picker offers the appearance while picking that operator, and the choice is kept per operator, so
  changing the slot's operator changes the appearance with it.
