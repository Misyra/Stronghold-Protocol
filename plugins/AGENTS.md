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
- Do not copy plugin folders across with links (a link inside a plugin folder keeps it out; a plugin folder that is
  itself a link is never opened by the studio).
- Do not commit a server's plugins to this repository (`plugins/*` is git-ignored but for this file, the readme and the
  templates).


## Script plugins (P3a)

Start from `plugins/_template/script/`, copied to `plugins/script-demo/`. Rename every script_demo record namespace
with the folder id. Entry modules export synchronous `setup(sp)` and may import only `sp:sdk@1`; use the stable helpers
listed in [PLUGINS §13](../docs/PLUGINS.md#13-scripts-p3a), SIM §5–7 for hooks/kits and META §2 for prep handlers.
Declare sim.code/meta.code for the APIs used, and overrides for any official kit replaced. Keep state per battle;
use seeded battle.rng, deterministic sp.math and battle timers. Do not claim portability scanning is a sandbox.

Run `check <id> --strict`, `pack <id>` and `test <id>` (the last command executes the author's tests locally with its
composed data). Never hand-edit the lock. Production execution additionally needs the owner mode, exact lock pin and
all players' consent; public listeners refuse it by default. A true infinite loop is outside the P3a budget's ability
to interrupt. Explain that limitation when handing a script to its author. No official game art belongs in the template.
