# 干员皮肤 (Operator skins)

> **来源 / Provenance.** This document, and the feature it describes, are ported from
> [sganggs/Stronghold-Protocol PR #652](https://github.com/sganggs/Stronghold-Protocol/pull/652) by **@alien-zzy**
> (11 commits, upstream 0.2.7-dev). Everything below the next heading is that PR's own note; the changes this fork
> needed to land it are in [移植说明](#移植说明-this-fork) at the end.

An operator's Spine model and avatar can be replaced by one of its official alternative outfits (时装). Written to
be **portable**: nearly everything lives in new files, and the handful of edits to existing ones are listed below
line by line so they can be re-applied after merging an upstream release.

> Line numbers are as of the commit that added this document and will drift. The anchor (the enclosing function or
> section) is the durable part.

## How it works

```
docs/research/08-skins.json        what EXISTS upstream (174 skins / 115 operators) — a static list, like the other
        │                          research tables; never fetched at build time
        ├── tools/build-skins.mjs ──→ data/skins.json          the catalogue the CLIENT reads: id, name, series.
        │                                                      No URLs — an uninstalled skin has no files to point at.
        │
        └── tools/install-skins.mjs  downloads ONE skin on demand (8 files: Front/Back skel+atlas+png, the 180×180
                 │                   avatar and the 180×360 立绘) and splices it into
                 │                   data/assets.json + data/skins-installed.json
                 │
                 └── server/skinInstall.js   the in-game 「安装」 button, queued (the same work, imported)
                                              │
                     data/assets.json ────────┴──→ chars[charId].skins[skinId] = { spine:{front,back?}, avatar, portrait, name, group }

player picks a battle model ──→ room.skins ──→ PlayerState.skins ──→ Match.publicView().players[].skins   (PUBLIC: teammates see it)
                                              │
                                              └── battleInput() u.skin ──→ snapshot ──→ renderer ──→ spineEntry(m, id, {skin})

player picks a 商店立绘 ──→ localStorage only (never leaves the browser) ──→ ui/assetUrls.js skinPortraitUrl ──→ the shop card
```

Three properties are load-bearing:

- **Skins are installed on demand, never wholesale.** All 174 are ~190 MB, and the upstream link measured ~35 KB/s
  from a mainland China line — a full set would be over an hour. `data/skins-installed.json` starts empty and only
  `tools/install-skins.mjs` adds to it, so a fresh clone downloads no skins at all.
- **The skin *choice* is keyed by chess id; the skin *catalogue* and the asset manifest are keyed by operator id.**
  A chess record is `chess_char_1_01_a` and carries `charId: char_498_inside`. Mixing the two is silent: the picker
  renders an empty section and `setSkins` drops every entry.
- **A skin model must go through the build-time spine pipeline.** `resolveRoles()` runs offline in
  `tools/assets/spine.mjs`, and the client's `validSpine()` requires the `anims` it produces. A model that skipped
  that step fails to load and leaves the unit on its placeholder avatar forever — invisible until someone looks at
  the board. `installSkins()` therefore builds its models through the same `fexliModelDef()` the full plan uses.

## New files

| Path | What |
|---|---|
| `docs/research/08-skins.json` | Static research table: `{ meta, skins: { [charId]: [{ skinId, stem, name, group, avatar, battleSpine }] } }` |
| `tools/build-skins.mjs` | `docs/research/08-skins.json` → `data/skins.json` |
| `tools/install-skins.mjs` | Install/uninstall skins on demand; `list` / `add` / `remove` / `add-char`. Also the library `server/skinInstall.js` imports |
| `server/skinInstall.js` | Serialised background install queue: why it is queued, why it is never awaited (8 s client timeout) |
| `data/skins.json` | The client's catalogue (no URLs) |
| `data/skins-installed.json` | Which skin ids are installed — the single source of truth the build reads |
| `public/js/ui/skins.js` | Client store + `room.skins` sync + install requests + manifest reload on `skins.changed` |
| `public/js/ui/skinPicker.js` | The 皮肤 section of 干员调配 (self-contained: `screens/loadout.js` only names it) |
| `test/skins.test.js`, `test/skins-protocol.test.js`, `test/skins-lifecycle.test.js`, `test/skins-portrait.test.js`, `test/ui/skins.e2e.test.js` | Lookup, wire format, the lobby→Match→sim→render path, the local 商店立绘 choice, the real-browser picker |

## Edits to existing files

| File | Where | What |
|---|---|---|
| `shared/protocol.js` | before `isLoadoutEntries` | `SKIN_LIMITS`, `isSkinId`, `isSkinSelection`. **`isSkinId` cannot be `isId`**: that allows only `[A-Za-z0-9_\-.:]` and skin ids carry `@` and `#` |
| `shared/protocol.js` | `C2S` table | `'room.skins'` and `'room.skin.install'` |
| `server/net.js` | `HEAVY_TYPES` | `'room.skins'`, `'room.skin.install'` |
| `server/net.js` | `Session` ctor | `this.skins = null` |
| `server/lobby.js` | import | `installSkinInBackground` |
| `server/lobby.js` | after `freezeLoadout` | `freezeSkins()` — the same gate as `checkLoadout` (`isGolden` / `visible === false` / `isHidden` / `isDiy` / `baseId !== id`) |
| `server/lobby.js` | `onMessage` | `case 'room.skins'` / `case 'room.skin.install'` |
| `server/lobby.js` | after `loadout()` | `skins()` — no phase gate (unlike the loadout: a skin is cosmetic and public) — and `skinInstall()`, which acknowledges at once and broadcasts `skins.changed` to **every** session on completion |
| `server/lobby.js` | `humanSeat()` & `startMatch()` | passes `skins` from session to seat and from room seats to `new Match()` |
| `server/match/Match.js` | after `setLoadout` | `setSkins()` — any phase, `markPublic()` |
| `server/match/Match.js` | `publicView().players[]` | `...(Object.keys(ps.skins).length ? { skins: ps.skins } : {})` — omitted when empty, so the payload is unchanged for players with no skins |
| `server/match/Match.js` | prep view units | `skin: ps.skins?.[rec?.baseId || piece.id] || ps.skins?.[piece.id]` — supports both base and golden/promoted pieces |
| `server/match/PlayerState.js` | ctor | `this.skins = Object.freeze({})` + restore from `seat.skins` |
| `server/match/PlayerState.js` | after `setLoadout` | `setSkins()` — bots refused, same gate as above, calls `this.dirty()` |
| `server/match/PlayerState.js` | `battleInput()` | `const baseId = (rec && rec.baseId) || piece.id; const skin = this.skins[baseId] || this.skins[piece.id]; if (skin) u.skin = skin;` — preserves skin when upgraded to golden |
| `server/match/PlayerState.js` | `pieceView()` | includes `skin` on prep board/hand/temp piece views |
| `server/sim/snapshot.js` | `unitInfo()` | `skin: u.skin ?? undefined` — **`undefined`, not `null`**: `JSON.stringify` drops it, so the `DESIGN §8.2` wire-format contract test still passes and an install with no skins is byte-identical to before |
| `public/js/assets.js` | `spineEntry()` | `opts.skin` → `chars[id].skins[id].spine`, else the operator's own model |
| `public/js/assets.js` | `avatarUrl()` & `hasBackSpine()` | supports `opts.skin` for avatar; `hasBack(id, skinId)` forwards skin |
| `public/js/render/units.js` | `_loadSpine()` & `_loadPicture()` | passes `skin: this.info.skin` to spine and avatar diamond fallback |
| `public/js/render/units.js` | `_wantsBack()` | asks `hasBack(id, this.info.skin)` |
| `public/js/render/app.js` | `pieceInfo()` and `addInfo()` | `skin: piece.skin ?? skinFor(baseId) ?? null` / `skin: u.skin ?? null`; `sig` includes `skin` to drop cache on switch |
| `public/js/data.js` | `DATA_FILES` | `skins: 'skins.json'` |
| `public/js/ui/gameComponents.js` | `GAME_FILES` | `'skins'` — `test/ui/playtest3.test.js` requires every file the in-match UI reads to be awaited by the match screen, and 干员调配 is reachable during a match |
| `public/js/screens/loadout.js` | imports + `Detail()` | import `SkinSection`, then `<${SkinSection} chess=${chess} />`. **Two lines** — the section itself is entirely in `ui/skinPicker.js` |
| `public/js/main.js` | imports + boot | `installSkinsSync({ net })` |
| `public/css/screens/loadout.css` | end | `.lo-skins` / `.lo-skin` tiles (mirrors `.lo-mods`) |
| `public/js/ui/skins.js` | `portraits` | the local 商店立绘 map: its own preference (`PORTRAITS_PREF`), `setPortrait` / `clearPortrait` / `portraitFor`, never part of the synced `entries` |
| `public/js/ui/skinPicker.js` | `SkinGroup` | the section renders TWO groups — 战斗模型 (synced) and 商店立绘 (local) — from one tile component |
| `public/js/ui/assetUrls.js` | `skinPortraitUrl()` | `chars[charId].skins[skinId].portrait`, else null (the card keeps `chessPortraitUrl`) |
| `public/js/ui/shopBar.js` | `ChessCard()` | the card's art is the chosen 立绘. Read from the store **without a hook**: the UI tests call `ChessCard` as a plain function |
| `public/js/ui/detailPanel.js` | `ChessDetail()` | the same art on the card a shop tap opens (a stand-in shows its own operator, never a skin) |
| `data/assets.json` | — | regenerated; carries `chars[charId].skins` for whatever is installed |

### 离线预载 (offline preload, this fork)

Not part of upstream's PR: a full install is ~328 MiB, and the preload manifest is built by walking `data/assets.json`
— so every skin file landed in the **required** tier of `/data/resource-manifest.json` and 「必备资源」 quietly meant
one third of a gigabyte. Skins are now their own optional scope with **one switch**: 「预载我选的皮肤」. When it is on,
the preload follows the outfits equipped in 干员调配 (either row — they are one choice now) — picking one there downloads its files into Cache Storage, which
is what a player actually wants (the choice list is where you make the choice). Nothing is downloaded by default.

| File | Where | What |
|---|---|---|
| `server/resources.js` | `skinKeyForPath()` + `tierForPath()` | a key path through `chars.<charId>.skins.<skinId>…` is tier 2 (`TIER_REST`) and carries `skin: '<charId>/<skinId>'` into the manifest entry — the one field the client groups and scopes by |
| `public/js/resources/common.js` | `RESOURCE_GROUPS` / `resourceGroup()` | `skin: { name: N_('干员皮肤'), tier: TIER_REST }`; `resourceGroup()` returns `'skin'` for a marked entry; `SKIN_KEY_RE` / `isSkinKey` validate the key |
| `public/js/resources/store.js` | `setScope()` / `skinWanted()` / `#tally()` | the voice language and the equipped skins are one selection: unequipped skins leave `selectedFiles`, so they are neither downloaded nor counted (but stay importable/retained); `status()` also reports per-outfit counters (`skins: [{ id, files, wanted, present, bytes, totalBytes }]`) |
| `public/js/ui/skins.js` | `equippedSkinKeys()` / `loadEquippedSkinKeys()` | the equipped outfits as `charId/skinId` keys — **both rows** of the picker (battle model and 商店立绘; the art-only 原始/精英二 values name no outfit), chessId → charId through the chess table, which is why the helper waits for it |
| `public/js/main.js` | `installResourcePreload()` | the switch is `settings.preloadSkins`; the scope is recomputed from the equipped keys and re-applied whenever `skinsStore` or the settings change — that is the auto-download |
| `public/js/resources/index.js` | `syncResources(…, skins)` | the controller applies the scope; the optional pass runs whenever the selection contains tier-2 files (「同时预载」 **or** equipped skins), so a skin choice never drags the voices in and vice versa. `requiredComplete` / `selectionComplete` split what the panel words 「必备已保存」 / 「全部已保存」 |
| `public/js/ui/resourcePanel.js` | `ResourceSkins()` | the compact row: 干员皮肤 + the switch + `本机已选 N 套 · 已缓存 M 套` + bytes. Outside the 可选资源 list (`g.id !== 'skin'`), and the whole row disappears when the deployment has no skins |
| `public/js/ui/gameLogic/settings.js` | `DEFAULT_SETTINGS` / `sanitizeSettings()` | `preloadSkins: false` — one boolean, no id list to validate |
| `public/css/components.css` | end of the resource block | `.resource-skins*`, rem/`--utility-text` based like the rest of the manager |
| `test/resources/{manifest,store,index,panel}.test.js` | — | classification and the key, the scope engine, the controller end to end, the panel wiring |

安装 (server-side, everyone shares) and 预载 (this browser's cache) stay separate: the preload list is built from the
manifest, so it only ever offers skins the server actually has, and a skin that is installed but never equipped costs
nothing until it is used.

## Regenerating the asset side

```
node tools/build-skins.mjs                                   # docs/research/08-skins.json → data/skins.json
node tools/install-skins.mjs list [text]                     # what exists / what is installed
node tools/install-skins.mjs add <skinId…>                   # install (resumable; safe to interrupt)
node tools/install-skins.mjs add-char <charId…>              # every skin of those operators
node tools/install-skins.mjs remove <skinId…>                # uninstall (files stay on disk)
npm run assets                                               # rebuilds the manifest from the selection file
```

`tools/fetch-assets.mjs` only builds the skins listed in `data/skins-installed.json`, so a full run never
re-downloads one that was uninstalled **and** removes it from the manifest — matching what the installer writes.

Upstream sources: `fexli/ArknightsResource` (`spine/{charId}/{stem}/{Front,Back}/`, or `…/{stem}/Spine/` for the outfits that ship one merged model — see meta.layoutRule) for the models,
`yuanyan3060/ArknightsGameResource` (`avatar/{avatarId}.png`) for the 180×180 thumbnails, and Kengxxiao's
`skin_table.json` for the names and series. Two naming rules, both verified:

```
stem   = skinId.replace(/@/g, '_').replace(/#/g, '_')      char_002_amiya@winter#1 → char_002_amiya_winter_1
avatar = 'avatar/' + encodeURIComponent(avatarId) + '.png'  avatarId comes from skin_table, NOT from the skinId
```

The full skin art (`skin/{portraitId}b.png`) is deliberately **not** used: at ~2.5 MB each it would add ~435 MB,
more than the entire rest of the asset set, for a thumbnail.

## 商店立绘 (the shop card's art, local only)

A second, independent choice per operator: which **180×360 立绘** the shop card and the operator detail card draw.
It is deliberately not part of the skin sync — the shop is private to the browser showing it, so the choice lives in
its own preference (`sp.pref.skinPortraits`, `ui/skins.js`) and never reaches the server, the match or a teammate.

- Three kinds of option, all shown as their own art so the choice is a comparison rather than a guess:
  **原始立绘** (the operator's `_1` art — this is the "no choice" value), **精英二立绘** (the `_2` art; hidden for a
  1★/2★ operator that has none), and every **skin's 立绘**. `shopPortraitUrl()` (`ui/assetUrls.js`) resolves them,
  with the sentinel `PORTRAIT_E2` (`'e2'`) for the E2 tile — every real skinId starts with `char_`, so the two cannot
  collide, and anything unknown falls back to the operator's own portrait rather than leaving a card blank.
- **One pick sets both rows** (this fork): choosing an outfit as the battle model also puts its 立绘 on the card, and
  choosing an outfit's 立绘 also makes it the battle model — otherwise the same outfit would have to be chosen twice.
  They can still be deliberately different: the model row's 默认 clears the model and leaves the art, and the two
  art-only tiles (原始立绘 / 精英二立绘) never touch the model. A *bulk* write (`setSkins` / `setPortraits`, i.e. the
  `room.skins` roster sync and imports) owns one map each, so a restore or a teammate's data can never overwrite the
  local art.
- The file is the tall 立绘 of the same source repo, derived from the avatar URL rather than stored in the research
  table: `…/avatar/char_x_kitchen#2.png` → `…/portrait/char_x_kitchen#2.png`
  (`tools/assets/plan.mjs` `skinPortraitUrl()`, shared with the installer). ~90 KB per skin, downloaded together with
  the avatar, so the installer's expected file count is eight.
- A skin the source has no 立绘 for is not an error: the install logs it and the card keeps the operator's own
  portrait (`ui/assetUrls.js` `skinPortraitUrl()` returns null → the fallback chain above).
- Where it shows: the shop card (`ui/shopBar.js` ChessCard) and the operator detail card it opens
  (`ui/detailPanel.js` ChessDetail). Both read the store **without a hook** — the UI tests render those components by
  calling them as plain functions.

### 小人预览：实时播放 (render/spinePreview.js)

The section lists **商店立绘 first, then 战斗模型, then the preview frame**. The 战斗模型 tiles are **text only**, and
the model itself is **played live** in the frame below them, with one button per animation the model actually ships.

- **Live, not a GIF.** `mountPreview()` puts the skeleton in the shared PIXI renderer and steps it with
  `requestAnimationFrame` — the same `ensurePixi()` + `assets.spine` + `SpineActor`-style path the battlefield draws,
  so what the frame shows IS what a deploy shows. A pre-rendered GIF of one clip measured **~360 KB** at 256 px
  (30 frames, transparent; 128 px ≈ 140 KB) — ~1.1 MB per skin over three clips, ~190 MB over the catalogue, all of
  it extra files every client would fetch, and none of it 60 fps. Live playback costs **0 extra bytes**: the model
  files are the ones a battle already pulls, from the HTTP cache.
- **Buttons follow the skeleton, not a list.** `clipsOf(m, assetId, skinId)` collects one entry per animation the
  model actually has: 部署 / 待机 / 攻击 / 攻击·下 / 技能1…n / 眩晕 / 移动 / 死亡 — 部署 / 待机 / 攻击 and up to three
  skills stay on screen, the rest fold behind a 更多动画 toggle — and only from THREE extras on: with one or two the row is shorter than the toggle would be, so they stay inline and no toggle appears. Three sources, on purpose:
  - the manifest's `anims` roles (the same roles the battlefield plays),
  - **the skeleton's own clip names**, via `skillFamilies()`: `Skill_1` / `Skill1` / `Skill_01` (a one-clip skill) and
    `Skill_<n>_Begin/_Loop/_End`, merged with the roles by index. Directional (`Skill_Right_Loop`) and prone
    (`Skill_Down_2`) variants are not families of their own. This source matters because the manifest only resolves
    the skills a mode *uses* — `skillIndicesByChar()` turns the pool's `defaultSkillIndex` into a per-operator list,
    so 锏's model (Skill_1, Skill_2 and a Skill_3_Begin/Loop/End trio) came back with index 2 alone and her preview
    offered a single 技能 button. With the scan she shows three, as do 浊心斯卡蒂's outfits.
  - **one entry per remaining clip**: stance and variant clips no role points at (锏: Default, Skill_2_B, Skill_Down_2,
    Skill_Down_2_B; 隐现: Attack_Idle, Skill_1_Idle, …) get a `raw` button labelled with the clip's own name, so a
    13-clip skeleton offers buttons that between them reach all 13 — `total` and the buttons agree.
  Each button plays the real sequence (an attack is `Attack_Begin → Attack_Loop ×2 → Attack_End → Idle`; a one-clip
  skill casts once and returns to 待机; 死亡 stops on its last frame) and carries the underlying clip names as its
  tooltip. The caption names the animation being played and counts every clip in the skeleton (隐现: 19).
  ⚠️ The same gap is visible in battle: picking S1/S2 for 锏 makes the renderer fall back to `roles.skill` (her S3),
  so the wrong animation plays. Fixing that means changing what the manifest resolves, which is a separate concern
  from this feature.
- **A static snapshot still exists**: a 256 px PNG (`previewState` / `requestPreview`) is the instant first paint and
  the fallback when WebGL is unavailable.
- Two traps that cost real debugging, both worth remembering:
  - ⚠️ **Never call `updateTransform()` before `getLocalBounds()`** on a freshly built pixi-spine actor: it leaves the
    bounds cache empty, the rect comes back 0×0, and the manifest's union `bounds` (≈1200 px wide for a 300 px idle
    pose) take over — the model shrinks to a speck, which is exactly what the first version did.
  - ⚠️ **The renderer has ONE canvas.** So (a) the frame's box keeps a CONSTANT vdom shape — an art layer plus a mount
    layer — because an `img ↔ null` flip makes Preact re-diff the children and wipe the appended canvas, and (b)
    `mountPreview()` takes `isCancelled` and checks it before attaching: a mount that resolves after its caller moved
    on (the player switched operator or skin while the skeleton loaded) would otherwise move the canvas into a DOM
    node that is already gone, leaving the visible frame empty.
- A model that fails to load (the two missing upstream skins above, a pixi failure, no WebGL at all) keeps the static
  frame and adds 模型不可用 to the caption — the section is never blocked.
- `test/spine-preview.test.js` pins the headless half (cache, request dedup, degradation); the real rasterisation is
  covered by `test/ui/skins.e2e.test.js`, which needs `SP_E2E=1` + Chrome and is the only place a pixi/pixi-spine API
  drift would show up.

### 自选编队 (screens/diy.js)

A 自选 pick wears skins like any roster operator, and the whole pipeline is keyed by the SLOT: the picker panel opens
from the slot card's 皮肤 button (one slot at a time — the preview renderer has a single canvas), the choice is stored
under the slot's base id (), and that is the id every server side reads:  gates on
isDiy + baseId (a slot's `visible` is false by design — it is never sold as itself — so the visibility flags do not
apply to it),  /  look the skin up by the piece's baseId, and the composed record's
`charId` is what spineEntry resolves. A golden slot form is refused like every elite.

A slot's choice names a skin of the operator PICKED for it, so the client drops both choices (model + 商店立绘)
when the pick changes to a different operator or the slot is cleared (ui/skins.js syncDiySkins) — a stale id would
silently fall back to the default model while still looking chosen. The 导出 / 导入 envelopes carry the choices:/na 自选编队 file holds its slots' skins / portraits (keyed by slot id, applied to the slots whose pick survived), a
干员调配 file the roster's (keyed by chess id) — neither claims the other's keys, so importing one leaves the other
half alone; absent fields mean an older export and leave the current settings untouched.

⚠️ Today the 自选 pool and the skin catalogue do not intersect (the catalogue covers the shop-pool operators; the
自选 pool is the operators OUTSIDE it), so a pick's section offers 原始 / 精英二 立绘 and its default model only.
The pipeline is ready for the day the catalogue grows: nothing about a slot is special beyond its key.

## Known limitations

- **No skin effects.** The official per-character battle effects are `.ab` particle bundles that the project does
  not extract (`docs/ASSETS.md`); battle FX stay procedural.
- **No operator voices.** A separate piece of work; the files exist (`ArknightsAssets2`, `voice` branch) but there
  is no event→line mapping or playback path yet.
- **Bots always wear the default model** (`setSkins` refuses bots, as `setLoadout` does).
- **Uninstalling leaves the files on disk.** They are shared between skins and a reinstall would only fetch them
  again; `npm run assets --prune` clears the orphans.
- **Docker images cannot install.** The runtime stage of the `Dockerfile` copies `server/`, `shared/`, `data/`,
  `public/` and `docs/research/` but not `tools/`, which `server/skinInstall.js` imports on demand. Add `tools/` to
  that stage if the in-game button should work there.
- **Some outfits ship ONE model under `Spine/`, not a `Front`/`Back` pair.** A model's files normally live at
  `spine/{charId}/{stem}/{Front,Back}/<stem>.<ext>`; two outfits (`char_1012_skadi2@boc#4`, `@iteration#2`) instead
  have a single `spine/{charId}/{stem}/Spine/<stem>.{skel,atlas,png}`. Their `{Front,Back}` paths 404, which is what
  the first install run hit — the resources were always there, the URL shape was wrong. Both are recorded as `front`
  with no `back` (one direction only, so a unit facing up draws the same model). `docs/research/08-skins.json`'s
  `meta.layoutRule` says so; a future skin in that shape needs the same treatment.
- **An install is tens of seconds, not instant.** The eight files come from GitHub at the link's speed; the panel
  acknowledges immediately and reports back through `skins.changed`.

## 移植说明 (this fork)

What had to change to land PR #652 in this fork. Every row was a red test, a broken screen or a swallowed click
before it — none of them is a preference.

| Where | What | Why |
|---|---|---|
| `server/lobby.js` → `startMatchWith` | the checkpoint-restore seat mapping carries `skins` as well | this fork rebuilds a reclaimed match from a checkpoint's captured player records; without the field a restored match silently reverts every player to the default model |
| `public/css/screens/loadout.css` | the section's font sizes are `max(calc(N * var(--utility-text, var(--t))), Mpx)` | this fork's compact-layer text contract (`test/ui/utility-mobile.test.js`); upstream's rules read `--t` alone |
| `server/match/snapshot.js` | `skins` is classified in `PLAYER_FIELDS` (persisted), not with the transient fields | `test/match/snapshot.test.js` requires every new Match / PlayerState field to declare a persistence policy, and a transient `skins` would drop the choice on every restore |
| `public/js/ui/skinPicker.js` | the two `<img>` templates take `crossorigin="anonymous"` before `src` + `recoverImageError` | this fork's DOM image rule (`test/ui/image-policy.test.js`); the frame keeps ONE constant child shape, or Preact re-diffs the box and takes the live canvas with it |
| `tools/README.md`, `tools/package.mjs` | both new tools listed in the tools README; `docs/SKINS.md` in `PLAYER_DOCS`, `docs/research/08-skins.json` in `RUNTIME_RESEARCH` | this fork ships its docs under `docs/guides/` + `docs/operations/` and has no `docs/DEPLOY.md` (upstream's lists name it) |
| `public/i18n/{ja,ko,zh-TW}.json` | the 35 new msgids translated | this fork ships four language packs and the three non-English ones declare themselves complete |
| `test/skins-lifecycle.test.js` | the lobby fixture builds a real `SessionRegistry` | this fork's lobby calls `registry.byId()` and the room limiter reads `session.limitKey`, so upstream's `{ byId: new Map() }` stub throws |
| `test/ui/skins.e2e.test.js` | dismisses the 全屏游玩 prompt, and opens 干员调配 only while the overlay is closed | a fork-only entry overlay sits above the lobby and swallows the first physical click; the entry button is hidden while the overlay is open |

Data side (unchanged from upstream's design): `data/skins-installed.json` ships empty, and each deployment installs
what it wants — `node tools/install-skins.mjs add <skinId…>` / `add-char <charId…>`. The upstream link is slow from a
mainland line; through a local proxy the whole 273-skin catalogue is minutes rather than an hour, provided the process
is started with `NODE_USE_ENV_PROXY=1` (`tools/assets/env-proxy.mjs` explains why that has to be at startup).
