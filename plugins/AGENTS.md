# plugins/AGENTS.md — making a plugin with an AI agent

For AI coding assistants (Claude Code, Codex, Cursor, Copilot …) asked to make or fix a plugin of 卫戍协议：盟约. Do not
learn the rules from long prose: let the schema and the checker tell you, and loop until they are quiet. The reference is
[docs/PLUGINS.md](../docs/PLUGINS.md) (§3 manifest, §4 permissions, §5 files, §9 cosmetic plugins, §15 studio and tools);
people read [docs/PLUGIN-GUIDE.md](../docs/PLUGIN-GUIDE.md).

## The loop

1. **Start from a template** — never from a blank file:
   `node tools/plugin.mjs new <art|spine|voice|audio> <id> --target <official name or id> --name "<name>"`
   (`node tools/plugin.mjs new` lists the templates). The id is the folder name: `^[a-z0-9][a-z0-9-]{1,31}$`.
2. **Write against the schema.** `plugins/<id>/plugin.json` starts with `"$schema": "../../schemas/plugin.schema.json"`;
   the asset overlay (`"assets"`) is `schemas/overlay.schema.json`. A manifest the schema accepts is one the checker finds
   clean, except for what needs the folder (files that exist, their types), the running game's version and a few
   cross-field rules — the checker sees those.
3. **Check, read the codes, fix, repeat:** `node tools/plugin.mjs check <id> --json` → `{ folders: [{ issues: [{ level,
   code, at, file, params, message, fix, doc, autofix }] }], problems, warnings }`. `code` is stable (the catalogue:
   `shared/plugins/errors.js`); `at` is the path in plugin.json; `fix` says what to do; `autofix` names the studio's
   one-click fix. Stop when `problems` and `warnings` are 0 (`--strict` makes warnings fail too).
4. **Pack:** `node tools/plugin.mjs pack <id> --zip` writes `plugin.lock.json` (file hashes, each Spine model's clips
   parsed from the skeleton) and `plugins/_dist/<id>-<version>.zip`. Pack again after any change to a skeleton.

## Rules the checker enforces (so you can plan, not guess)

- A cosmetic plugin carries `assets` (and `theme`, not applied yet); permissions: `assets.override` to change an entry the
  installation has, `assets.add` for a new one. Every part needs its permission; every declared permission must be used.
- Values are paths **inside the folder** (`art/a.png`; no `..`, no leading `/`, no URL, no hidden part), of the field's
  kind: images `.png .jpg .webp` (no SVG), audio `.mp3 .ogg`, Spine `{ "skel": "m/t.skel" }` with `m/t.atlas` beside it
  and its pages in `m/`; or a reference `{ "ref": "<key>" }` to the installation's own entry of the same container.
- Never write a Spine model's `animations`, `events`, `hits`, `bounds` or `anims` by hand (`"anims": "auto"` at most):
  `pack` reads them. Never hand-edit `plugin.lock.json`.
- Never put files of the official game into a plugin (the tools do not screen for them; it is the author's
  responsibility). Use references to borrow the installation's art.
- Keys you do not know are found by name: `GET /studio/api/targets?q=德克萨斯` on a running server (local network only;
  a read needs no key), or the template's `--target`.

## The studio's API (when a server runs)

The browser studio at `/studio/` uses an HTTP API you can use too (this machine and the local network only; every change
needs the header `X-SP-Studio: <key>`, the key being the content of `plugins/.studio-key` — a wrong or missing one answers
403 `PLUGIN_STUDIO_KEY`): create a plugin, put files on a slot (base64), set references, apply one-click fixes, pack,
download the zip, read the preview composition — the table is in docs/PLUGINS.md §15. Every answer of a change is the
plugin's state with `check.issues` (the same coded issues as `check --json`).

## Do not

- Do not invent fields or permissions (unknown fields are warnings; unknown permissions are problems).
- Do not copy plugin folders across with links (a link inside a plugin folder keeps it out).
- Do not commit a server's plugins to this repository (`plugins/*` is git-ignored but for this file, the readme and the
  templates).
