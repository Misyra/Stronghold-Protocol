# PLUGINS.md — plugins (插件)

A **plugin** is a folder a server owner puts into `plugins/`: a manifest, `plugins/<id>/plugin.json`, next to the files
it names. The interface calls them 「插件」, never 「模组」 (that word is the operators' modules). The design and its
phases are DESIGN §32 (`docs/history/0.3.0.md`); this file is the reference.

**Status — 0.3.0-dev, the first step (P0): content identity and the registry, no change for players.** The server
finds, checks and lists plugins and names its content with a hash; it applies no plugin yet. Language packs
(`docs/PACKS.md`) are the plugin class `lang` and work as before.

| File | Role |
|---|---|
| `shared/plugins/manifest.js` | the format: manifest 2 (`plugin.json`), manifest 1 (`pack.json` / `_meta`), the classes, permissions, file rules, limits, the catalogue entries |
| `shared/plugins/identity.js` | the content hash `cs`: canonical JSON and its composition |
| `shared/sha256.js` | SHA-256 in plain JavaScript (the same digest in Node and every browser, no `crypto.subtle`) |
| `server/plugins/registry.js` | the registry: the language folders, `packs/` and `plugins/` — discovery, validation, `/packs/index.json`, `/plugins/index.json`, what may be served |
| `server/plugins/identity.js` | this server's vanilla content and its `cs`, the manifest at `/cs/<cs16>/index.json` |
| `server/packs.js`, `shared/packs.js` | the content-pack API of 0.2.0, kept (compatibility export; the language-pack index) |
| `tools/plugin.mjs` | `list`, `check` |
| `plugins/README.md` | the folder's readme — the only tracked file of the folder (templates, `plugins/_template/`, will join it with P1) |

## 1. Principles (the maintainer's decisions of 2026-10-12)

- **The original game is always the default.** A room plays the vanilla content unless its host chooses plugins (P1c);
  the golden results, DESIGN and the fidelity checks cover the original content only.
- **Plugins are marked unofficial** wherever they are shown — the catalogue (`unofficial: true` on every class but
  `lang`), the diagnostics (`content: MODDED …`), later the room, the HUD, the result and the statistics (plugin
  matches stay out of the overview by default).
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
| `cosmetic` | art, models (Spine 3.8), audio, fonts, theme colours | planned (P1a): checked and listed, not applied |
| `content` | data patches and new records: numbers, economy, modes, waves, operators, enemies | planned (P1b): checked and listed, not applied |
| `script` | code the battle or the match runs | not supported: listed, never loaded |
| `ui` | interface widgets in a sandboxed frame | not supported |
| `trusted` | page or server code with full trust | not supported |

Nothing of a plugin folder is served in this version except the files a `lang` manifest names.

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
Unknown fields are warnings. The inner formats of the parts — data patches, compact operator records, asset entries,
modes — arrive with the classes that apply them (P1a, P1b).

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
(always the vanilla set in this version), `/healthz` `content: { vanilla, sets: 0 }`, every BattleSpec's `cs` (the sim
never reads it), an optional `b.result.cs`, and the second line of a diagnostic report (`content: vanilla cs=<64 hex>`;
a room with plugins will read `MODDED cs=… plugins=id@version(hash)…`).

`GET /cs/<first 16 hex digits>/index.json` answers the content set's manifest — every code file's hash, every data
file's URL (`/data/<file>?v=<8 hex>`), hash and size — cached for good; any other `cs` is 404. `GET /plugins/index.json`
(never cached) is the catalogue: `{ version, app, api, content: { vanilla }, plugins: [entry …] }`, every plugin and
pack found by class and id, with its `status` (`loaded` / `planned` / `unsupported`), `unofficial`, its manifest's
public fields, size and file count — never a path on the server.

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
                                                   files, paths, JSON — exit 1 on a problem, with --strict on a warning too
```

`--root <dir>` points it at another checkout or an unpacked release. Planned: `new`, `pack` (`plugin.lock.json`, a
zip), `install`, `golden`, `simcheck`, and `--plugins` for the balance tools.

## 9. Next steps

P1a cosmetic plugins (room and personal; `/p/<id>/<fileHash8>/<path>`, `/vs/<vs>/assets.json`), P1b data plugins
(patches, compact records, kitRef / SkillSpec operators, modes, i18n), P1c per-room content sets (the host's 插件 panel,
a worker per content set, the client loading and checking `/cs/<cs>/`, the unofficial marks in the UI and the
statistics). Later, by separate decisions: a declarative DSL, sandboxed code, trusted code. DESIGN §32 keeps the plan
and its open questions.

## Tests

`test/plugins/manifest.test.js` (manifest 2 and 1, the problems and warnings, settings, permissions, files and limits,
the catalogue), `test/plugins/registry.test.js` (the scan by class, skipped folders, duplicate ids and languages,
links, the pack view and `/packs/index.json` unchanged, `/plugins/index.json`, a plugin dropped in, the tool, git and
the release zips), `test/plugins/identity.test.js` (SHA-256 vectors, Node and a bare realm agreeing, the composition,
the same input → the same `cs`, one changed byte → another, the served bytes, the wire fields), and still
`test/i18n-packs.test.js`.
