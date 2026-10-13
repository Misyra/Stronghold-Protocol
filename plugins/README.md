# plugins/ — 插件 · plugins

A server owner puts plugins here, one folder each: `plugins/<id>/plugin.json` (the manifest) next to the files it names.
The server lists what it finds at `/plugins/index.json` and notices a new or changed plugin on the next page load.
`node tools/plugin.mjs list` shows what was found, what was skipped and why; `node tools/plugin.mjs check` checks the
folders (manifest, file types, sizes, paths, JSON).

**This version (0.3.0-dev):**

- the original game is always the default; a plugin is marked unofficial wherever it is shown;
- class `lang` (a language) loads, like a language pack in `packs/`;
- class `cosmetic` (art, models, audio) loads: a room's host switches it on for the whole room (the room's 插件 panel),
  a player for themself (设置 → 外观插件) — it changes what is shown and heard, never a battle;
- class `content` (data: numbers, modes, new operators and enemies) loads as a JSON snapshot and builds validated content
  sets: a room's host switches it on for the room (the room's 插件 panel) — every page downloads and checks the room's
  content set, and its matches are unofficial (left out of the statistics overview unless a player counts them);
- class `ui` (an interface widget) loads in a sandboxed frame: each player switches it on for this browser (设置 →
  界面插件). It can read a little of the match on screen and cannot play it. It does not change `cs`;
- classes `script` and `trusted` are listed as not supported — no plugin code runs inside a battle;
- nothing in this folder except this readme and the templates in `_template/` is committed or shipped: your plugins
  stay yours, and an update never touches them.

**Make one in the browser:** open `/studio/` of the running server — the plugin studio 插件工作台 (this machine and the local
network only): pick a template, find what to change by its official name, drop your files on their places, compare with
the original in the game's own preview, press 打包并下载 for the zip. The beginner's guide (Chinese):
[docs/PLUGIN-GUIDE.md](../docs/PLUGIN-GUIDE.md); for AI agents: [AGENTS.md](AGENTS.md).

On the command line: `node tools/plugin.mjs new art my-skin --target 德克萨斯` makes a folder from a template, `check` explains
every finding in plain words, `pack <dir> --zip` writes the `plugin.lock.json` a plugin with Spine models needs and the zip.
`_template/cosmetic/` is an example made of references to the installation's own art, no files.
`_template/ui/` is an interface plugin: a damage tally in a sandboxed frame (DESIGN §32.8).

For data, copy `_template/content/` to `data-demo/` (PLUGINS.md §10: a bond patch and a kitRef operator); a server owner
may limit what rooms take in `config.json` here (PLUGINS.md §11, DEPLOY.md).

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
  "authors": ["your name"],
  "license": "CC-BY-4.0",
  "permissions": ["data.patch"],
  "data": ["data/economy.json"]
}
```

The id is the folder name: 2–32 lower-case letters, digits and `-`. A folder whose name starts with `_` (the templates)
is never loaded. Never put files of the official game in a plugin: refer to the art the installation already has.

The format, the rules and the plan: [docs/PLUGINS.md](../docs/PLUGINS.md).
