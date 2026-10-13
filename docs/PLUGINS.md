# PLUGINS.md — plugins (插件)

A **plugin** is a folder a server owner puts into `plugins/`: a manifest, `plugins/<id>/plugin.json`, next to the files
it names. The interface calls them 「插件」, never 「模组」 (that word is the operators' modules). The design and its
phases are DESIGN §32 (`docs/history/0.3.0.md`); this file is the reference.

**Status — 0.3.0-dev, P1c: rooms play content sets.** The server finds, checks and lists plugins and names its content
with a hash (P0); a room's host switches the server's cosmetic plugins on for the whole room, a player switches them on
for themself (§9) — art, models and audio only: the battles stay the original ones and a room's `cs` stays the vanilla
one. Language packs (`docs/PACKS.md`) are the plugin class `lang` and work as before. Data plugins (§10) build
validated content sets, and a room's host switches them on for the room (§11, P1c): the room plays a content set of its
own, named by its own `cs`, which every member's page downloads and checks and whose matches run in a match host of
their own — unofficial matches. P4 adds interface plugins (§14): a page in a sandboxed frame, switched on in this
browser, read-only, never a match intent, and not an input of `cs`.

| File | Role |
|---|---|
| `shared/plugins/manifest.js` | the format: manifest 2 (`plugin.json`), manifest 1 (`pack.json` / `_meta`), the classes, permissions, file rules, limits, the catalogue entries |
| `shared/plugins/identity.js` | the content hash `cs`: canonical JSON and its composition |
| `shared/plugins/visual.js` | a cosmetic plugin's asset overlay (§9): reading and checking it, references, resolution to served URLs, the merge with its override warnings, the visual hash `vs`, the browser's check of a visual set |
| `shared/plugins/order.js` | which plugins a set holds and in what order: requirements, conflicts, load-order hints, priority, id |
| `shared/plugins/ui.js` | the interface-plugin bridge (§14): the postMessage shapes, the rate and storage limits, the public and private subsets, the frame URL |
| `public/js/ui/uiPlugins.js` | this browser's interface-plugin switches and the host's recommendations (localStorage) |
| `public/js/ui/pluginFrame.js` | the sandboxed iframes, the slots, the read-only feed |
| `plugins/_template/ui/` | the interface-plugin template: a damage tally |
| `schemas/ui.schema.json` | the plugin→host messages (C7) |
| `shared/sha256.js` | SHA-256 in plain JavaScript (the same digest in Node and every browser, no `crypto.subtle`) |
| `server/plugins/registry.js` | the registry: the language folders, `packs/` and `plugins/` — discovery, validation (a cosmetic plugin's overlay too, its files hashed), `/packs/index.json`, `/plugins/index.json`, what may be served |
| `server/plugins/identity.js` | this server's vanilla content and its `cs`, the manifest at `/cs/<cs16>/index.json` |
| `shared/plugins/patch.js`, `records.js`, `validate.js` | pure patches, compact records and merged-data validation (§10) |
| `server/plugins/contentSet.js` | C1 content compositions, immutable byte files, modes and the gameplay hash (§10) |
| `server/plugins/visualSet.js` | the visual sets: a room's (or a player's) cosmetic plugins as one set named by `vs`, served at `/vs/<vs16>/overlay.json` (the composition and each plugin's writes, composed by the browser) |
| `server/packs.js`, `shared/packs.js` | the content-pack API of 0.2.0, kept (compatibility export; the language-pack index) |
| `public/js/content.js` | the browser: the room's visual set and the player's personal plugins, fetched, checked and laid over the art manifest |
| `public/js/cosmetics.js` | the cosmetic layers every screen draws through (small: the title page carries it; `shared/plugins/visual.js` loads with the first set) |
| `public/js/ui/pluginTag.js` | the room's 插件 tag and the small facts the screens show (the panel loads when the tag is tapped) |
| `public/js/ui/pluginPanel.js` | the room's 插件 panel and the title screen's list of the server's plugins — loaded when one opens |
| `tools/plugin.mjs` | `list`, `check`, `pack` |
| `server/plugins/roomSets.js`, `contentSets.js`, `policy.js`, `server/match/host/` | a room's content set, the match host of a content set and the server owner's `plugins/config.json` (§11) |
| `plugins/README.md`, `plugins/_template/` | the folder's readme and the templates (`cosmetic/`, `content/`, `ui/`) — the only tracked files of the folder |

## 1. Principles (the maintainer's decisions of 2026-10-12)

- **The original game is always the default.** A room plays the vanilla content unless its host chooses plugins (P1c);
  the golden results, DESIGN and the fidelity checks cover the original content only.
- **Plugins are marked unofficial** wherever they are shown — the catalogue (`unofficial: true` on every class but
  `lang`), the title screen (「本服务器安装了 N 个插件」), the room (「原版」 / 「插件 ×N」, the panel's 非官方 marks),
  the diagnostics (`content: … cosmetic vs=… plugins=…`, `MODDED …` for gameplay plugins), and with gameplay plugins
  the briefing, the HUD corner, the result and the statistics (such matches stay out of the overview by default; a match
  with cosmetic plugins only is still the original game — §9, §11).
- **No third-party code in a battle.** Art and data plugins carry no code, and the declarative DSL (§12) is data, not
  code. An interface plugin (P4, §14) is the one page that runs, and only inside a sandboxed iframe: it sees a
  read-only feed and cannot send a match intent. Classes `script` and `trusted` stay unsupported until P3 (trusted
  code only with the server owner's and every player's explicit consent, then a sandbox).
- **No plugin overrides arbitrary project files**; a plugin changes only what its class allows, through its manifest.
- **Gameplay plugins are installed on the server** (every player of a room plays the same content and the server can
  still check a battle). Players never install gameplay content of their own.
- **Never put official game files in a plugin**; a plugin refers to the art the installation already has.
- **Bug reports from a plugin room** go to the plugin's author first; please reproduce on the original content.

## 2. For server owners

Put the folder into `plugins/` (the id is the folder name). `node tools/plugin.mjs list` shows what the registry found,
by class, with what this version does with each, what was skipped and why; `node tools/plugin.mjs check` checks the
folders in depth. The server prints the same at start (`[plugins] …`) and notices a new or changed plugin on the next
page load — no restart. A server's own plugins are git-ignored (the folder's readme and templates are tracked and ship in the
release zips), never packed into a release and never touched by an update. One unreadable
folder is skipped with its reason; it never stops the server.

What this version does with each class:

| Class | Carries | This version |
|---|---|---|
| `lang` | a language: UI strings, optionally game texts | **loaded** — listed in `/packs/index.json`, files served at `/packs/<id>/<file>` |
| `cosmetic` | art, models (Spine 3.8), audio (fonts and theme colours later) | **loaded** (P1a, §9) — a room's host switches it on for the room, a player for themself; the files its overlay names served at `/p/<id>/<hash8>/<path>` |
| `content` | data patches and new records: numbers, economy, modes, waves, operators, enemies | **loaded** (P1b, §10; P1c, §11) — a room's host switches it on for the room: a content set of its own, unofficial matches; the set's files served at `/cs/<cs16>/…` |
| `script` | code the battle or the match runs | not supported: listed, never loaded |
| `ui` | an interface widget: an html page in a sandboxed frame | **loaded** (P4, §14) — a player switches it on for this browser; its frame files served at `/p/<id>/<hash8>/<path>` with a frame CSP |
| `trusted` | page or server code with full trust | not supported |

Nothing of a plugin folder is served except the files a `lang` manifest names, the files a loaded `cosmetic`
plugin's overlay names, and the frame files of a loaded `ui` plugin (`.html`, `.js`, `.css`, `.png` under its
`entry.client`, §14) — never `plugin.json`, the lock file, a document or any other file of the folder. A ui plugin's
`/p/` responses carry a frame Content-Security-Policy; cosmetic art does not.

What rooms may use is the server owner's choice: `plugins/config.json` (optional, git-ignored) lets every room's host
choose (the default), fixes one set for every room, or keeps rooms on the original game, and limits the plugins, the
classes and the content sets running at once — §11 and `docs/DEPLOY.md`.

## 3. The manifest (manifest 2)

```json
{
  "manifest": 2,
  "id": "marathon",
  "name": { "zh": "马拉松模式", "en": "Marathon" },
  "version": "0.1.0",
  "app": ">=0.3.0 <0.4.0",
  "api": 1,
  "class": "content",
  "scope": ["room"],
  "authors": ["…"],
  "license": "CC-BY-4.0",
  "settings": { "refresh": { "type": "integer", "min": 0, "max": 3, "default": 1, "label": { "zh": "刷新价格" } } },
  "permissions": ["data.patch", "data.add"],
  "data": ["data/economy.json"],
  "modes": ["modes/marathon.json"],
  "operators": ["operators/rosa.json"],
  "i18n": { "en": "i18n/en.json" }
}
```

| Field | Meaning |
|---|---|
| `manifest` | `2`, required (a `pack.json` without it is manifest 1, §7) |
| `id` | the folder name decides: `^[a-z0-9][a-z0-9-]{1,31}$` (it becomes part of record ids; lower case only); a different `id` in the file is a warning |
| `name`, `description` | a text in `sourceLang` or `{ "<lang>": "…" }`; `englishName` a text |
| `version` | semver, required |
| `app` | the game versions it is made for — `>=0.3.0 <0.4.0`, `0.3.x`, `^0.3.0` … (a pre-release counts as its release); required but for `lang`. Outside it: `compatible: false` and a warning (P1 refuses a gameplay plugin by default) |
| `api` | the plugin API level, within `shared/constants.js` `PLUGIN_API` (`{ current: 1, min: 1 }`); required but for `lang` |
| `class` | §2; every part the manifest names must belong to it |
| `scope` | `room` (the host's choice for the whole room), `personal` (the player's own setting), `server` (trusted code only), as the class allows — `cosmetic`: room and/or personal; `content`, `script`: room; `ui`, `lang`: personal; `trusted`: server or room |
| `authors`, `credits`, `license`, `homepage` (http/https), `sourceLang` (default `zh`) | free text |
| `requires`, `optional`, `conflicts` | `{ "<plugin id>": "<version range>" }`; a missing or out-of-range requirement is a warning of the registry now, a refusal when rooms choose plugins |
| `loadAfter`, `loadBefore`, `priority` | ordering hints (lists of ids; an integer within ±1000, default 0) |
| `settings` | ≤ 32 settings: `boolean`, `integer` / `number` (`min` and `max` required, `step`), `enum` (`options`) — no free text; `default` (else `false`, `min`, the first option), `label` |
| `permissions` | what the plugin does (§4); every part needs one, every permission must fit the class |
| parts | `assets`, `theme` (cosmetic+) · `data`, `operators`, `enemies`, `modes`, `stages`, `dsl` (content+) — a path, a list of paths or (`assets`, `theme`) the object inline · `i18n` `{ "<lang>": path }` (content+) |
| `entry` | `{ "sim", "meta" }` (script, `.js`) · `{ "client" }` (ui, `.html`) · `{ "server" }` (trusted, `.js`) |
| `lang`, `files` … | the `lang` class only: manifest 1's language fields and `files: { ui, data }` (§7) |

A **problem** keeps a plugin out (unlisted; the start log and `tools/plugin.mjs` say why); a **warning** does not.
Unknown fields are warnings. The asset overlay of a cosmetic plugin is §9; the inner formats of the data parts — data
patches, compact operator records, modes — are specified in §10.

## 4. Permissions

| Permission | Classes | Needed by |
|---|---|---|
| `assets.override`, `assets.add` | cosmetic, content, script, trusted | `assets` (either) |
| `theme` | cosmetic, trusted | `theme` |
| `data.patch`, `data.add` | content, script, trusted | `data` (either); `operators`, `enemies`, `modes`, `stages` (`data.add`) |
| `dsl` | content, script, trusted | `dsl` |
| `sim.code`, `meta.code`, `mode.code` | script, trusted | `entry.sim`, `entry.meta` |
| `ui.frame` | ui | `entry.client` of a ui plugin |
| `trusted.page`, `trusted.server` | trusted | `entry.client`, `entry.server` of a trusted plugin |

A permission nothing in the manifest uses is a warning.

## 5. Files and limits

By class: images `.png .jpg .webp` (no SVG), Spine `.skel .atlas`, audio `.mp3 .ogg`, fonts `.woff2`, data `.json`;
code `.js` only in `script` / `trusted`; frames `.html .js .css .png` only in `ui`, under its client's folder; `lang`
carries `.json` only. Documents (`.md`, `.txt`, `README`, `LICENSE`, `NOTICE` …) may sit beside them and are never
served. Nothing else; no symbolic link inside the folder (a plugin folder that is itself a link is fine); file names
are plain (letters, digits, `. _ -`, spaces; no hidden or `..` part). Every path the manifest names must exist inside
the folder.

Limits [ASSUMED, all of them]: 8 MB per JSON file, nesting ≤ 64 levels, numbers finite within ±1e9; 200 MB and 5000
files per plugin. The registry checks the manifest, the files and the paths whenever it scans; `tools/plugin.mjs check`
also parses every JSON file against the limits.

## 6. Content identity (`cs`)

Every server names the content its rooms play with a hash, **`cs`** (`shared/plugins/identity.js`):

```
cs = sha256(canonical({ v: 1, app, sim, data, plugins, settings, i18n? }))
  sim       sha256(canonical([[path, sha256], …])) of every served /sim/**.js (not nodeData.js), /shared/**.js and /data.js
  data      { <name>: sha256 } of every data/<name>.json the match or the sim reads (not assets, local-assets, emotes, i18n/)
  plugins   [{ id, version, files }] in load order — [] for the vanilla content
  settings  { <id>: { <key>: value } } — {} for the vanilla content
  i18n      omitted for vanilla and cosmetic-only selections, so this P0 formula stays bit-identical. A content
            selection (§10) passes { <lang>: sha256 of the served i18n/<lang>.json }. index.json is not an input.
```

`canonical` is JSON with sorted keys and no white space; the bytes are the bytes served, so a browser hashes exactly
what it received (with `shared/sha256.js`, which also works where `crypto.subtle` does not — a LAN address is not a
secure context). Two machines with the same `cs` run the same battles bit for bit; any code or data change gives a new
one. The server computes it once at start (`[content] vanilla <16 hex>` in the log).

Where it shows (DESIGN §8.4): `welcome.content` `{ vanilla }`, `room.state.content` `{ cs, vanilla: true, plugins: [] }`
(the vanilla set — a room's cosmetic plugins add `vs`, `plugins`, `warnings` and `bytes` beside the same `cs`, §9),
`/healthz` `content: { vanilla, sets: 0 }`, every BattleSpec's `cs` (the sim never reads it), an optional `b.result.cs`,
and the second line of a diagnostic report (`content: vanilla cs=<64 hex>`, with ` cosmetic vs=… plugins=…` in a room
with cosmetic plugins; a room with gameplay plugins will read `MODDED cs=… plugins=id@version(hash)…`).

`GET /cs/<first 16 hex digits>/index.json` answers the content set's manifest — every code file's hash, every data
file's URL (`/data/<file>?v=<8 hex>`), hash and size — cached for good; any other `cs` is 404. `GET /plugins/index.json`
(never cached) is the catalogue: `{ version, app, api, content: { vanilla }, plugins: [entry …] }`, every plugin and
pack found by class and id, with its `status` (`loaded` / `planned` / `unsupported`), `unofficial`, its manifest's
public fields, size and file count — never a path on the server; a loaded cosmetic plugin adds `vs` (the visual set of
it alone, §9) and `artBytes` (the art it serves). A loaded interface plugin adds `slots`, `entry` (a path inside the
plugin), `vs`, `frameBytes` and `frameFiles` (`{ path: sha256 }`, §14) — not `artBytes`.

Cosmetic plugins and interface plugins never change `cs`: neither changes a battle, so a room whose plugins are only
of those classes plays the vanilla `cs`. Installing a ui plugin, or editing its page, does not change `cs`. Editing a
served `/shared/**.js` does, because `cs` hashes every one of them — including `shared/plugins/ui.js`. The art a
cosmetic plugin draws, and the frame an interface plugin draws, are named by the visual hash `vs` (§9, §14).

## 7. Language packs

A language pack is the `lang` class: `public/i18n/<code>.json` (its `_meta`), `packs/<id>/pack.json` (manifest 1) or
`plugins/<id>/plugin.json` with `"manifest": 2, "class": "lang"` and the same language fields and `files`. All three
are listed in the live server's `/packs/index.json` exactly as before (docs/PACKS.md, docs/I18N.md). `tools/plugin.mjs`
lists a lang plugin with the rest; `tools/packs.mjs` (also its static `index`, whose host could not serve a plugin's
files at `/packs/<id>/`) and `tools/i18n.mjs` keep reading the language folders and `packs/` only, as in 0.2.0. A
manifest 1 of the old planned types `assets` / `data` is still reported as not loaded: its successor is a `cosmetic` /
`content` plugin.

## 8. Tools

```
node tools/plugin.mjs list [--json]                every plugin and language pack, by class, the skipped ones and why, the vanilla cs
node tools/plugin.mjs check [<dir|id> …] [--strict] the folders of plugins/ (or the ones named; a folder anywhere): manifest,
                                                   files, paths, JSON, a cosmetic plugin's overlay (its references against
                                                   this checkout's data/assets.json) — exit 1 on a problem, with --strict on
                                                   a warning too
node tools/plugin.mjs pack <dir|id> …              write plugin.lock.json (every file's SHA-256 and size, each Spine model's
                                                   clip data), then check the folder
```

`--root <dir>` points it at another checkout or an unpacked release. Planned: `new`, a zip from `pack`, `install`,
`golden`, `simcheck`, and `--plugins` for the balance tools.

## 9. Cosmetic plugins (P1a)

A cosmetic plugin changes what the game shows and plays — avatars, portraits, Spine models, icons, interface pictures,
voices, sound effects, music — and nothing a battle does: the simulation reads data, never art (an enemy's attack timing
is a number of `data/enemies.json`), so a room's `cs` is the vanilla one whatever its art.

**The overlay** — the manifest's `assets` part, inline in `plugin.json` or a `.json` file of the plugin
(`shared/plugins/visual.js`), written in the shape of `data/assets.json` (ASSETS.md "Manifest schema"):

```json
"assets": {
  "chars": {
    "char_102_texas": {
      "avatar": "art/avatar.png",
      "spine": { "front": { "skel": "spine/front/texas.skel", "atlas": "spine/front/texas.atlas", "textures": ["spine/front/texas.png"] } }
    },
    "char_112_siege": { "portrait": { "ref": "char_102_texas" } }
  },
  "ui": { "hudPanel/icon_hp": "art/hp.png" },
  "audio": { "voice": { "char_102_texas": { "skill1": "voice/s1.mp3", "select": ["voice/a.mp3", "voice/b.mp3"] } } }
}
```

| Container | A record |
|---|---|
| `chars[charId]` | `avatar`, `avatarE2`, `portrait`, `portraitE2` (image), `spine.front`, `spine.back` (Spine) |
| `enemies[key]` | `icon` (image), `spine` (Spine) |
| `tokens[id]` | `avatar` (image), `spine` (Spine) |
| `bonds`, `items`, `bands`, `skills`, `modules`, `ui`, `prof.icon` / `large` / `battlecard` / `sub` `[key]` | an image |
| `audio.bgm[lobby \| prep \| combat \| unite \| boss]`, `audio.bossBgm[bossId]` | a track `{ loop, intro? }` (audio), written whole — not `audio.bgm.combatAlts` (see below) |
| `audio.voice[charId]`, `audio.voiceJp[charId]` | `<slot>`: an audio file or a list of 1–16 |
| `audio.sfx.ui[key]`, `audio.sfx.battle[key]` | audio |
| `audio.sfx.units[id]` | `attack`, `hit`, `skill`, `die`, `born` (audio), `skills` / `attacks` / `hits` `{ <index>: audio }` |

A value is a **path** inside the plugin folder — an image `.png .jpg .webp`, audio `.mp3 .ogg` —, a **Spine model**
`{ skel, atlas, textures, pma }` (the `.skel` and the `.atlas` side by side with one name — pixi-spine looks for the atlas
there —, the pages inside the atlas's folder; `atlas` and `textures` default to `<name>.atlas` and `<name>.png`), or a
**reference** `{ "ref": "<key>" }` to an entry of the same container in the installation's own manifest:

- a whole record — `"char_102_texas": { "ref": "char_112_siege" }` — replaces the record as a whole; other keys beside
  the `ref` then change fields of it (`{ "ref": "char_112_siege", "avatar": "art/a.png" }`);
- one field — `"avatar": { "ref": "char_112_siege" }` — is that field of `char_112_siege`.

A reference always names the installation's entry, never another plugin's [ASSUMED], so the plugins' order never changes
what it means; one the installation's `data/assets.json` lacks is a problem. Anything else — another section (`fonts`,
`skillsById` …), a field a record has not — is a warning and left out; numbers, booleans and free text are never written
into the manifest; never an absolute URL (no other path of the server, no other host). A field a plugin does not write
keeps the installation's value (an `avatar` alone leaves `avatarE2`), but a track is written whole (a `loop` alone plays
without the installation's intro), and a model written for an enemy or a token — its `spine`, a model or a reference —
also takes away that entry's local-client model (`spineLocal`, which the client would draw first) [ASSUMED] — only with
that model: a model write the browser leaves out, or whose file fails to load, leaves the local model too. The split
battle music `audio.bgm.combatAlts` (the mode's own 开战 tracks, 骑士之日 / 无畏者, fixed per round) is not something a
plugin changes: the client plays it instead of `combat` in the rounds it covers, so a plugin's `combat` is heard only
where no such track plays. Writing an
entry the installation has needs the permission `assets.override`, a new entry `assets.add`. `theme` is not applied yet
(a warning).

**Spine models and `plugin.lock.json`.** A model's clip roles, durations, events, hit times and bounds come from the
skeleton itself: `node tools/plugin.mjs pack <dir>` parses it the way `tools/fetch-assets.mjs` parses the game's
(`tools/assets/skel.mjs`, `anim-roles.mjs`: an operator's three skill slots, an enemy's numbered skills), checks the atlas
pages against `textures`, and writes them into `plugin.lock.json` with every file's SHA-256 and size (a problem of the
overlay — a reference the manifest lacks — leaves the lock unwritten). `"anims": "auto"` or nothing — never by hand; a
lock made from another skeleton (its SHA-256) is a problem until it is packed again. The server never parses a skeleton
[ASSUMED]: it rebuilds the lock's clip data in the shape the tool writes — the known roles, every clip they play an
animation of the skeleton, at most 256 animations and 64 events, names of at most 64 characters, durations and hit
times within 600 s, the four numbers of the bounds — so nothing a hand-made lock adds reaches a browser [ASSUMED limits].

**Checked when scanned.** The registry reads a cosmetic plugin's overlay when it scans the folders (at start, when they
change, and when `data/assets.json` changes): its shape, files, references — what they copy out of the installation's
manifest at most 2 MB [ASSUMED] — and permissions, the lock — a problem keeps it out like any other — and hashes the
files that shape it (SHA-256, kept by path while a file keeps its size, mtime, inode and ctime: a rescan reads only what
changed, and a file rewritten with its old size and mtime put back — `rsync -t`, `touch -r` — is read again, its ctime
gives it away; the folders' own check looks at the same four, so such a rewrite is noticed without a request for it)
[ASSUMED: at scan, a 200 MB plugin costs about a second once].

**The visual hash.** A set of cosmetic plugins in load order is named by
`vs = sha256(canonical({ v: 2, assets: <SHA-256 of data/assets.json>, overlays: [{ id, version, files, writes }] }))`,
`files` mapping every file that shapes a plugin's overlay — `plugin.json`, `plugin.lock.json`, the `assets` file, every
file the overlay serves [ASSUMED] — to its SHA-256, and `writes` the SHA-256 of the canonical JSON of the plugin's writes
as the server serves them (`writesHashOf`: the slots, the files of the plugin they name, its references, a Spine model's
clip data — never a URL): the same files and writes give the same `vs`, one changed byte or one file moved to another
slot another.

**Served:**

- `GET /p/<id>/<hash8>/<path>` — a file a loaded cosmetic plugin's overlay names, and nothing else of its folder: no
  `plugin.json`, lock, document or other file, no dot file, no `..`, and only the very file the scan hashed: a symbolic
  link is never served — one in the folder when it is scanned is no file of it, and one put in place of a served file
  later, or in place of a folder on its way, is refused (404) wherever it leads, another file of the folder included
  (the request `lstat`s the path and wants the real path the scan recorded — both read with the native realpath, so a
  plugins folder spelled in another case than on disk still works on macOS and Windows). `<hash8>` is the first 8 hex digits of the
  file's SHA-256 — for every file of a Spine model, of the SHA-256 of its files' SHA-256s, so the skeleton, its atlas and
  pages share one folder. At the hash of the file's bytes, while the file keeps the size, mtime, inode and ctime it was
  hashed with, the answer is `immutable` for a year; at any other hash, or for a file changed since the scan, the current
  file with `no-cache` (as for `/assets/~<hash>/…`, ASSETS.md; a changed file's ETag is its stat identity, never the
  old content hash, and the compressed-body cache keys on the inode and ctime too), and a changed file has the registry
  read the folders again. An audio file is also served **without its extension** — `/p/<id>/<hash8>/voice/s1` for `voice/s1.mp3` —, which
  is how the page fetches it (`public/js/media.js` mediaUrl: download managers such as IDM or 迅雷 pop up a dialog for
  every fetch that ends in `.mp3`, the reason 0.2.6's `/media/` route exists; with a `.mp3` and a `.ogg` of one name the
  one whose hash the URL names; a host without the route still works: the page falls back to the URL with the
  extension).
- `GET /vs/<vs16>/overlay.json` — a set: `{ visual: { v, vs, assets, overlays: [{ id, version, files, writes }] },
  writes: [{ id, ops }] }`, its composition (what `vs` hashes) and each plugin's writes in its own terms — paths of its
  folder, references, a Spine model's clip data from the lock —, never a URL and never a copy of the art manifest (a few
  KB). A browser refuses a document whose composition does not hash to the room's `vs` or whose writes do not hash to
  their part of it (`checkVisualDoc`: the room keeps the installation's art, one toast).
  `no-cache` with the body's hash as ETag [ASSUMED: a 304 costs next to nothing]; 404 for a set the server does not know
  (a set is known once a room resolved it, or the catalogue named a plugin's own; a room holds its set while it uses it,
  of the others the last 256 are kept [ASSUMED]; a document is built once however many ask).

**A room's plugins.** The room's top bar shows 「原版」 or 「插件 ×N」; it opens the 插件 panel (`public/js/ui/pluginPanel.js`):
the server's cosmetic plugins of scope `room`, with the host's switches (read-only for the other players and the
spectators, and during a match), versions, authors, sizes, 非官方 marks, 「自动」 on one switched on because another needs
it, a note for one made for other game versions (a cosmetic plugin is still usable) and the override warnings. A switch
sends `room.setPlugins { plugins: [{ id }] }` (host, before the match; like a difficulty change it un-readies the others —
not when only the 「自动」 marks change; the heavy rate-limit bucket): the server closes the set over the plugins'
`requires`, refuses conflicts, a cycle, a plugin of another class or scope, and a set over 300 MB of art or whose
references copy over 4 MB of the art manifest [ASSUMED] (`PLUGIN_UNKNOWN`, `PLUGIN_BLOCKED`, `PLUGIN_DEPENDENCY`,
`PLUGIN_CONFLICT`, `PLUGIN_LIMIT`), sorts it (`shared/plugins/order.js`: requires / optional / loadAfter / loadBefore, then priority, then
id) and the room's content becomes `{ cs, vanilla: true, vs, plugins: [{ id, version, class, hash, auto? }], warnings,
bytes }` — `cs` the vanilla one. Every member's page fetches `/vs/<vs16>/overlay.json`, checks that its composition
hashes to the room's `vs` (`checkVisualDoc`) and composes the art itself on the manifest it loaded (`/data/assets.json`,
its `/assets/~<hash>/…` URLs; `shared/plugins/visual.js` prepareVisualDoc / layVisualOps): every plugin URL is built
from the composition's file table — `/p/<id>/<the first 8 hex digits of the file's SHA-256, or of its model's>/<path>` —,
every reference copied out of the page's own manifest, the plugins in the composition's load order, so what it draws is
exactly what `vs` names; a write that does not fit (a file the table lacks, of another kind than its field, a path
outside the containers, a model out of its folder or of the lock's shape, a reference the page's manifest lacks) is left
out and its entry keeps the installation's art. Leaving the room takes the art away again. A document that fails the
check or will not download (an attempt is given up after 30 s [ASSUMED], two retries), or a write left out, leaves the
original art there (one toast per page). Whenever the art changes under a page — the room's set arriving after its
board was drawn (a reconnect, a spectator joining a match), a personal plugin switched during a match, a set taken away —
what is already on the board follows: a piece or unit whose picture or model the manifest no longer names loads the new
one, which replaces the old in place (`render/units.js` retryAssets) — and one whose picture or model came from a plugin
alone (the installation's slot is empty: a summon, an enemy without a web model) loses it with its layer, a load still in
flight dropped —, and the backdrop mountains and the shadow sprite
follow their `ui` entries, and the music plays the screen's track again when its URLs changed. A plugin file that will
not load — an image of the interface, a picture, a Spine model (any of its files, or one the renderer cannot build; not
while the tab is hidden) or the shadow sprite of the board, a sound — makes its entry fall back to the art
beneath it, the installation's (or the room's, under a personal plugin), for the rest of the page's life [ASSUMED]; a
sound plays the installation's entry instead at once (the BGM track, the voice line of the same slot, the same sound,
the bond cue).
When a plugin of a room's set changes on the server while the room uses it (the registry read the folders again — a
served file found changed, or the folders' own signature), the host is told once (a toast; during a match, once the
room is back in its lobby) to apply the plugins again:
the panel's 「重新应用」 sends the same choice, which makes the set of the files as they are now; until then the room
keeps its set — its changed files go out under the old URLs with `no-cache`, and what will not load falls back. A plugin the
server no longer offers stays in the panel by its id, and its switch only turns it off. With no plugin the room's
content is exactly the vanilla `{ cs, vanilla: true, plugins: [] }`. A server says how many unofficial plugins it has
in `/healthz` (which every page reads at once: the build guard) and in `welcome`, as `content.plugins` — only when there
are some; the title screen's 「本服务器安装了 N 个插件」 is that count, and the catalogue is fetched only then, when
something needs it (the title's list, the 插件 panel, 设置's 外观插件, a switched-on personal plugin). So a page of a server
without plugins makes no request more than 0.2.6's but for three small modules at start (`public/js/content.js`,
`public/js/cosmetics.js` — the layers —, `public/js/ui/pluginTag.js` — the room's tag); the panel
(`public/js/ui/pluginPanel.js`) loads when it opens, what checks and composes a set (`shared/plugins/visual.js`) with
the first set, the load-order function (`shared/plugins/order.js`) with the catalogue, and the asset store
(`public/js/assets.js`) with the first match, as in 0.2.6.

**A player's plugins.** 设置 → 外观插件 lists the server's cosmetic plugins of scope `personal`, each with a switch, kept in
this browser only (`localStorage` `sp.pref.cosmetics`), never sent, never part of a battle and seen by nobody else. The
switched-on ones form a set exactly like a room's (`shared/plugins/order.js`, over what the catalogue lists of each:
`requires`, `optional`, `conflicts`, `loadAfter`, `loadBefore`, `priority` — `public/js/content.js` personalSet): a plugin
another one needs is switched on too (「自动」, its switch locked), a switch that would make a conflict or needs a plugin
the server lacks is refused with the room's message, and a choice that went bad since (the server's plugins changed)
keeps what still fits, by id, the rest marked as not in effect [ASSUMED]. Each plugin of the set is fetched as
`/vs/<vs16>/overlay.json` of its catalogue `vs`, checked and composed the same way, and laid over whatever the page draws
(the room's art too), in the set's load order (fetched side by side); one the server no longer has is skipped and stays
switched on for when it is back.

**Statistics.** A match with cosmetic plugins only plays the vanilla content (`cs`), so it counts as the original game in
the statistics overview — the owner's decision of 2026-10-13: its gameplay and numbers are unchanged, and a player's
personal cosmetics never matter; only matches with plugins that change gameplay will be left out (P1b / P1c). Every stats
record names the room's visual set (`vs`, null without cosmetic plugins — a player's personal plugins are not recorded:
`public/js/ui/stats.js`). The diagnostics name the art: `content: vanilla cs=… cosmetic vs=…
plugins=id@version(hash),… personal=id,…`. Replays and BattleSpecs carry `cs` only, not `vs` (P1c): a battle replayed from
a spec, or from a bug report's JSON, shows the installation's art — the report's content line names the set it had.

**Limits** [ASSUMED]: 300 MB of art per set, 20 000 writes per plugin, 16 files per voice slot, 32 override warnings per
set, 2 MB copied by references per plugin and 4 MB per set, the lock's limits above; the plugin limits of §5 apply too.

**Start from** `plugins/_template/cosmetic/` — references to the installation's own art only, no file. Never put files
of the official game in a plugin.

## 10. Data plugins (P1b)

A `content` plugin is now `loaded`: the registry snapshots its declared JSON; `buildContentSet` applies the selected
plugins in dependency order and validates the **whole merged data**. No third-party code is imported or evaluated.
Room selection, worker isolation and HTTP/client switching are §11 (P1c). Start with `plugins/_template/content/`, copied
to `plugins/data-demo/`. Rename its record namespaces too when renaming that folder.

**Patches** (`shared/plugins/patch.js`): a manifest `data` file is `{ "patch": 1, "ops": [...] }`.
Each operation names `file` (without `.json`), optional record `id`, and `path` (array of keys/indexes):

| op | meaning |
|---|---|
| `set` | replace an existing field with `value` of the same type. `null` is its own type: it may be written only onto a field that is already `null`. Washing a number through `null` into an object is `PLUGIN_PATCH_TYPE` and returns the original data |
| `merge` | recursively merge an object into an existing object; arrays replace whole arrays |
| `add` | add a new namespaced record with `id` and object `value`; `config` uses `path: ["modes"]` |
| `append` | append the elements of array `value` to an existing array |
| `remove` | remove array values equal to `match`; it never deletes a record or an object field |

Unknown operations, absent paths, wrong types, unsafe keys (`__proto__`, `constructor`, `prototype`), missing settings,
record deletion and invalid new ids produce structured `{ code: 'PLUGIN_*', path, message }` problems. A failing patch
returns the original input, never a partial application. `applyPatches(data, ops, { pluginId?, settings? })` is pure.
`{ "$setting": "name" }` in patch values resolves against normalized manifest settings. Out-of-range settings use the
default; only declared settings enter `cs`. Repeated writes in different plugins are reported as warnings; later writes
win. To change another plugin's records, declare its id in `requires` (a load-order hint alone is insufficient).

Records sometimes keep a convenience copy of a blackboard: `bonds[id].bb` is used by presentation, while battle
handlers may read `bonds[id].buffs[n].bb`. Change both when changing that number; the template demonstrates it. Likewise,
changing a default skill requires keeping `skill` equal to its `skills[]` entry. Validation catches inconsistent skills.

**Compact operators** (`operators` manifest files; `schemas/records.schema.json`): one object or an array, with `op: 1`,
`charId`, `name`, `profession`, `subProfessionId`, `position`, `rarity`, `as`, `forms.normal`, `forms.elite` and `skills`.
Each form supplies `stats` and `rangeGrid`; optional form `skills`, `trait` and `talents` override the shared ones.
`skills` has exactly one `default: true`, and each skill supplies `skillId`; the expander fills index, SP, trigger,
blackboards and display fields. `as: "chess"` needs `chess: { tier, bonds, price? }`: normal/elite ids, prices, sell
values and merge counts come from that tier's economy, and statuses from `economy.chessStatus`. `as: "diy"` creates
`backups.units`, every existing DIY slot status, `diy.ownedPool` and `diy.operators`; `"both"` does both. The expander
adds shop chess to their bonds' member lists. An existing record must be changed with patches.

Behavior is `kit: "generic"`, `{ "ref": "<official kit key or file stem>" }`, or
`{ "spec": <JSON SkillSpec or JSON file path> }`. Files are JSON, including transitive spec files. `art: { ref: charId }`
references asset ids already installed; it carries no art file. `talentMods` supplies permanent numeric mods with a
JSON SkillSpec. Per-skill `skillSpec` overrides the operator's spec for that selection.

`kitOf` resolves extensions → `raw.dsl` → `raw.skillSpec` → `raw.kitRef` → official kit → generic. Explicit test kits
still take precedence. `talentMods` are installed only on the JSON SkillSpec branch. A record that carries both
`kit.ref` / `kitRef` and `talentMods` is `PLUGIN_SKILL_SPEC` at expansion and again in `validateData`; the schema file
still allows the pair, and the runtime rejects it. File stems resolve only against the official registry, never an
import path. A referenced kit's numbers come from the new record. Keep official skill ids to use its named alternate
skills; a one-skill DIY clone can reuse a chess kit's default skill [ASSUMED]. `extensions.js` is empty until P3
supplies it; `dsl/compile.js` is P2's compiler (§12), but the records and the validator still refuse `dsl`
(`PLUGIN_DSL_UNAVAILABLE`) until the data-plugin work accepts it. A plugin operator whose id
starts with `char_x_` and whose chess and backup records have neither `potDown` nor a talent `potBelow` accepts only
the default potential 6. Official operators, including `char_616_pithst`, are unchanged. The loadout screen can still
show the control; the sync step drops a non-default value and the server rejects a raw client message. No new
interface string.

The JSON SkillSpec allowlist is SIM §7.3 without callbacks: kind, deployment activation, duration/ammo/SP/charges,
trigger, heal, mods, flags, targeting and attack (including chain/heal/onHitStatus). Unknown fields, functions, wrong
types and unknown mod/flag names fail. Work bounds [ASSUMED]: attack/chain/target/ammo/charge counts ≤ 100, a range at
most 1024 integer offsets within ±64. No JavaScript string is executable.

**Other records**: a manifest `data` file may instead be `{ "records": 1, "entries": [...] }`. Each entry is
`{ file, id, base?, set? }` or `{ file, id, value }`; `base` clones an existing record before applying `set`.
Supported files: enemies, waves, stages, modes, items, bands, garrisons, effects, tokens and choices. The dedicated
`enemies`, `stages` and `modes` files use the same shape with `file` supplied by their manifest part.

- Enemies can use `special: "<official enemy key>"` to reuse that enemy's data and kit. It is a specific enemy, not an
  entire faction category: those categories contain many different behaviors. Changes still use the concrete record's
  stats/blackboards. Waves supply routes and spawns; the expander fills empty branches, overrides and device lists.
- Items and bands require an official `base` or `value.effectRef`; the result retains `effectRef` and the concrete
  record's copied/overridden buffs. Battle item identity checks and prep dispatch recognize it. A compact item is a
  single non-merging record [ASSUMED]; paired equipment can be added as complete records with patches.
- Garrisons reuse an existing `effectKey`; effects reuse existing buff handlers. Choices use
  `{ file: "choices", id: "effect_x_data_demo_card", kind: "tactic" | "bounty", base: <card effectId>, set?, effect? }`:
  the new card and its cloned effect are added together. New bond behavior requires a later code plugin.
- A mode requires an official `base`; nested objects inherit field by field and arrays replace whole arrays.
  The base's choice schedule is copied. Changes to that schedule can then be patched explicitly. `GameData` overlays
  mode-level economy, DP, timers and other global configuration keys; omitted values retain the official defaults.
  Explicit mode chess purchase/sale prices override record prices. A room picks a mode with `room.setMode` (§11).
- New or changed stages get ground paths from the same `Grid` helper as build-data (`server/sim/groundPaths.js`), with and
  without active devices; deployment lists are derived too. The board stays 19×21. A base stage is the easiest start.
  A plugin that changes only a wave's `routes` or `extraRoutes` recomputes `groundPaths` for stages listed on modes
  whose round `template` or `bossTemplates` name those waves, from every current route, and keeps that stage's
  `deployTiles`. [ASSUMED] bots then read the new paths; deployment lists stay the stage's own.

New record ids are ≤64 ASCII letters/digits/`_`/`-`. The plugin id replaces `-` with `_` inside records. Prefixes:
`chess_x_<plugin>_<name>_a/_b`, `char_x_…`, `skx_…`, `enemy_x_…`, `mode_x_…`, `stage_x_…`, `wave_x_…`,
`item_x_…`, `band_x_…`, `garrison_x_…`, `effect_x_…`, `token_x_…` [ASSUMED prefix choices]. Two selected plugins whose
namespaces collide are refused at composition with `PLUGIN_RECORD_ID`: `data` cannot sit beside `data-demo` (both
prefix `data_`), and `ab-cd` collides with `ab_cd`. `ab` does not collide with `abc`. A plugin folder scanned alone is
not refused. Whole-map writes cannot bypass record namespaces or remove existing records. The shared validator checks
shapes, finite numbers, references, paired forms, the default skill, official kit/effect refs, wave routes and mode
references. One wave, and each phase of a branch, may have at most 64 spawn rows, each an integer count from 1 to 600,
summing to at most 600. Enemy `times` keys (and keys ending in `times`, including wave overrides) stay at or below 100.
`bb.count` of 列装 (`global_special_choice_gain_equip`) and bond-chess (`single_special_choice_gain_bond_chess`) stays
at or below 32. With the official tables as `vanilla`, every numeric blackboard value, and the loop fields enemy
`sp.maxSp` / `sp.initSp` / `sp.increment` and skill `spCost` / `initSp` / `maxChargeTime` / `increment`, must also
satisfy `|v| ≤ max(10 × official absolute maximum of that key, 64)` (`PLUGIN_DATA_BOUND`). A key official data never
has uses 64. Blackboard `ammo` and `charge` use that blackboard rule. The battle clamps the same spawn, enemy-times
and card-grant loops, and the loops fed by the systematic cap (operator `times` / `attack@times`, band and 维多利亚
`count`, 黑云 ammo, 狱警 pierce). [ASSUMED] the factor 10 and the floor 64 sit above the measured official maxima
(`times` 12, `attack@times` 5, `count` 20, enemy `sp.maxSp` 55) and far below ±1e9. Durations are not given an engine
loop cap; a blackboard `duration` is still subject to `PLUGIN_DATA_BOUND`. Some `count` reads are one addition
(`addLayers`, a single coin multiply) and bond layers still stop at 999; band grants and 维多利亚 hammers do iterate
`count` and use the systematic cap, not 32. `jsonProblems` still allows a number whose absolute value is 1e9.
Official counts, official trigger deviations and source-specific rules stay in
build-data; its original data is unchanged. `node tools/records-schema.mjs` rewrites `schemas/records.schema.json`
from the runtime schema (an optional output path overrides that file).

**Languages.** Manifest `sourceLang` describes the record texts (default `zh`). `i18n: { "en": "i18n/en.json" }` uses
the existing `{ version: 1, lang, files: { table: { id: overlay } } }` format. String leaves must target existing strings.
The builder computes `_h` against the final source text and retains valid unrelated base translations. Output lives in
`i18n/<code>.json` in the composition, separate from simulation data. A content selection's `cs` includes the sha256 of
each served `i18n/<lang>.json` body. Vanilla and cosmetic-only selections omit that field, so the P0 hash still
excludes `data/i18n/`. Declared plugin-file hashes alone do not name the served translation snapshot. `index.json` is
not a hash input. [ASSUMED] it cannot diverge while the hashed i18n bytes, data hashes, plugins and settings stay the
same.

**C1 for integrators** (`server/plugins/contentSet.js`):

```js
const set = buildContentSet({ registry, ids: ['data-demo'] }); // or [{id, settings}]
// success: {cs, vanilla, plugins:[{id,version,hash}], data, files:{rel:{sha256,bytes}}, modes, problems:[],
//           index, settings, warnings, kitted}
// refusal: {problems} only — no cs and no partial data
const files = contentSetFiles(set); // Map<rel, {body:Buffer, sha256, bytes}>, defensive copies
```

`data/<table>.json`, `i18n/<code>.json` and `index.json` are the route-relative keys. `index` uses the P0 composition
shape (`plugins` there carry file hashes). Unchanged gameplay files retain their disk bytes and `/data/…?v=` URLs;
changed files are the exact `JSON.stringify` bytes served from memory. The empty set's index and `cs` exactly equal P0
computed from the same checkout. Any served sim/shared-code change naturally changes that checkout's vanilla hash.
Cosmetic selections and dependencies can join the ordering pass; only content plugins enter this result’s gameplay plugin list and hash. Cache: by `cs`, 32 recent sets per registry [ASSUMED]; held set objects and their bytes remain valid after eviction or
plugin removal. Room lifetimes and worker limits are §11's. A content plugin's optional asset part also has a validated
`visual` snapshot; the room's visual set includes it (§11).

Before importing Match/creating its meta registry in a content host, inject the merged singleton data; initialize sim
data and reset `content/support`'s cached data too. The browser uses its `data.js` shim and `loadBrowserSim` to do the
same. Passing only `opts.data` to a Battle does not change content/support's singleton. P1b tests both the Node setup
and the actual browser loader with a patched bond; the match host's worker entry does the same (§11).

## 11. Room content sets (房间内容组合, P1c)

A room's host switches the server's `content` plugins on for the room in its 插件 panel, beside the cosmetic ones (§9).
The room then plays a **content set** of its own: the vanilla data with those plugins applied by §10's builder, named by
its own `cs`. Every member's page downloads that set and checks it byte by byte, and the room's matches run in a match
host of that set, a child process (or, when the server owner asks for it, a worker thread) of its own. Such a match is **unofficial**: marked in the room,
the briefing, the result and the HUD, and left out of the statistics overview unless a player counts it. A room with
cosmetic plugins only still plays the vanilla `cs` and counts as the original game (§9). DESIGN §32.6 keeps the
decisions, the measurements and the open points.

| File | Role |
|---|---|
| `server/plugins/roomSets.js` | what a room's plugin list makes: closed over requirements, ordered, split into the visual set and the content set, the policy's refusals |
| `server/plugins/contentSets.js` | the content sets rooms hold: built through C1 (§10), kept by `cs`, the concurrent limit, the files `/cs/<cs16>/…` serves, the bytes a match host checks |
| `server/plugins/policy.js` | the server owner's `plugins/config.json` |
| `server/match/host/` | the match hosts: `index.js` (one worker or child process per `cs`, the watchdog, the limits), `entry.js` (inside the worker: the bytes checked against `cs`, the data installed before the match code is imported), `proxy.js` (the lobby's room.match for a hosted match: Promise answers) |
| `public/js/content.js` | the page's copy of the room's content set: downloaded, checked, handed to `data.js` and the battle runner, `room.contentReady` |

**Switching** (`room.setPlugins { plugins: [{ id, settings? }] }`). The host chooses plugins by id. The server adds what
they require (shown as 「自动」), orders them (`shared/plugins/order.js`) and splits them by class: the cosmetic ones, and
a content plugin's own `assets`, form the room's visual set `vs`; the content ones form its content set. `settings` are
normalised by the manifest's declared settings (§3) and are part of `cs`. Refused, with the room unchanged:

| Code | When |
|---|---|
| `NOT_HOST` / `ROOM_STARTED` | another player asks, or a match is running |
| `PLUGIN_UNKNOWN` | the plugin is not installed |
| `PLUGIN_BLOCKED` | a class or scope rooms cannot take, the server owner's policy (rooms off or fixed, not in `allow`, the class off), or a set whose merged data does not validate (the builder's first problems are the detail) |
| `PLUGIN_DEPENDENCY` / `PLUGIN_CONFLICT` | a requirement is missing, or two plugins conflict |
| `PLUGIN_INCOMPATIBLE` | a gameplay plugin made for other game versions or another plugin API (a cosmetic one is only a warning, §9) |
| `PLUGIN_BUSY` | one content set more than the server runs at once (`limits.maxSets`, default 4 [ASSUMED]) |

A change of the content set (or of the mode) un-readies the other players, like a difficulty change. Switching
everything off brings back the vanilla shape of `room.state.content` exactly.

**The room's state.** With gameplay plugins `room.state.content` is `{ cs, vanilla: false, plugins: [{ id, version,
class, hash, auto? }], warnings, bytes, dataBytes, vs?, modes?, modeId?, kittedExtra? }`: `dataBytes` is what a member
downloads beyond the vanilla files, `modes` the modes its plugins add (`{ id, name, roomMode, difficulty }`), `modeId`
the one the host chose, `kittedExtra` the operators the set adds to a 自选 slot's list (`welcome.diyKitted` has the
server's own). Each human seat and spectator carries `content: 'loading' | 'ready' | 'failed'`, only in such a room. The
protocol increments are listed in `docs/design/network.md` §8.

**Download and check** (`public/js/content.js`). `/cs/<cs16>/index.json` is the set's manifest (§10): enough to
recompute `cs`. The page fetches it and every file it lists: an unchanged one at its plain `/data/<file>?v=<8 hex>` URL
(cached for good), a patched one at `/cs/<cs16>/data/<table>.json`, the set's translations at their URLs. Every body is
read as bytes and checked before it is decoded: its size and SHA-256 against its manifest entry (a BOM is part of the
bytes). The manifest's composition (the data and translation hashes, the plugins and their settings) must hash to the
room's `cs`, and the manifest may name no address but this server's `/data/` and the set's own `/cs/<cs16>/`. Then
`data.js` shows the set (every screen reads its operators, modes and texts), the battle runner simulates on it, and the
page tells the room `room.contentReady { cs }`. A failed check is told too (`{ cs, ok: false }`), and a toast asks the
player to reload. `room.ready` waits for the player's own page and `room.start` for every player's (`CONTENT_NOT_READY`).
Leaving the room, or the room going back to the original content, gives `data.js` the server's files again without a
download. The panel shows the download's progress and the check's result.

**Modes** (`room.setMode { modeId }`). With gameplay plugins the panel shows the room's mode, chosen by the host before
the match and read-only for everyone else. An official mode of the room's type (solo or co-op) sets the difficulty; a
mode a plugin adds (`content.modes`, of the room's type) becomes `content.modeId`, the match's mode, until the host picks
a difficulty or the set no longer has that mode.

**The match host** (`server/match/host/`). A vanilla room's match runs in the server process exactly as before, and so
does a room with cosmetic plugins only. A content set's matches run in one match host per `cs` — a child process —,
shared by every room that plays that set. The host receives the set's data bytes and its hash input, checks them
against `cs`, installs the data (`server/data.js` `setData`) and only then imports the match code, so a plugin's data
never reaches another room. The lobby talks to it through a proxy whose answers are Promises; each such room handles
its messages one at a time on a queue of its own, and a vanilla room never queues. A host that stops answering (no heartbeat for 10 s), crashes or runs
out of memory ends that set's matches only: each room goes back to its lobby and its members read why. Each host has a
768 MB heap; at most `maxWorkers` (4) run at once, and an idle one stops after 10 minutes [ASSUMED, all three].
`SP_MATCH_HOST=worker` runs a worker thread instead of a child process — not on a public server: one large allocation
in a worker thread aborts the whole server process (measured, DESIGN §32.6; `docs/DEPLOY.md`).

**The battle's authority.** A page simulates its battle on the set it checked, and its `b.result` names that `cs`. A page
that holds another content set, or none, for a battle of the room's set is never the authority: it sends no result and
the server takes the field over at the deadline. The server refuses a result that names another `cs` and simulates that
battle itself. A BattleSpec may carry the room's `vs` as well (for the diagnostics; the sim never reads it).

**Unofficial marks.** The room's 插件 tag reads 非官方 with gameplay plugins; the briefing and the result say 非官方 with
the number of gameplay plugins; the HUD shows a small corner mark. Statistics records carry `content: { cs, plugins }`
(null for the original game) and the overview leaves such matches out by default (「含插件对局」 counts them). The
diagnostics line reads `MODDED cs=… plugins=…` and the bug template asks whether plugins were on.

**Server owner's policy** (`plugins/config.json`, git-ignored like the plugins): whether a room's host chooses its
plugins (`rooms: "host"`, the default), every room plays a fixed set (`"fixed"`) or rooms play the original game
(`"off"`); the plugins a new room starts with (`default`); the plugins rooms may use (`allow`); classes switched off
(`classes`); the concurrent content sets (`limits.maxSets`); whether gameplay plugins made for other versions may be
used (`allowIncompatible`). `SP_PLUGINS=off|host|fixed` overrides `rooms`. The file is read again when it changes;
a bad field keeps its default and is reported in the log. `docs/DEPLOY.md` has an example.

**HTTP.** `/cs/<cs16>/index.json`, `/cs/<cs16>/data/<table>.json` and `/cs/<cs16>/i18n/<lang>.json` of a gameplay set
are served from memory with `Cache-Control: immutable` while a room holds the set, and for the last 8 sets nobody holds
[ASSUMED]; the vanilla `/cs/<vanilla cs16>/index.json` is unchanged. `/healthz` counts the content sets in use
(`content.sets`).

**Not yet** (DESIGN §32.6): a form for plugin settings in the panel (the protocol takes them), a notice when a content
plugin changes on disk while a room holds its set (the cosmetic notice exists), `allowIncompatible` reaching past the
builder (it refuses a plugin it marks incompatible), and the DSL (§12) in data plugins (the builder still refuses
`dsl`).

## 12. DSL

A plugin describes a skill, a talent or a small prep effect in JSON (P2). No plugin code runs. The vocabulary, the
per-battle action budget and the worked examples are [PLUGIN-DSL.md](PLUGIN-DSL.md). `compileDsl` in
`server/sim/content/dsl/compile.js` turns a spec into a Kit; `server/match/dslMeta.js` turns the prep half into
MetaRegistry hooks. The schema is `schemas/dsl.schema.json`. DESIGN §32.7. A vanilla battle does not load the compiler.
Teaching `kitOf` to read `def.raw.dsl` is the data-plugin work, not this section. The host supplies the plugin id
(an author id cannot take another plugin's budget). Prep keys are `effect:<that id>:<local>`. DESIGN §32.7 records
the open points, including the generic-kit fallback until the data-plugin work records a compile error itself.

## 14. Interface plugins (P4)

A ui plugin is a page. The server lists it and serves its frame files; each player decides, in this browser, whether
to show it. It is unofficial. It is not a member of a room's `plugins[]` and a room cannot switch it on
(`PLUGIN_BLOCKED`). It adds nothing to `cs` and it does add its own `vs` (§6).

**Manifest.** `class: "ui"`, `scope` including `personal` (that is the only scope this class has), permission
`ui.frame`, `entry.client` an `.html` path, `slots` any of `hud.right`, `result.tab`, `stats.tab`, `room.panel`.
`description` is the 简介. The `.html`, `.js`, `.css` and `.png` files must sit in the directory of `entry.client`.
Start from `plugins/_template/ui/` (a damage tally). A folder whose name starts with `_` is a template: the registry
never loads it.

**The frame.** The page runs in `<iframe sandbox="allow-scripts">` — no `allow-same-origin`, so its origin is the
opaque string `"null"` and it cannot read this site's storage or credentials. The iframe points straight at that plugin's own
`/p/<id>/<hash8>/<entry>`. Its first load is the entry, and any later load destroys the frame: the host then clears
`ready` and posts nothing more. `postMessage` to `"null"` cannot tell those documents
apart. Files at `/p/` for a ui plugin, and not cosmetic art, are sent with
`Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; sandbox allow-scripts; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`
(`UI_FRAME_CSP`), on 200, 206 and 304. The `sandbox` directive is what still applies when that URL is opened at the
top level; a `<meta>` sandbox does nothing. The header has no `allow-same-origin`. [ASSUMED] `'self'` may not match
the opaque origin, so an inline script runs and a separate script file may not; that is not repaired by granting the
iframe the page's origin. [ASSUMED] A snapshot or a private view already posted can leave in the URL of the
navigation that exits the entry. Later posts stop; that does not recall the copy. `navigate-to` was not measured and
is not the fix. There is no CSP on the rest of the site.

**The feed** is postMessage API v1 (`shared/plugins/ui.js`, `schemas/ui.schema.json`). The host sends the player's
visible `m.public` (a subset), the player's own `m.private` (a subset), throttled events and snapshots of the battle
on screen, and unit stats when the plugin asks. The plugin may ask for a slot, a height, a short notice, and a few
namespaced storage keys (`sp.plugin.<id>.`, proxied by the host page). It cannot send a match intent: a message whose
type is `hello`, `ping`, `room.*`, `g.*` or `b.*`, or that carries one, is rejected. The host never turns a plugin
message into a client→server message.

**Limits [ASSUMED]:** 20 messages a second per plugin, burst 40; battle pushes at 4 Hz, ≤ 40 events a batch; a
snapshot whose JSON is over 48 KB is dropped with `truncated`, and `truncated` is also set when a string, array, object
or nesting depth was cut (the partial snapshot is kept when it still fits); a plugin message over 8 KB refused;
storage keys of 1–64 characters from `A–Z a–z 0–9 . _ -`, not `__proto__`, `prototype`, `constructor` or `..`, a JSON
value ≤ 4096 UTF-8 bytes, ≤ 32 keys and ≤ 32 KB UTF-8 per plugin; height 48–480 px; a notice ≤ 80 characters, and a
distinct notice at most once per 2 seconds (the same text is still delivered so toasts can merge); one slot per
plugin, one plugin per slot, at most 8 mounted. Engine `dmg` / `heal` tuples expose the HP at `amount` (the unit id
is `unitId`). The private subset drops loadout, ops, diy, effects, nextEnemies, personalChoice, rewardOffer and
tokens. The exact allowlists are `subsetPublic` and `subsetPrivate`. Storing a snapshot does not trip
`PLUGIN_INTENT` just because the host had labelled it `b.snap`.

**Switches.** 设置 → 「界面插件」 is `localStorage` (`sp.pref.ui-plugins`). It does not affect other players. The host
may 「推荐」 (`sp.pref.ui-recommend`); the room shows 「房主推荐」 and each player still decides. [ASSUMED] the
recommendation is this browser's until a later phase copies it onto the existing `room.state` — no new protocol
message. The host may toggle it during a match because it changes no match.

**Errors.** `PLUGIN_SLOT`, `PLUGIN_RATE`, `PLUGIN_STORAGE`, `PLUGIN_INTENT`, `PLUGIN_SHAPE`, `PLUGIN_LIMIT` live in
`shared/plugins/ui.js` and are merged into the shared error catalogue at integration (C6).

## 18. Later

The old next-steps list lives here. Data plugins are §10 (that work package), per-room content sets are §11, and the
declarative DSL is §12. Still later, by separate decisions: themes and fonts for cosmetic plugins, sandboxed code,
trusted code. DESIGN §32 keeps the plan and its open questions.

The numbers are fixed by the 0.3.0 plan: §10 data plugins, §11 per-room content sets, §12 the DSL, §13 the script
classes, §14 interface plugins, §15 the studio and tools, §16 the Forge importer, §17 the catalogue and installing by
address; each is filled in by its work package.

## Tests

`test/plugins/manifest.test.js` (manifest 2 and 1, the problems and warnings, settings, permissions, files and limits,
the catalogue), `test/plugins/registry.test.js` (the scan by class, skipped folders, duplicate ids and languages,
links, the pack view and `/packs/index.json` unchanged, `/plugins/index.json`, a plugin dropped in, the tool, git and
the release zips), `test/plugins/identity.test.js` (SHA-256 vectors, Node and a bare realm agreeing, the composition,
the same input → the same `cs`, one changed byte → another, the served bytes, the wire fields), and still
`test/i18n-packs.test.js`. P1a: `test/plugins/visual.test.js` (the overlay, references — a missing one refused —,
permissions, the lock, the browser's composition — every plugin URL from the file table, references from its own
manifest, what does not fit dropped, a failed file left out —, the merge order and its warnings, `vs`, the browser's
check), `test/plugins/order.test.js`, `test/plugins/visualSet.test.js` (sets refused or resolved, `/vs/`, `/p/` — its
whitelist, traversal, dot files, links out of the folder and into it, a folder replaced by a link, immutable or not, a
rewrite with its old mtime, audio without its extension —, one changed byte → another `vs`, `/data/assets.json`
unchanged), `test/plugins/tool.test.js` (`pack`, `check`, the template), `test/lobby-plugins.test.js` (`room.setPlugins`:
the host, before the match, un-readying, the vanilla `cs`, refusals, the result replay, the count in `/healthz` and
`welcome`, the host told when a plugin changes on disk), `test/ui/plugins-client.test.js` (the cosmetic layers, the data
view, content.js — the catalogue only on a server with plugins, an interface image falling back, the personal set —,
the panel), `test/ui/plugins-audio.test.js` (a plugin sound without its extension, falling back),
`test/render/cosmetic-refresh.test.js` (views already drawn follow a changed manifest; a failed model or picture falls back),
`test/ui/stats.test.js` (the records' `vs`), `test/media-url.test.js`, `test/ui/buildGuard.test.js` (onHealth),
`test/diag.test.js` (the content line) and the browser test `test/ui/plugins.e2e.test.js` (`SP_E2E=1`: the host's plugin
shows on another player's page, a personal plugin on its own page only; a server without plugins is never asked for its
catalogue; a personal plugin switched during a match changes the piece already on the board). P4:
`test/plugins/ui.test.js` (message shape and rate, storage quota, slots, a ui manifest accepted or refused, the `/p/`
CSP, a ui plugin leaving `cs` alone) and `test/ui/ui-plugins.e2e.test.js` (`SP_E2E=1`: the example widget in its slot,
a battle event, a match intent rejected). P1c: `test/lobby-plugins.test.js` (a content plugin's set: served, checked,
played in its match host; requirements switched on, conflicts, incompatible plugins, another player, a running match,
un-readying, `room.setMode`, the `room.contentReady` gate, loadouts checked against the room's data, the policy file,
the concurrent limit), `test/match/plugin-host.test.js` (a whole match of AI seats in a worker, `SP_VERIFY=all` in a
worker, the watchdog, extreme test data in a child process, the worker limit), `test/ui/plugins-content.test.js` (the
bytes checked before decoding, a manifest refused, `data.js` switching, the runner's `cs` check, the 自选 list, the
statistics), `test/plugins/contentSets.test.js` (a set not built twice, the limit, what `/cs/` serves) and the browser
test `test/ui/plugins-content.e2e.test.js` (`SP_E2E=1`: two pages load and check a data
plugin's set, a battle on it, the result accepted; a page claiming another `cs` is no authority).
