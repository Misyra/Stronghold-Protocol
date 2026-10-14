# 干员皮肤 (Operator skins)

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

Upstream sources: `fexli/ArknightsResource` (`spine/{charId}/{stem}/{Front,Back}/`) for the models,
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
- Independent of the battle model on purpose: fight with the operator's default model and still show a skin on the
  card, or the other way round.
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
- **Buttons follow the model, not a list.** `clipsOf(m, assetId, skinId)` reads the manifest's `anims` roles — the
  same roles the battlefield plays — and returns one entry per animation that exists: 部署 / 待机 / 攻击 / 攻击·下 /
  技能1…n / 眩晕 / 移动 / 死亡. It differs per skin (隐现's own model ships two skills, its 罗德厨房 skin only one),
  which is exactly why it is derived rather than hardcoded. Each button plays the real sequence (an attack is
  `Attack_Begin → Attack_Loop ×2 → Attack_End → Idle`; 死亡 stops on its last frame) and carries the underlying clip
  names as its tooltip. The caption counts every clip in the skeleton (隐现: 19), stance variants included.
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
- **Two skins have no model upstream.** `char_1012_skadi2@boc#4` and `char_1012_skadi2@iteration#2` (斯卡蒂)
  404 in `fexli/ArknightsResource` — verified 2026-10-14, both skel and atlas, while other skins in the same repo
  answer 200. The installer reports them as failed, the picker keeps showing 未安装 · 点击安装 and the unit falls
  back to the operator's default model. The other 172 install cleanly, so a catalogue of 174 skins yields 172
  installed (this checkout has all of them; `data/skins-installed.json` is the truth).
- **An install is tens of seconds, not instant.** The eight files come from GitHub at the link's speed; the panel
  acknowledges immediately and reports back through `skins.changed`.
