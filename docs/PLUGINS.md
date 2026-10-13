# PLUGINS.md — plugins (插件)

A **plugin** is a folder a server owner puts into `plugins/`: a manifest, `plugins/<id>/plugin.json`, next to the files
it names. The interface calls them 「插件」, never 「模组」 (that word is the operators' modules). The design and its
phases are DESIGN §32 (`docs/history/0.3.0.md`); this file is the reference.

**Status — 0.3.0-dev, P1a: cosmetic plugins apply.** The server finds, checks and lists plugins and names its content
with a hash (P0); a room's host switches the server's cosmetic plugins on for the whole room, a player switches them on
for themself (§9) — art, models and audio only: the battles stay the original ones and a room's `cs` stays the vanilla
one. Language packs (`docs/PACKS.md`) are the plugin class `lang` and work as before; data plugins come next (P1b).
Authors make, preview and pack a cosmetic plugin in the browser at `/studio/` — the plugin studio 插件工作台 — or with
`node tools/plugin.mjs new / check / pack`; findings come in plain words (the error catalogue), and the JSON Schemas
`schemas/plugin.schema.json` and `schemas/overlay.schema.json` help editors and AI agents (§15; a beginner's guide in
Chinese: [PLUGIN-GUIDE.md](PLUGIN-GUIDE.md), an AI agent's: `plugins/AGENTS.md`).

| File | Role |
|---|---|
| `shared/plugins/manifest.js` | the format: manifest 2 (`plugin.json`), manifest 1 (`pack.json` / `_meta`), the classes, permissions, file rules, limits, the catalogue entries |
| `shared/plugins/identity.js` | the content hash `cs`: canonical JSON and its composition |
| `shared/plugins/visual.js` | a cosmetic plugin's asset overlay (§9): reading and checking it, references, resolution to served URLs, the merge with its override warnings, the visual hash `vs`, the browser's check of a visual set |
| `shared/plugins/order.js` | which plugins a set holds and in what order: requirements, conflicts, load-order hints, priority, id |
| `shared/plugins/errors.js` | the error catalogue (§15): every `PLUGIN_*` code with its plain words in Chinese and English, what to do, its document; the coded `issues` every check returns beside its text; the symptom table |
| `shared/sha256.js` | SHA-256 in plain JavaScript (the same digest in Node and every browser, no `crypto.subtle`) |
| `server/plugins/registry.js` | the registry: the language folders, `packs/` and `plugins/` — discovery, validation (a cosmetic plugin's overlay too, its files hashed), `/packs/index.json`, `/plugins/index.json`, what may be served |
| `server/plugins/identity.js` | this server's vanilla content and its `cs`, the manifest at `/cs/<cs16>/index.json` |
| `server/plugins/visualSet.js` | the visual sets: a room's (or a player's) cosmetic plugins as one set named by `vs`, served at `/vs/<vs16>/overlay.json` (the composition and each plugin's writes, composed by the browser) |
| `server/plugins/pack.js`, `server/plugins/zip.js` | checking and packing a plugin folder: the folder's check, `plugin.lock.json` (Spine clip data parsed from the skeleton), a deterministic zip — for `tools/plugin.mjs` and the studio |
| `server/studio/` | the plugin studio (§15): `index.js` the page and its API at `/studio/` (this machine and the local network only: `gate.js`), `files.js` (only inside `plugins/<id>/`), `templates/` (one module per template), `targets.js` (by official name), `edit.js` (fields, slots, one-click fixes), `preview.js` (the temporary composition), `watch.js` (hot reload) |
| `server/packs.js`, `shared/packs.js` | the content-pack API of 0.2.0, kept (compatibility export; the language-pack index) |
| `public/js/content.js` | the browser: the room's visual set and the player's personal plugins, fetched, checked and laid over the art manifest |
| `public/js/cosmetics.js` | the cosmetic layers every screen draws through (small: the title page carries it; `shared/plugins/visual.js` loads with the first set) |
| `public/js/ui/pluginTag.js` | the room's 插件 tag and the small facts the screens show (the panel loads when the tag is tapped) |
| `public/js/ui/pluginPanel.js` | the room's 插件 panel and the title screen's list of the server's plugins — loaded when one opens |
| `public/studio/` | the studio's page (§15): `index.html`, `studio.css`, `js/` (the shell, `editors/` one module per template, `preview/` — the game's own renderer and components) |
| `schemas/plugin.schema.json`, `schemas/overlay.schema.json` | JSON Schema (2020-12) of `plugin.json` and of the asset overlay, for editors and AI agents (§15) |
| `tools/plugin.mjs` | `list`, `check` (in plain words, `--json`), `pack` (`--zip`), `new`, `errors` |
| `plugins/README.md`, `plugins/AGENTS.md`, `plugins/_template/cosmetic/` | the folder's readme, the guide for AI agents, the cosmetic template — the only tracked files of the folder |

## 1. Principles (the maintainer's decisions of 2026-10-12)

- **The original game is always the default.** A room plays the vanilla content unless its host chooses plugins (P1c);
  the golden results, DESIGN and the fidelity checks cover the original content only.
- **Plugins are marked unofficial** wherever they are shown — the catalogue (`unofficial: true` on every class but
  `lang`), the title screen (「本服务器安装了 N 个插件」), the room (「原版」 / 「插件 ×N」, the panel's 非官方 marks),
  the diagnostics (`content: … cosmetic vs=… plugins=…`, `MODDED …` for gameplay plugins), later the HUD, the result and
  the statistics (plugin matches stay out of the overview by default; a match with cosmetic plugins only is still the
  original game — §9).
- **No third-party code** in the first plugins: art and data only. Code (`script`, `ui`, `trusted`) is a later,
  separate decision (a declarative DSL first, then a sandbox; full trust only with the server owner's and every
  player's explicit consent).
- **No plugin overrides arbitrary project files**; a plugin changes only what its class allows, through its manifest.
- **Gameplay plugins are installed on the server** (every player of a room plays the same content and the server can
  still check a battle). Players never install gameplay content of their own.
- **Never put official game files in a plugin**; a plugin refers to the art the installation already has.
- **Bug reports from a plugin room** go to the plugin's author first; please reproduce on the original content.

## 2. For server owners

Put the folder into `plugins/` (the id is the folder name). `node tools/plugin.mjs list` shows what the registry found,
by class, with what this version does with each, what was skipped and why; `node tools/plugin.mjs check` checks the
folders in depth. The server prints the same at start (`[plugins] …`) and notices a new or changed plugin on the next
page load — no restart. A server's own plugins are git-ignored (only the folder's readme is tracked and ships in the
release zips; templates will join it), never packed into a release and never touched by an update. One unreadable
folder is skipped with its reason; it never stops the server.

What this version does with each class:

| Class | Carries | This version |
|---|---|---|
| `lang` | a language: UI strings, optionally game texts | **loaded** — listed in `/packs/index.json`, files served at `/packs/<id>/<file>` |
| `cosmetic` | art, models (Spine 3.8), audio (fonts and theme colours later) | **loaded** (P1a, §9) — a room's host switches it on for the room, a player for themself; the files its overlay names served at `/p/<id>/<hash8>/<path>` |
| `content` | data patches and new records: numbers, economy, modes, waves, operators, enemies | planned (P1b): checked and listed, not applied |
| `script` | code the battle or the match runs | not supported: listed, never loaded |
| `ui` | interface widgets in a sandboxed frame | not supported |
| `trusted` | page or server code with full trust | not supported |

Nothing of a plugin folder is served except the files a `lang` manifest names and the files a loaded `cosmetic`
plugin's overlay names — never `plugin.json`, the lock file, a document or any other file of the folder.

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
patches, compact operator records, modes — arrive with the class that applies them (P1b).

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
cs = sha256(canonical({ v: 1, app, sim, data, plugins, settings }))
  sim       sha256(canonical([[path, sha256], …])) of every served /sim/**.js (not nodeData.js), /shared/**.js and /data.js
  data      { <name>: sha256 } of every data/<name>.json the match or the sim reads (not assets, local-assets, emotes, i18n/)
  plugins   [{ id, version, files }] in load order — [] for the vanilla content
  settings  { <id>: { <key>: value } } — {} for the vanilla content
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
it alone, §9) and `artBytes` (the art it serves).

Cosmetic plugins never change `cs`: art changes no battle, so a room whose plugins are all cosmetic plays the vanilla
`cs` — the art it draws is named by the visual hash `vs` (§9).

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
          [--json] [--lang zh|en]                  files, paths, JSON, a cosmetic plugin's overlay (its references against
                                                   this checkout's data/assets.json) — each finding with its plain words
                                                   (§15); --json for editors and agents — exit 1 on a problem, with
                                                   --strict on a warning too
node tools/plugin.mjs pack <dir|id> … [--zip]      write plugin.lock.json (every file's SHA-256 and size, each Spine model's
          [--out <file|dir>]                       clip data), then check the folder; --zip writes the folder as a zip
                                                   (default plugins/_dist/<id>-<version>.zip)
node tools/plugin.mjs new <template> <id>          a new plugin folder from a template (art, spine, voice, audio) for a target
          [--target <名字|id>] [--name …] [--dir …] found by its official name
node tools/plugin.mjs errors [--markdown] [--write] the error catalogue; --write keeps the symptom tables of the documents
```

`--root <dir>` points it at another checkout or an unpacked release. Planned: `install`, `golden`, `simcheck`, and
`--plugins` for the balance tools.

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

## 10. Next steps

P1b data plugins (patches, compact records, kitRef / SkillSpec operators, modes, i18n), P1c per-room content sets (a
worker per content set, the client loading and checking `/cs/<cs>/`, the unofficial marks in the HUD, the result and
the statistics). Later, by separate decisions: themes and fonts for cosmetic plugins, a declarative DSL, sandboxed code,
trusted code. DESIGN §32 keeps the plan and its open questions.

## 15. The studio and the tools

Someone who does not write code makes, previews and packs a cosmetic plugin in the browser; someone who does gets a
schema, findings in plain words and hot reload. The design is DESIGN §32.9; the beginner's guide (Chinese) is
[PLUGIN-GUIDE.md](PLUGIN-GUIDE.md), the guide for AI agents `plugins/AGENTS.md`.

**The studio 插件工作台** — `http://<server>/studio/` of a running server (`server/studio/`, its page `public/studio/`):

- **Who may open it**: this machine and the local network only (`server/studio/gate.js`). The socket's peer **and**
  every address a forwarding header names (X-Forwarded-For — every hop —, X-Real-IP, CF-Connecting-IP, True-Client-IP,
  X-Client-IP, X-Cluster-Client-IP, Fastly-Client-IP, Forwarded's `for=`) must be loopback or private-network addresses
  (`server/net.js isLocalIp`); an address that cannot be read refuses too. That is stricter than `clientAddress`, which
  picks one header for the limits: a proxy that sets one header passes the others a visitor sent, so a header can refuse
  a request but never admit one, whatever `TRUST_PROXY` says. Anyone else — also a public visitor a tunnel or proxy on
  this machine names — gets the 404 page of a page that does not exist, at the page and at every API route. The Host the
  browser asked for must be a local address or a local name (a loopback or private IP, localhost, `*.localhost`, a
  machine name without a dot, `*.local`, `*.lan`, `*.home.arpa`, `*.internal`, or a name `SP_STUDIO_HOSTS` lists), so a
  web page whose own name was made to point at the machine (DNS rebinding) cannot reach it, nor a browser that reaches it
  at a public address; a change (POST, PUT, DELETE) carries the header `X-SP-Studio: 1` and, when the browser names one,
  the studio's own origin — the studio never answers a cross-origin preflight. `SP_STUDIO=local` allows this machine only
  (the peer and every forwarded address loopback), `SP_STUDIO=off` switches the studio off [ASSUMED: on for the local
  network by default]. What no address check can see — a **raw TCP tunnel** on this machine (frp `tcp`, `ssh -R`, ngrok
  `tcp` …) hands a visitor's bytes over from this machine itself with no forwarding header, and a client that is not a
  browser writes any Host — is what **the studio's key** is for (`server/studio/key.js`): every change carries it in the
  header `X-SP-Studio`, a wrong or missing one is refused (`PLUGIN_STUDIO_KEY`), whatever the address. The server prints
  the studio's address with the key when it starts (the banner's `Studio:` line, `http://localhost:3000/studio/#key=…`);
  the page keeps it in its browser (localStorage, taken out of the address bar) and asks for it when it has none (paste
  the printed address into the bar at the top). The key is kept in `plugins/.studio-key` (128 random bits, the owner's
  only; the same across restarts — delete the file for a new one). Reads — the page, the list, a plugin's files — need no
  key, so a visitor through such a tunnel can see the plugins but change nothing; `SP_STUDIO=off` hides them too
  [ASSUMED: the key file, reads without the key]. The watch and the rooms' rule (below) start with the first request
  that carries the key, never with a mere visit.
- **新建插件**: a template — 换头像 / 立绘 / 图标 (`art`: an operator's avatar, E2 avatar, portrait, E2 portrait; a summon's
  avatar, an enemy's icon, an item's, a bond's, a strategy's icon, an interface picture), 换 Spine 模型 (`spine`: an
  operator's front and back model, a summon's or an enemy's), 换语音 (`voice`: every battle line of an operator, Chinese and
  Japanese dub), 换音乐 / 音效 (`audio`: a music track with its intro, a leader's music, an interface or battle sound, a
  unit's own sounds) —, what it changes found by its **official name** (`server/studio/targets.js`: operators, summons,
  enemies, items, bonds, strategies, interface pictures, music, sounds, each with its picture), a name; the id is made
  from it (a legal one nobody has, editable). The folder gets `plugin.json` and a README — no file of the game, no
  picture: an empty entry is a valid plugin that changes nothing yet. More templates and targets join a plugin with
  「添加替换内容」 (an operator's avatar, model and voice in one plugin); the page keeps what it shows in the dot file
  `.studio.json` of the folder (never listed, served, checked or packed; a plugin made by hand gets its sections read
  off its overlay).
- **Slots**: every place a template fills, the installation's art beside the plugin's. Files dropped on a slot (or
  picked) go into the plugin folder under the slot's name — `art/<key>/avatar.png`, `spine/<key>/front/<key>.skel` and
  `.atlas` under one name with the atlas's pages by their own names and `textures` read from the atlas,
  `voice/<key>/cn/<line>.mp3` (several: `_1`, `_2` …, played in turn), `music/<key>/loop.ogg` and `intro.ogg` — and the
  overlay names them; a file the slot named before and nothing names now is removed (also when a reference takes its
  place). A track keeps the part not sent (「放入前奏」 adds the intro to its loop; a new loop keeps the intro; two files at
  once: the one named `intro…` is the intro). A model's new skeleton comes with its atlas, unless the model already sits
  under the slot's own name; the atlas's page names must be plain names (they are the files' names). 「用已有的素材」
  borrows the installation's own art instead (`{ "ref": "<key>" }`, found by name); 「恢复原版」 empties the slot.
- **Findings**: the server's own checks (`server/plugins/pack.js checkPluginFolder` — exactly what the registry and
  `tools/plugin.mjs check` run), each in plain words beside the slot or field it is about (its `at` path), with what to
  do, the technical line folded under it and — where the error catalogue has one — 「一键修复」: the missing permission
  added, an unused one removed, `manifest` / `version` / `app` / `api` / `scope` set, an unknown field removed, a write
  the installation cannot resolve removed, the model's pages put into `textures`, the lock packed, a file of a type the
  plugin may not carry moved out to `plugins/_moved/<id>/` (never deleted).
- **Preview**, with the original beside the plugin, drawn by the game itself (`public/studio/js/preview/`): the
  battlefield view (`render/app.js`, the official board when installed) with the operator, summon or enemy on the board of
  the preparation phase or in a battle, playing the role picked — 待机, 移动, 攻击, 技能 (S1–S3), 眩晕, 倒下, 部署 — fed as a
  real battle feeds it (b.snap tuples and b.ev events), front or back model; the card picture of the shop and the bench
  (`ui/gameComponents.js UnitThumb`, also the E2 one) and the portrait in the detail card (`ui/detailPanel.js
  ChessDetail`); every voice line, track and sound with its play buttons. The plugin's art is the temporary composition
  of the plugin as it is now (`GET /studio/api/plugins/<id>/preview`, `server/studio/preview.js`) — also while it has
  problems and before it is packed (a model's clips are then read from the skeleton itself) — laid over the page's own
  manifest under keys of their own (`<key>~plugin`), so one renderer draws both; a new preview redraws in place.
- **信息 / 文件 / 清单**: the basic fields (name, description, version, authors, licence, credits — where the art comes
  from —, homepage, who may switch it on), every file of the folder (the ones nothing uses marked, each removable),
  `plugin.json` itself for those who prefer to write it.
- **打包并下载**: `plugin.lock.json` written (the packer of `tools/plugin.mjs pack`), the folder checked, and the zip
  downloaded — `<id>-<version>.zip` holding `<id>/…`, every file but dot files, deterministic (the same files give the
  same bytes: a zip can be pinned by its SHA-256). The packer does not screen for official game files (the owner's
  decision of 2026-10-13): what a plugin carries is its author's responsibility — and §1 still asks never to put them in.

**Hot reload** (`server/studio/watch.js`): from the studio's first request on, `plugins/` is watched (fs.watch over the
tree, the events of 300 ms gathered into one [ASSUMED]); then the registry reads the folders again
(`registry.rescan()`), the visual sets look at the sets rooms hold, and a room whose set changed — every studio write
rescans at once — applies the same plugins again by itself when its host is the author (a game session the studio's page
named: `POST /studio/api/authors` with the tokens of this browser's `sp.tokens`, kept 10 minutes after the page last named
them [ASSUMED]) or its host is its only player (a single-player room, or a room the host is alone in): a new `vs` in
`room.state`, during a match too (art never changes a battle; nobody is un-readied: `server/lobby.js refreshPlugins`); any
other room's host is told as before (§9). Such a room follows every rescan that changes one of its plugins, also after a
plugin was broken for a moment while its author saved it (the visual sets tell a held set once; the studio looks again
after each rescan). A server whose owner never opens the studio watches nothing and keeps §9's behaviour exactly. The studio's page hears the plugins whose state changed (`GET /studio/api/events`, server-sent events;
at most three streams from one address, and a page the browser keeps in its back / forward cache closes its own — a
browser keeps only about six connections to a server) and reloads its view — an author saving from Spine or an image
editor sees the preview follow. A player's personal
plugins follow on the next catalogue fetch (not pushed).

**The API** (for experienced authors and agents; the page uses nothing else; a change carries `X-SP-Studio: <the key in
plugins/.studio-key>` and answers with the plugin's state, an error `{ error: <code>, params, detail }`; HEAD answers as
GET without the body):

| Route | What |
|---|---|
| `GET /studio/api/info` · `targets?q=&kinds=` · `slots?template=&target=` · `suggest-id?name=&target=&template=` | the templates and limits; targets by official name; a template's slots for a target; a free id |
| `GET /studio/api/plugins` · `POST /studio/api/plugins` | every plugin folder (loaded or skipped, its codes); a new plugin `{ template, id, name, target, authors, license, credits }` |
| `GET /studio/api/plugins/<id>` | its manifest and text, overlay, files, sections, findings (`check.issues`: coded), registry view (`loaded`, `vs`), lock |
| `PUT …/manifest` · `POST …/meta` · `POST …/sections` | plugin.json as a whole; the basic fields `{ fields, lang }`; the sections the page shows |
| `POST …/slot` · `…/ref` · `…/clear` · `…/fix` | files for a slot `{ at, files: [{ name, data (base64), role? }] }`; a reference `{ at, ref }`; a slot emptied `{ at }`; a one-click fix `{ code, at?, file?, params? }` |
| `POST …/pack` · `GET …/zip` · `GET …/preview` | the lock and the check; the zip (a download, packs nothing); the temporary composition |
| `GET …/f/<hash8>/<path>`, `…/files/<path>` · `PUT` / `DELETE …/files/<path>` | a file of the folder (a draft's too) — of the types the studio writes only, sandboxed (`Content-Security-Policy: default-src 'none'; sandbox`); write or remove one |
| `POST /studio/api/authors` · `GET /studio/api/events` | name the page's game sessions; the change events |

**The files** (`server/studio/files.js`): everything the studio touches is inside `plugins/<id>/` — the id a plugin id
(never a `_` template or a dot folder), a path a plain relative path (no `..`, no `.` part, no hidden part, ≤ 200
characters) of a type a plugin carries (art, models, audio, fonts, JSON, documents; never the lock by hand); no link inside
the folder is followed (every folder on the way and the file are lstat'ed; a plugin folder that is itself a link, the
owner's choice, is followed once) — neither for the studio's reads (plugin.json, an overlay file, the lock, its own note
`.studio.json`; a folder holding links is checked for its links alone) nor for its writes (the lock and the note are
renamed over a link put in their place, `plugins/_moved/` must be a plain folder), and the packer reads no file through
a link either (`server/plugins/pack.js plainPath`); a write goes to a dot-named temporary file renamed over the target;
a body over the limit is refused before it is read and its connection closed; a file at most
64 MB, plugin.json at most 1 MB, a request at most 160 MB (a model's files in one go, base64), a plugin at most 200 MB
and 5000 files [ASSUMED: the studio's limits].

**The error catalogue** (`shared/plugins/errors.js`, the 0.3.0 plan's interface C6): every `PLUGIN_*` code — the
manifest and file rules, a cosmetic plugin's overlay and lock, the registry's scan, the packer, a room's refusals (the
ERR codes) and the studio's API — with `{ zh, en, fix: { zh, en }, doc }` (and the studio's one-click fix where there is
one). The checks return `issues` beside their unchanged `problems` / `warnings` text: `{ level, code, text, at?, file?,
params }`. The studio shows them beside their field, `tools/plugin.mjs check` prints the plain words under each technical
line (`--lang zh|en`, `--json` for editors and agents), the server's start log adds the plain words of a skipped plugin's
first problem. The interface shows the Chinese text in a Chinese interface (中文, 繁體中文) and the English text in the
others [ASSUMED]. A new code goes into the catalogue (`test/plugins/errors.test.js` fails on a code the code names that it
lacks). The table below is generated from it (`node tools/plugin.mjs errors --write`):

<!-- plugin-errors:start (generated by node tools/plugin.mjs errors --write) -->
| Symptom | Code | Cause | Fix |
|---|---|---|---|
| The room will not switch it on; the panel says why | `PLUGIN_UNKNOWN` | This server has not installed that plugin | Put the plugin folder into the server's plugins/ folder (the folder name is the plugin id); if it is gone, switch it off in the 插件 panel. |
| The room will not switch it on; the panel says why | `PLUGIN_BLOCKED` | That plugin cannot be switched on here: this version does not apply its class, or its scope does not include this place | A cosmetic plugin has "class": "cosmetic"; its scope is ["room"] (the host switches it on for the room), ["personal"] (a player for themself) or both. |
| The room will not switch it on; the panel says why | `PLUGIN_DEPENDENCY` | A plugin it requires is missing or out of its version range, or the load-order hints of some plugins form a cycle | Install the plugins its "requires" names (within their ranges), or remove the loadAfter / loadBefore entries that point at each other. |
| The room will not switch it on; the panel says why | `PLUGIN_CONFLICT` | The chosen plugins conflict with each other | Switch one of them off; a plugin's "conflicts" says which ones it cannot be used with. |
| The room will not switch it on; the panel says why | `PLUGIN_LIMIT` | Over this server's limit: {detail} | Switch on fewer plugins, or make them smaller (compress pictures and sounds, remove unused files, fewer whole-record references). |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_NO_MANIFEST` | The plugin folder has no plugin.json | Every plugin folder needs a plugin.json (its manifest). The studio's 新建插件 or node tools/plugin.mjs new writes one. The older pack.json belongs to a language pack in packs/. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_JSON` | {where} cannot be read: it is not valid JSON, or too large | Look for a missing or extra comma, quote or bracket (no comma after the last item); a JSON file may be 8 MB at most. Editing in the studio avoids typing mistakes. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_JSON_LIMIT` | {where} is beyond the JSON limits (nested too deep, or a number too large) | Nest at most 64 levels; numbers must be finite and within ±1,000,000,000. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_MANIFEST_SHAPE` | plugin.json is not a JSON object at the top | The whole file is one { } object of "name": value pairs. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_MANIFEST_VERSION` | "manifest": 2 is missing or another number | Write "manifest": 2 in plugin.json (the version of the manifest format; 2 is the only one). (the studio fixes it in one click) |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_ID` | The folder name “{id}” is not a plugin id | The plugin id is the folder name: 2–32 lower-case letters, digits and -, not starting with - (e.g. texas-red). Rename the folder. |
| The plugin works, with a note in the check | `PLUGIN_ID_MISMATCH` | The "id" in the manifest is not the folder name “{id}”; the folder name decides | Remove "id" from the manifest (the folder name is the id) or make it the folder name. (the studio fixes it in one click) |
| The plugin works, with a note in the check | `PLUGIN_FIELD_UNKNOWN` | “{where}” is not a field of the manifest and is ignored | Check its spelling (case matters) or remove it. (the studio fixes it in one click) |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_CLASS` | "class" is missing or not a plugin class | A cosmetic plugin has "class": "cosmetic". The classes: lang, cosmetic, content, script, ui, trusted. |
| The plugin works, with a note in the check | `PLUGIN_TEXT` | “{where}” should be a text or { "<lang>": "text" }; it is ignored | Write "Name" or { "zh": "名字", "en": "Name" }. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_LANG_CODE` | “{where}” is not a language code | Use a language code such as zh, en, ja, ko or zh-TW. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_VERSION` | The plugin's "version" is missing or not a version number | Write three numbers such as "1.0.0"; raise it whenever the plugin changes (1.0.1, 1.1.0 …). (the studio fixes it in one click) |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_APP` | The game versions the plugin is made for, "app", are missing or not a range | Write a range such as ">=0.3.0 <0.4.0" (this game is {app}). (the studio fixes it in one click) |
| The plugin works, with a note in the check | `PLUGIN_APP_MISMATCH` | The plugin is made for the game {range}; this server is {app} | A cosmetic plugin still works (a reminder only). Once it is checked with this version, widen "app" to include {app}. (the studio fixes it in one click) |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_API` | The plugin API level "api" is missing, not an integer, or not supported | Write "api": {current} (this game supports {min}–{current}). (the studio fixes it in one click) |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_SCOPE` | "scope" is not one this class allows | A cosmetic plugin has ["room", "personal"]: room — the host switches it on for the whole room; personal — a player for themself in 设置. (the studio fixes it in one click) |
| The plugin works, with a note in the check | `PLUGIN_HOMEPAGE` | "homepage" is not an http(s) address and is ignored | Write a full address such as https://example.com/my-plugin, or remove it. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_DEPS` | A dependency (requires / optional / conflicts) is not right: {where} | Write { "<plugin id>": "<version range>" }, e.g. { "base-skin": ">=1.0.0" }; never the plugin itself, never one both required and in conflict, at most 32. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_ORDER_HINTS` | A load-order hint (loadAfter / loadBefore / priority) is not right: {where} | loadAfter and loadBefore are lists of plugin ids (never one in both, never the plugin itself); priority is an integer within ±1000, default 0. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_SETTING` | A setting is not right: {where} | Each setting is { "type": … }: boolean, integer / number (with min and max), enum (with options); its default within them; at most 32, no free text. |
| The plugin works, with a note in the check | `PLUGIN_SETTING_FIELD` | A setting has a field it does not know, “{where}”; it is ignored | A setting knows type, default, min, max, step, options and label only. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_PART_CLASS` | “{where}” is not something a {class} plugin carries | A cosmetic plugin carries "assets" and "theme" only; numbers and new operators belong to a content plugin. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_PART_SHAPE` | “{where}” is not written the right way | Write the path of a .json file of the plugin folder (or a list of them); "assets" and "theme" may also be the { … } object itself. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_ASSET_FILE` | The file of “{where}” is not right: not a path inside the plugin folder, or not the kind of file this place takes | Write a path inside the plugin folder such as art/avatar.png. Pictures are .png .jpg .webp, sounds .mp3 .ogg, models .skel with .atlas (pages .png). |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_THEME_URL` | "theme" names a URL | A theme sets colours, lengths and the plugin's own font names only — never a URL (it could leak data). |
| The plugin works, with a note in the check | `PLUGIN_THEME_UNUSED` | This version does not apply "theme" yet (only the art of "assets") | Keep it for a later version, or remove it to silence the note. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_ENTRY` | An entry point is not right, or this class has none: {where} | A cosmetic plugin needs no "entry": remove it. Code plugins (script, ui, trusted) are not loaded by this version. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_LANG_ONLY` | “{where}” belongs to a language pack (class lang), not a {class} plugin | Remove it; for a language pack, make "class": "lang". (the studio fixes it in one click) |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_PERMISSION` | A permission is not right: “{where}” is unknown or not one a {class} plugin may have | A cosmetic plugin's permissions: assets.override (replace art the installation has), assets.add (a new entry), theme. "permissions" is a list. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_PERMISSION_MISSING` | “{where}” needs the permission {need}, which the manifest does not declare | Add "{need}" to "permissions". (the studio fixes it in one click) |
| The plugin works, with a note in the check | `PLUGIN_PERMISSION_UNUSED` | The permission {permission} is declared but nothing in the plugin uses it | Remove "{permission}" from "permissions" (the fewer, the more trust). (the studio fixes it in one click) |
| The plugin works, with a note in the check | `PLUGIN_EMPTY` | The plugin carries nothing | A cosmetic plugin lists the art it replaces in "assets". The studio's templates are the easiest start. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_FILE_LINK` | {where} is a symbolic link; a plugin holds plain files only | Copy the real file into the plugin folder and remove the link. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_FILE_NAME` | The file name “{where}” cannot be used | Names of files and folders use letters, digits, . _ - and spaces; none starts with . or is "..". |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_FILE_TYPE` | {where}: a {class} plugin may not carry this kind of file | Pictures are .png .jpg .webp (no SVG), sounds .mp3 .ogg, models .skel .atlas; documents (.md, .txt, README, LICENSE) may sit beside them. Move the file out of the plugin folder (the one-click fix moves it to plugins/_moved/, never deletes it) or convert it. (the studio fixes it in one click) |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_FILE_FRAME` | {where} is a frame file outside the folder of entry.client | Put a ui plugin's .html .js .css into the folder of entry.client. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_FILE_SIZE` | The plugin is too large: {where} | A plugin holds at most 200 MB in 5000 files, a JSON file at most 8 MB. Compress pictures and sounds, remove unused files, or split it. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_FILE_MISSING` | The manifest names {file}, which the plugin folder does not hold | Put the file there (folders and case must match) or correct the path in the manifest. Dropping the file on its slot in the studio puts it in the right place. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_FILE_OUTSIDE` | {where} leads out of the plugin folder or cannot be read inside it | A plugin uses plain files of its own folder only: copy the file in (no link) and check that it opens. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_LANG` | A language pack's language is not right: {where} | "lang" is a language code (en, ja, zh-TW …); zh is the source language and never a pack; machineTranslated is true or false. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_LANG_FILES` | A language pack's "files" are not right: {where} | "files" is { "ui": "ui.json" } (required) and optionally "data", both .json files of the pack. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_PACK` | An older content pack (pack.json) is not right, or this version does not load its type: {where} | packs/ loads language packs ("type": "lang") only. Art and data are plugins of plugins/ (plugin.json, "manifest": 2). |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_ASSETS_SHAPE` | The asset overlay is not written the right way: {where} | Follow data/assets.json: chars → operator id → avatar / portrait / spine …, sounds under audio. The studio's templates write it for you. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_ASSET_KEY` | “{where}” is not the name of an asset entry | An entry is named by an internal id such as char_102_texas (letters, digits, _ . / -). The studio finds it by its official name. |
| The plugin works, with a note in the check | `PLUGIN_ASSET_IGNORED` | “{where}” is not something a cosmetic plugin changes; it is ignored | Check the spelling; PLUGINS.md §9 lists what a cosmetic plugin changes (avatars, portraits, models, icons, interface pictures, voices, sounds, music). (the studio fixes it in one click) |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_REF` | The reference at “{where}” is not right: not written as one, or the installation has no such art | { "ref": "char_112_siege" } borrows an entry of the same kind the installation has. Pick it from the list with the studio's 用已有的素材, or remove the write. (the studio fixes it in one click) |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_SPINE` | The Spine model at “{where}” is not right | The .skel and the .atlas sit side by side with one name (t.skel + t.atlas), the .png pages beside the atlas and in "textures"; clip data is never written by hand — 打包 makes it. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_SPINE_PAGES` | {file} uses a page that "textures" does not list | List every page of the atlas in "textures" (the one-click fix fills it from the atlas). (the studio fixes it in one click) |
| The plugin works, with a note in the check | `PLUGIN_SPINE_NOTE` | The model {file} has a small issue: {detail} | Usually "textures" names a picture the atlas does not use, or a part is missing from the atlas. The model usually still shows: look at it in the preview. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_SPINE_PARSE` | The model {file} cannot be read: not a Spine 3.8 binary skeleton the game reads, or it has no animations | Export a binary .skel with Spine 3.8 (not a .json skeleton), with its animations (Idle, Attack, Die …). |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_LOCK` | plugin.lock.json is broken or of another format | Make it again with the studio's 打包 or node tools/plugin.mjs pack; never edit it by hand. (the studio fixes it in one click) |
| The plugin is skipped: its model is not packed yet | `PLUGIN_LOCK_MISSING` | The model {file} has no clip data yet (plugin.lock.json lacks it) | Press 打包 (or run node tools/plugin.mjs pack <plugin>): it reads the model's clips into plugin.lock.json. (the studio fixes it in one click) |
| The plugin disappeared after a model file was replaced | `PLUGIN_LOCK_STALE` | The model {file} changed; plugin.lock.json still holds the old one's data | Press 打包 again (or run node tools/plugin.mjs pack): the lock follows the new model. (the studio fixes it in one click) |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_DUPLICATE` | A plugin id or a language is taken twice: {where} | Rename the folder (the plugin id; on Windows and macOS another case is the same name) or remove the duplicate. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_UNREADABLE` | Reading the plugin failed: {detail} | Check the files' permissions; if a program is writing the folder, wait until it is done. |
| The plugin works, with a note in the check | `PLUGIN_REQUIRES_MISSING` | The plugin it requires, {dep}, is not installed or not within {range} | Install the required plugin within its range; otherwise a host switching it on is refused. |
| The studio refuses the action and says why | `PLUGIN_STUDIO_PATH` | This path cannot be used: {detail} | Files stay inside the plugin's own folder: no .., no part starting with ., no special characters, no link leading out. |
| The studio refuses the action and says why | `PLUGIN_STUDIO_SIZE` | The file is too large (at most {max}) | Compress the picture or sound first (a portrait within 1024 px as PNG / WebP is plenty). |
| The studio refuses the action and says why | `PLUGIN_STUDIO_EXISTS` | There is a plugin “{id}” already | Choose another id, or open that plugin from the list. |
| The studio refuses the action and says why | `PLUGIN_STUDIO_TEMPLATE` | No such template: {template} | Pick one of the studio's templates (node tools/plugin.mjs new without arguments lists them). |
| The studio refuses the action and says why | `PLUGIN_STUDIO_TARGET` | No target “{target}” to replace | Search by its official name (e.g. 德克萨斯) and pick one of the results. |
| The studio refuses the action and says why | `PLUGIN_STUDIO_FILE_KIND` | This place takes {kind}; the dropped file is {ext} | A picture place takes .png .jpg .webp, a sound place .mp3 .ogg, a model place its .skel, .atlas and .png together. |
| The studio refuses the action and says why | `PLUGIN_STUDIO_REQUEST` | The studio's request is not right: {detail} | Reload the studio and try again; if it stays, ask on GitHub with this text. |
| The studio only shows plugins; it cannot make or change one | `PLUGIN_STUDIO_KEY` | Changing a plugin needs the studio's key, which this browser does not have (or it is not the right one) | Open the address on the "Studio" line of the server's window (it carries the key, which is also in plugins/.studio-key), or paste it into the box at the top of the studio. |
| The plugin is not listed (skipped); the start log and check say why | `PLUGIN_INVALID` | The plugin has a problem: {detail} | Read the original line; if it is unclear, ask on GitHub with it. |
<!-- plugin-errors:end -->

**Schemas** (the plan's interface C7): `schemas/plugin.schema.json` (manifest 2) and `schemas/overlay.schema.json` (the
asset overlay), JSON Schema 2020-12 — write `"$schema": "../../schemas/plugin.schema.json"` in a plugin.json (the studio
and `new` do) and an editor completes and checks it. A manifest or overlay is accepted exactly when the checks find
neither a problem nor a warning in it, on one shared set of fixtures (`test/plugins/schema.test.js`); what only the checks
see is named in the schemas' descriptions: the folder (the id is its name; the files exist, of the class's types), the
running game's version against `app`, a plugin both required and in conflict or both after and before, a setting's min ≤
max and default within them, a theme naming a URL, an atlas beside its skeleton with its name, references the
installation lacks, the limits. The schema is a little stricter than the checks where they silently ignore a value of
another type (`englishName`, `credits`, `license`, `authors`).

**Templates are modules**: a template is one file of `server/studio/templates/` (its class, its target kinds, its
slots for a target, the overlay of a new plugin) beside one of `public/studio/js/editors/` (its previews and what its
slots take); the data, DSL, script and interface templates of later steps are added the same way.

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
catalogue; a personal plugin switched during a match changes the piece already on the board). The studio and the tools
(§15): `test/plugins/errors.test.js` (every code in the catalogue, both languages, the documents' anchors, the one-click
fixes, every finding of a set of broken plugins coded with its placeholders filled, the generated tables),
`test/plugins/schema.test.js` (the schemas and the checks agree on one fixture set; the templates are accepted),
`test/plugins/tool.test.js` (`new` for every template passes `check --strict` and `pack`, the plain words, `--json`,
`pack --zip`, `errors`), `test/studio/studio.test.js` (the gate, the confined files and limits, the API, the zip),
`test/studio/hotreload.test.js` (the watch; a single-player room and an author's room apply a change by themselves, during
a match too, any other host is told, the studio not opened keeps §9; the events) and the browser test
`test/ui/studio.e2e.test.js` (`SP_E2E=1`: a new plugin, an operator by its name, a PNG dropped and previewed in the game's
card, packed into a zip; a public address refused).
