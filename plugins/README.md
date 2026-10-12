# plugins/ — 插件 · plugins

A server owner puts plugins here, one folder each: `plugins/<id>/plugin.json` (the manifest) next to the files it names.
The server lists what it finds at `/plugins/index.json` and notices a new or changed plugin on the next page load.
`node tools/plugin.mjs list` shows what was found, what was skipped and why; `node tools/plugin.mjs check` checks the
folders (manifest, file types, sizes, paths, JSON).

**This version (the plugin system's first step):**

- the original game is always the default; a plugin is marked unofficial wherever it is shown;
- class `lang` (a language) loads, like a language pack in `packs/`;
- classes `cosmetic` (art, models, audio, fonts) and `content` (data: numbers, modes, new operators and enemies) are
  checked and listed, not applied yet;
- no plugin code runs — classes `script`, `ui` and `trusted` are listed as not supported;
- nothing in this folder except this readme and `_template/` is committed or shipped: your plugins stay yours, and an
  update never touches them.

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
