// shared/plugins/errors.js — the plugin error catalogue (DESIGN §32.9, docs/PLUGINS.md §15; the 0.3.0 plan's shared
// interface C6): every code a check of a plugin can report — the manifest and file rules (shared/plugins/manifest.js),
// a cosmetic plugin's asset overlay and lock (shared/plugins/visual.js), the registry's scan (server/plugins/registry.js),
// the packer (server/plugins/pack.js), a room's refusals (the ERR codes PLUGIN_UNKNOWN … PLUGIN_LIMIT, shared/constants.js)
// and the studio's API (server/studio/) — with its explanation in plain words, Chinese and English, what to do about it,
// and where the documents say more. No Node builtin: the validators, the CLI (tools/plugin.mjs check), the studio's page
// (public/studio/) and the server's log lines all read it, and the symptom tables of docs/PLUGINS.md §15 and
// docs/PLUGIN-GUIDE.md are generated from it (symptomTable; test/plugins/errors.test.js keeps them in step).
// (i18n-ignore-file: the catalogue is bilingual by design, 中文 · English — docs/I18N.md; the studio shows the Chinese text
// in a Chinese interface and the English one in the others [ASSUMED])
//
// An issue (what a check returns beside its plain `problems` / `warnings` strings, which stay as they were):
//   { level: 'problem' | 'warning', code: 'PLUGIN_…', text, at?, file?, params }
//   level   a problem keeps the plugin out (not listed, the start log says why); a warning does not
//   text    the technical English line the checks always wrote (kept: the tests and the logs read it)
//   at      where in the manifest, as a path (['version'], ['assets', 'chars', 'char_102_texas', 'avatar']) — the studio
//           shows the explanation beside that field
//   file    the plugin file it is about ('art/avatar.png')
//   params  what the explanation names ({ need: 'assets.override' } …)
// An entry of the catalogue: { level, zh, en, fix: { zh, en }, doc, symptom?, autofix? } — zh / en the explanation with
// {param} placeholders ({where} is `at` or `file`), fix what to do, doc the section that explains it, symptom what an
// author sees (the tables' first column; by level when absent), autofix the name of the studio's one-click fix
// (server/studio/fixes.js) where one exists.
// Every other work package adds its codes here (PLUGIN_ prefix, unique names; test/plugins/errors.test.js fails on a code
// the code names that the catalogue lacks).

/** The documents the entries point to. */
const D = Object.freeze({
  manifest: 'docs/PLUGINS.md#3-the-manifest-manifest-2',
  permissions: 'docs/PLUGINS.md#4-permissions',
  files: 'docs/PLUGINS.md#5-files-and-limits',
  lang: 'docs/PLUGINS.md#7-language-packs',
  cosmetic: 'docs/PLUGINS.md#9-cosmetic-plugins-p1a',
  studio: 'docs/PLUGINS.md#15-the-studio-and-the-tools',
  guide: 'docs/PLUGIN-GUIDE.md',
});

/**
 * @typedef {{ zh: string, en: string }} Bilingual
 * @typedef {{ level: 'problem' | 'warning' | 'refusal' | 'studio', zh: string, en: string, fix: Bilingual, doc: string,
 *   symptom?: Bilingual, autofix?: string }} PluginErrorEntry
 * @typedef {{ level: 'problem' | 'warning', code: string, text: string, at?: string[], file?: string,
 *   params: Record<string, unknown> }} PluginIssue
 * @typedef {{ problems: string[], warnings: string[], issues: PluginIssue[],
 *   problem: (code: string, text: string, extra?: Record<string, unknown>) => void,
 *   warning: (code: string, text: string, extra?: Record<string, unknown>) => void,
 *   take: (r: { problems?: string[], warnings?: string[], issues?: PluginIssue[] } | null | undefined, opts?: { warningsToo?: boolean }) => void }} IssueList
 *   what issueList() returns
 */

/** @type {Readonly<Record<string, Readonly<PluginErrorEntry>>>} the catalogue, by code (see the header) */
export const PLUGIN_ERRORS = Object.freeze({
  // ---- a room's refusals (room.setPlugins; ERR codes of shared/constants.js) ----------------------------------------
  PLUGIN_UNKNOWN: {
    level: 'refusal', doc: D.cosmetic,
    zh: '本服务器没有安装这个插件', en: 'This server has not installed that plugin',
    fix: { zh: '把插件文件夹放进服务器的 plugins/ 文件夹（文件夹名就是插件 id）；它不在了的话，在插件面板里把它关掉。', en: 'Put the plugin folder into the server\'s plugins/ folder (the folder name is the plugin id); if it is gone, switch it off in the 插件 panel.' },
  },
  PLUGIN_BLOCKED: {
    level: 'refusal', doc: D.cosmetic,
    zh: '这个插件不能在这里启用：这个版本不应用它的类别，或者它的作用范围不包括这里', en: 'That plugin cannot be switched on here: this version does not apply its class, or its scope does not include this place',
    fix: { zh: '外观插件的 class 写 "cosmetic"；scope 写 ["room"]（房主给整个房间开）或 ["personal"]（玩家只给自己开），两样都要就都写上。', en: 'A cosmetic plugin has "class": "cosmetic"; its scope is ["room"] (the host switches it on for the room), ["personal"] (a player for themself) or both.' },
  },
  PLUGIN_DEPENDENCY: {
    level: 'refusal', doc: D.manifest,
    zh: '缺少这个插件需要的其他插件（或者版本不对），或者几个插件的加载顺序互相指向、成了一个圈', en: 'A plugin it requires is missing or out of its version range, or the load-order hints of some plugins form a cycle',
    fix: { zh: '安装 requires 里写的插件（版本要在写的范围内）；或者删掉 loadAfter / loadBefore 里互相指向的那几条。', en: 'Install the plugins its "requires" names (within their ranges), or remove the loadAfter / loadBefore entries that point at each other.' },
  },
  PLUGIN_CONFLICT: {
    level: 'refusal', doc: D.manifest,
    zh: '选中的插件互相冲突，不能一起用', en: 'The chosen plugins conflict with each other',
    fix: { zh: '关掉其中一个；插件的 conflicts 写着它和谁不能一起用。', en: 'Switch one of them off; a plugin\'s "conflicts" says which ones it cannot be used with.' },
  },
  PLUGIN_LIMIT: {
    level: 'refusal', doc: D.cosmetic,
    zh: '超出了本服务器的上限：{detail}', en: 'Over this server\'s limit: {detail}',
    fix: { zh: '少开几个插件，或者让插件小一点（压缩图片和声音、删掉没用到的文件、少用整条引用）。', en: 'Switch on fewer plugins, or make them smaller (compress pictures and sounds, remove unused files, fewer whole-record references).' },
  },

  // ---- the manifest (plugin.json) ------------------------------------------------------------------------------------
  PLUGIN_NO_MANIFEST: {
    level: 'problem', doc: D.manifest,
    zh: '插件文件夹里没有 plugin.json', en: 'The plugin folder has no plugin.json',
    fix: { zh: '每个插件文件夹都要有一个 plugin.json（插件的清单）。在工作台点「新建插件」，或运行 node tools/plugin.mjs new，就会生成一个。旧式的 pack.json 是 packs/ 文件夹里的语言包用的。', en: 'Every plugin folder needs a plugin.json (its manifest). The studio\'s 新建插件 or node tools/plugin.mjs new writes one. The older pack.json belongs to a language pack in packs/.' },
  },
  PLUGIN_JSON: {
    level: 'problem', doc: D.files,
    zh: '{where} 读不出来：它不是有效的 JSON，或者太大', en: '{where} cannot be read: it is not valid JSON, or too large',
    fix: { zh: '检查有没有多写或少写逗号、引号、括号（最后一项后面不能有逗号）；单个 JSON 文件不能超过 8 MB。用工作台编辑可以避免手写出错。', en: 'Look for a missing or extra comma, quote or bracket (no comma after the last item); a JSON file may be 8 MB at most. Editing in the studio avoids typing mistakes.' },
  },
  PLUGIN_JSON_LIMIT: {
    level: 'problem', doc: D.files,
    zh: '{where} 超出了 JSON 的限制（嵌套太深，或数字太大）', en: '{where} is beyond the JSON limits (nested too deep, or a number too large)',
    fix: { zh: '嵌套不要超过 64 层，数字要是正常的有限数字，绝对值不超过 10 亿。', en: 'Nest at most 64 levels; numbers must be finite and within ±1,000,000,000.' },
  },
  PLUGIN_MANIFEST_SHAPE: {
    level: 'problem', doc: D.manifest,
    zh: 'plugin.json 的最外层不是 { … } 对象', en: 'plugin.json is not a JSON object at the top',
    fix: { zh: '整个文件要用一对大括号 { } 包起来，里面写 "名字": 值。', en: 'The whole file is one { } object of "name": value pairs.' },
  },
  PLUGIN_MANIFEST_VERSION: {
    level: 'problem', doc: D.manifest, autofix: 'setManifest',
    zh: '缺少 "manifest": 2，或者写成了别的数', en: '"manifest": 2 is missing or another number',
    fix: { zh: '在 plugin.json 里写上 "manifest": 2（这是清单格式的版本，现在只能是 2）。', en: 'Write "manifest": 2 in plugin.json (the version of the manifest format; 2 is the only one).' },
  },
  PLUGIN_ID: {
    level: 'problem', doc: D.manifest,
    zh: '文件夹名「{id}」不能当插件 id', en: 'The folder name “{id}” is not a plugin id',
    fix: { zh: '插件 id 就是文件夹名：2–32 个小写英文字母、数字或 -，不能以 - 开头（例如 texas-red）。把文件夹改个名就行。', en: 'The plugin id is the folder name: 2–32 lower-case letters, digits and -, not starting with - (e.g. texas-red). Rename the folder.' },
  },
  PLUGIN_ID_MISMATCH: {
    level: 'warning', doc: D.manifest, autofix: 'dropField',
    zh: '清单里写的 "id" 和文件夹名「{id}」不一样，以文件夹名为准', en: 'The "id" in the manifest is not the folder name “{id}”; the folder name decides',
    fix: { zh: '删掉清单里的 "id"（文件夹名就是 id），或者把它改得和文件夹名一样。', en: 'Remove "id" from the manifest (the folder name is the id) or make it the folder name.' },
  },
  PLUGIN_FIELD_UNKNOWN: {
    level: 'warning', doc: D.manifest, autofix: 'dropField',
    zh: '「{where}」不是清单里的字段，被忽略了', en: '“{where}” is not a field of the manifest and is ignored',
    fix: { zh: '检查拼写（大小写也要一样），或者删掉它。', en: 'Check its spelling (case matters) or remove it.' },
  },
  PLUGIN_CLASS: {
    level: 'problem', doc: D.manifest,
    zh: '没有写插件类别 "class"，或者写了不认识的类别', en: '"class" is missing or not a plugin class',
    fix: { zh: '外观插件写 "class": "cosmetic"。可选的类别：lang（语言）、cosmetic（外观）、content（数据）、script、ui、trusted。', en: 'A cosmetic plugin has "class": "cosmetic". The classes: lang, cosmetic, content, script, ui, trusted.' },
  },
  PLUGIN_TEXT: {
    level: 'warning', doc: D.manifest,
    zh: '「{where}」应该是一段文字，或者 { "语言": "文字" }，被忽略了', en: '“{where}” should be a text or { "<lang>": "text" }; it is ignored',
    fix: { zh: '写成 "名字"，或者 { "zh": "名字", "en": "Name" }。', en: 'Write "Name" or { "zh": "名字", "en": "Name" }.' },
  },
  PLUGIN_LANG_CODE: {
    level: 'problem', doc: D.manifest,
    zh: '「{where}」不是语言代码', en: '“{where}” is not a language code',
    fix: { zh: '用 zh、en、ja、ko、zh-TW 这样的语言代码。', en: 'Use a language code such as zh, en, ja, ko or zh-TW.' },
  },
  PLUGIN_VERSION: {
    level: 'problem', doc: D.manifest, autofix: 'setVersion',
    zh: '插件的版本号 "version" 没写，或者写法不对', en: 'The plugin\'s "version" is missing or not a version number',
    fix: { zh: '写成三段数字，例如 "1.0.0"；以后每次改了插件都把它调大一点（1.0.1、1.1.0 …）。', en: 'Write three numbers such as "1.0.0"; raise it whenever the plugin changes (1.0.1, 1.1.0 …).' },
  },
  PLUGIN_APP: {
    level: 'problem', doc: D.manifest, autofix: 'setApp',
    zh: '适配的游戏版本 "app" 没写，或者写法不对', en: 'The game versions the plugin is made for, "app", are missing or not a range',
    fix: { zh: '写成一个版本范围，例如 ">=0.3.0 <0.4.0"（本游戏现在是 {app}）。', en: 'Write a range such as ">=0.3.0 <0.4.0" (this game is {app}).' },
  },
  PLUGIN_APP_MISMATCH: {
    level: 'warning', doc: D.manifest, autofix: 'setApp',
    zh: '这个插件是给游戏 {range} 做的，本服务器是 {app}', en: 'The plugin is made for the game {range}; this server is {app}',
    fix: { zh: '外观插件照样能用（只是提醒）。在新版本里确认没问题后，把 "app" 改成包含 {app} 的范围。', en: 'A cosmetic plugin still works (a reminder only). Once it is checked with this version, widen "app" to include {app}.' },
  },
  PLUGIN_API: {
    level: 'problem', doc: D.manifest, autofix: 'setApi',
    zh: '插件接口级别 "api" 没写、不是整数，或者本游戏不支持', en: 'The plugin API level "api" is missing, not an integer, or not supported',
    fix: { zh: '写 "api": {current}（本游戏支持 {min}–{current}）。', en: 'Write "api": {current} (this game supports {min}–{current}).' },
  },
  PLUGIN_SCOPE: {
    level: 'problem', doc: D.manifest, autofix: 'setScope',
    zh: '作用范围 "scope" 写得不对', en: '"scope" is not one this class allows',
    fix: { zh: '外观插件写 ["room", "personal"]：room 是房主给整个房间开，personal 是玩家在设置里只给自己开。', en: 'A cosmetic plugin has ["room", "personal"]: room — the host switches it on for the whole room; personal — a player for themself in 设置.' },
  },
  PLUGIN_HOMEPAGE: {
    level: 'warning', doc: D.manifest,
    zh: '主页 "homepage" 不是 http(s) 网址，被忽略了', en: '"homepage" is not an http(s) address and is ignored',
    fix: { zh: '写完整的网址，例如 https://example.com/my-plugin，或者删掉它。', en: 'Write a full address such as https://example.com/my-plugin, or remove it.' },
  },
  PLUGIN_DEPS: {
    level: 'problem', doc: D.manifest,
    zh: '依赖关系（requires / optional / conflicts）写得不对：{where}', en: 'A dependency (requires / optional / conflicts) is not right: {where}',
    fix: { zh: '写成 { "其他插件的 id": "版本范围" }，例如 { "base-skin": ">=1.0.0" }；不能写自己，同一个插件不能既需要又冲突，最多 32 个。', en: 'Write { "<plugin id>": "<version range>" }, e.g. { "base-skin": ">=1.0.0" }; never the plugin itself, never one both required and in conflict, at most 32.' },
  },
  PLUGIN_ORDER_HINTS: {
    level: 'problem', doc: D.manifest,
    zh: '加载顺序（loadAfter / loadBefore / priority）写得不对：{where}', en: 'A load-order hint (loadAfter / loadBefore / priority) is not right: {where}',
    fix: { zh: 'loadAfter 和 loadBefore 是插件 id 的列表（同一个 id 不能两边都写，也不能写自己）；priority 是 -1000 到 1000 的整数，默认 0。', en: 'loadAfter and loadBefore are lists of plugin ids (never one in both, never the plugin itself); priority is an integer within ±1000, default 0.' },
  },
  PLUGIN_SETTING: {
    level: 'problem', doc: D.manifest,
    zh: '设置项 "settings" 写得不对：{where}', en: 'A setting is not right: {where}',
    fix: { zh: '每个设置项写 { "type": … }：boolean（开关）、integer / number（要写 min 和 max）、enum（要写 options 列表）；默认值要在范围内；最多 32 个，不能是自由文字。', en: 'Each setting is { "type": … }: boolean, integer / number (with min and max), enum (with options); its default within them; at most 32, no free text.' },
  },
  PLUGIN_SETTING_FIELD: {
    level: 'warning', doc: D.manifest,
    zh: '设置项里有不认识的字段「{where}」，被忽略了', en: 'A setting has a field it does not know, “{where}”; it is ignored',
    fix: { zh: '设置项只认 type、default、min、max、step、options、label 这几个字段。', en: 'A setting knows type, default, min, max, step, options and label only.' },
  },
  PLUGIN_PART_CLASS: {
    level: 'problem', doc: D.manifest,
    zh: '「{where}」不是 {class} 插件能带的东西', en: '“{where}” is not something a {class} plugin carries',
    fix: { zh: '外观插件只带 "assets"（素材）和 "theme"（主题）；改数值、加干员之类的要做成 content 插件。', en: 'A cosmetic plugin carries "assets" and "theme" only; numbers and new operators belong to a content plugin.' },
  },
  PLUGIN_PART_SHAPE: {
    level: 'problem', doc: D.manifest,
    zh: '「{where}」的写法不对', en: '“{where}” is not written the right way',
    fix: { zh: '写成插件文件夹里的一个 .json 文件路径（或这些路径的列表）；"assets" 和 "theme" 也可以直接写成 { … } 对象。', en: 'Write the path of a .json file of the plugin folder (or a list of them); "assets" and "theme" may also be the { … } object itself.' },
  },
  PLUGIN_ASSET_FILE: {
    level: 'problem', doc: D.cosmetic,
    zh: '素材「{where}」写的文件不对：不是插件文件夹里的路径，或者不是这个位置要的文件类型', en: 'The file of “{where}” is not right: not a path inside the plugin folder, or not the kind of file this place takes',
    fix: { zh: '写插件文件夹里的相对路径，例如 art/avatar.png。图片位置用 .png .jpg .webp，声音位置用 .mp3 .ogg，模型用 .skel 和 .atlas（贴图 .png）。', en: 'Write a path inside the plugin folder such as art/avatar.png. Pictures are .png .jpg .webp, sounds .mp3 .ogg, models .skel with .atlas (pages .png).' },
  },
  PLUGIN_THEME_URL: {
    level: 'problem', doc: D.cosmetic,
    zh: '主题 "theme" 里写了网址', en: '"theme" names a URL',
    fix: { zh: '主题只能写颜色、长度和插件自带的字体名，不能引用网址（这是为了防止泄露数据）。', en: 'A theme sets colours, lengths and the plugin\'s own font names only — never a URL (it could leak data).' },
  },
  PLUGIN_THEME_UNUSED: {
    level: 'warning', doc: D.cosmetic,
    zh: '这个版本还不应用 "theme"（只应用 "assets" 里的素材）', en: 'This version does not apply "theme" yet (only the art of "assets")',
    fix: { zh: '可以先留着，以后的版本会用上；或者删掉它，提示就没了。', en: 'Keep it for a later version, or remove it to silence the note.' },
  },
  PLUGIN_ENTRY: {
    level: 'problem', doc: D.manifest,
    zh: '入口 "entry" 写得不对，或者这个类别不能有入口：{where}', en: 'An entry point is not right, or this class has none: {where}',
    fix: { zh: '外观插件不需要 "entry"，删掉它。代码类插件（script、ui、trusted）这个版本还不加载。', en: 'A cosmetic plugin needs no "entry": remove it. Code plugins (script, ui, trusted) are not loaded by this version.' },
  },
  PLUGIN_LANG_ONLY: {
    level: 'problem', doc: D.lang, autofix: 'dropField',
    zh: '「{where}」只属于语言包（lang 类），{class} 插件不能写', en: '“{where}” belongs to a language pack (class lang), not a {class} plugin',
    fix: { zh: '删掉它；要做语言包的话，把 class 改成 "lang"。', en: 'Remove it; for a language pack, make "class": "lang".' },
  },
  PLUGIN_PERMISSION: {
    level: 'problem', doc: D.permissions,
    zh: '权限写得不对：「{where}」不认识，或者 {class} 插件不能有', en: 'A permission is not right: “{where}” is unknown or not one a {class} plugin may have',
    fix: { zh: '外观插件能用的权限：assets.override（替换本安装已有的素材）、assets.add（新增一个本安装没有的条目）、theme。"permissions" 要写成列表。', en: 'A cosmetic plugin\'s permissions: assets.override (replace art the installation has), assets.add (a new entry), theme. "permissions" is a list.' },
  },
  PLUGIN_PERMISSION_MISSING: {
    level: 'problem', doc: D.permissions, autofix: 'addPermission',
    zh: '「{where}」需要权限 {need}，清单里没有声明', en: '“{where}” needs the permission {need}, which the manifest does not declare',
    fix: { zh: '在 "permissions" 里加上 "{need}"。', en: 'Add "{need}" to "permissions".' },
  },
  PLUGIN_PERMISSION_UNUSED: {
    level: 'warning', doc: D.permissions, autofix: 'dropPermission',
    zh: '声明了权限 {permission}，但插件里没有用到它的东西', en: 'The permission {permission} is declared but nothing in the plugin uses it',
    fix: { zh: '从 "permissions" 里删掉 "{permission}"（声明的权限越少，越容易让人放心）。', en: 'Remove "{permission}" from "permissions" (the fewer, the more trust).' },
  },
  PLUGIN_EMPTY: {
    level: 'warning', doc: D.cosmetic,
    zh: '这个插件什么都没带', en: 'The plugin carries nothing',
    fix: { zh: '外观插件要在 "assets" 里写要替换的素材。在工作台用模板开始最省事。', en: 'A cosmetic plugin lists the art it replaces in "assets". The studio\'s templates are the easiest start.' },
  },

  // ---- the files of the folder ----------------------------------------------------------------------------------------
  PLUGIN_FILE_LINK: {
    level: 'problem', doc: D.files,
    zh: '{where} 是符号链接（快捷方式），插件里只能放普通文件', en: '{where} is a symbolic link; a plugin holds plain files only',
    fix: { zh: '把真正的文件复制进插件文件夹，再删掉这个链接。', en: 'Copy the real file into the plugin folder and remove the link.' },
  },
  PLUGIN_FILE_NAME: {
    level: 'problem', doc: D.files,
    zh: '文件名「{where}」不能用', en: 'The file name “{where}” cannot be used',
    fix: { zh: '文件名和文件夹名只用英文字母、数字、. _ - 和空格；不要以 . 开头，也不要有 ".." 这样的部分。', en: 'Names of files and folders use letters, digits, . _ - and spaces; none starts with . or is "..".' },
  },
  PLUGIN_FILE_TYPE: {
    level: 'problem', doc: D.files, autofix: 'moveOut',
    zh: '{where}：这种文件不能放进 {class} 插件', en: '{where}: a {class} plugin may not carry this kind of file',
    fix: { zh: '图片用 .png .jpg .webp（不收 SVG），声音用 .mp3 .ogg，模型用 .skel .atlas，说明文档 .md .txt 和 README / LICENSE 可以放。把这个文件移出插件文件夹（一键修复会把它移到 plugins/_moved/ 里，不会删掉），或转换成能用的格式。', en: 'Pictures are .png .jpg .webp (no SVG), sounds .mp3 .ogg, models .skel .atlas; documents (.md, .txt, README, LICENSE) may sit beside them. Move the file out of the plugin folder (the one-click fix moves it to plugins/_moved/, never deletes it) or convert it.' },
  },
  PLUGIN_FILE_FRAME: {
    level: 'problem', doc: D.files,
    zh: '{where} 是界面文件，但不在 entry.client 所在的文件夹里', en: '{where} is a frame file outside the folder of entry.client',
    fix: { zh: '把界面插件的 .html .js .css 都放进 entry.client 那个文件夹。', en: 'Put a ui plugin\'s .html .js .css into the folder of entry.client.' },
  },
  PLUGIN_FILE_SIZE: {
    level: 'problem', doc: D.files,
    zh: '插件太大了：{where}', en: 'The plugin is too large: {where}',
    fix: { zh: '一个插件最多 200 MB、5000 个文件（文件夹最多 2000 个、12 层），单个 JSON 最多 8 MB。压缩图片和声音，删掉没用到的文件，或者拆成几个插件。', en: 'A plugin holds at most 200 MB in 5000 files (2000 folders, 12 levels deep), a JSON file at most 8 MB. Compress pictures and sounds, remove unused files, or split it.' },
  },
  PLUGIN_FILE_MISSING: {
    level: 'problem', doc: D.files,
    zh: '清单里写了 {file}，但插件文件夹里没有这个文件', en: 'The manifest names {file}, which the plugin folder does not hold',
    fix: { zh: '把文件放到这个位置（注意文件夹和大小写都要一样），或者改正清单里的路径。在工作台把文件拖到对应的格子里就会放对。', en: 'Put the file there (folders and case must match) or correct the path in the manifest. Dropping the file on its slot in the studio puts it in the right place.' },
  },
  PLUGIN_FILE_OUTSIDE: {
    level: 'problem', doc: D.files,
    zh: '{where} 指到了插件文件夹外面，或者在插件文件夹里读不出来', en: '{where} leads out of the plugin folder or cannot be read inside it',
    fix: { zh: '插件只能用自己文件夹里的普通文件：把文件复制进来，别用链接，并检查文件能不能打开。', en: 'A plugin uses plain files of its own folder only: copy the file in (no link) and check that it opens.' },
  },

  // ---- language packs and the older pack folders -------------------------------------------------------------------
  PLUGIN_LANG: {
    level: 'problem', doc: D.lang,
    zh: '语言包的语言写得不对：{where}', en: 'A language pack\'s language is not right: {where}',
    fix: { zh: '"lang" 写语言代码（en、ja、zh-TW …）；zh 是源语言，不能做成语言包；machineTranslated 写 true 或 false。', en: '"lang" is a language code (en, ja, zh-TW …); zh is the source language and never a pack; machineTranslated is true or false.' },
  },
  PLUGIN_LANG_FILES: {
    level: 'problem', doc: D.lang,
    zh: '语言包的文件表 "files" 写得不对：{where}', en: 'A language pack\'s "files" are not right: {where}',
    fix: { zh: '"files" 写 { "ui": "ui.json" }（必填）和可选的 { "data": "data.json" }，都是包里的 .json 文件。', en: '"files" is { "ui": "ui.json" } (required) and optionally "data", both .json files of the pack.' },
  },
  PLUGIN_PACK: {
    level: 'problem', doc: D.lang,
    zh: '旧式内容包（pack.json）写得不对，或者这个版本不加载它的类型：{where}', en: 'An older content pack (pack.json) is not right, or this version does not load its type: {where}',
    fix: { zh: 'packs/ 里只加载语言包（"type": "lang"）。外观和数据请做成 plugins/ 里的插件（plugin.json，"manifest": 2）。', en: 'packs/ loads language packs ("type": "lang") only. Art and data are plugins of plugins/ (plugin.json, "manifest": 2).' },
  },

  // ---- a cosmetic plugin's asset overlay and its lock ---------------------------------------------------------------
  PLUGIN_ASSETS_SHAPE: {
    level: 'problem', doc: D.cosmetic,
    zh: '素材表 "assets" 的写法不对：{where}', en: 'The asset overlay is not written the right way: {where}',
    fix: { zh: '按 data/assets.json 的样子写：chars → 干员 id → avatar / portrait / spine …，声音在 audio 里。用工作台的模板就不用手写。', en: 'Follow data/assets.json: chars → operator id → avatar / portrait / spine …, sounds under audio. The studio\'s templates write it for you.' },
  },
  PLUGIN_ASSET_KEY: {
    level: 'problem', doc: D.cosmetic,
    zh: '「{where}」不是素材条目的名字', en: '“{where}” is not the name of an asset entry',
    fix: { zh: '条目名是干员、敌人等的内部 id（例如 char_102_texas，只有字母、数字、_ . / -）。在工作台按官方名字搜索，就不用自己找 id。', en: 'An entry is named by an internal id such as char_102_texas (letters, digits, _ . / -). The studio finds it by its official name.' },
  },
  PLUGIN_ASSET_IGNORED: {
    level: 'warning', doc: D.cosmetic, autofix: 'dropAsset',
    zh: '「{where}」不是外观插件能改的位置，被忽略了', en: '“{where}” is not something a cosmetic plugin changes; it is ignored',
    fix: { zh: '检查拼写；外观插件能改的位置见 PLUGINS.md §9 的表（头像、立绘、模型、图标、界面图、语音、音效、音乐）。', en: 'Check the spelling; PLUGINS.md §9 lists what a cosmetic plugin changes (avatars, portraits, models, icons, interface pictures, voices, sounds, music).' },
  },
  PLUGIN_REF: {
    level: 'problem', doc: D.cosmetic, autofix: 'dropAsset',
    zh: '引用「{where}」不对：写法不对，或者本安装没有它指向的素材', en: 'The reference at “{where}” is not right: not written as one, or the installation has no such art',
    fix: { zh: '{ "ref": "char_112_siege" } 借用本安装已有的同类条目。在工作台点「用已有的素材」从列表里选，就不会写错；或者删掉这条。', en: '{ "ref": "char_112_siege" } borrows an entry of the same kind the installation has. Pick it from the list with the studio\'s 用已有的素材, or remove the write.' },
  },
  PLUGIN_SPINE: {
    level: 'problem', doc: D.cosmetic,
    zh: 'Spine 模型「{where}」写得不对', en: 'The Spine model at “{where}” is not right',
    fix: { zh: '.skel 和 .atlas 放在同一个文件夹、用同一个名字（t.skel + t.atlas），贴图 .png 放在 atlas 旁边并写进 textures；动画数据不要手写，点「打包」自动生成。', en: 'The .skel and the .atlas sit side by side with one name (t.skel + t.atlas), the .png pages beside the atlas and in "textures"; clip data is never written by hand — 打包 makes it.' },
  },
  PLUGIN_SPINE_PAGES: {
    level: 'problem', doc: D.cosmetic, autofix: 'setTextures',
    zh: '{file} 用到的贴图没有写进 "textures"', en: '{file} uses a page that "textures" does not list',
    fix: { zh: '把 atlas 里每一页贴图都写进 "textures"（一键修复会按 atlas 自动填好）。', en: 'List every page of the atlas in "textures" (the one-click fix fills it from the atlas).' },
  },
  PLUGIN_SPINE_NOTE: {
    level: 'warning', doc: D.cosmetic,
    zh: '模型 {file} 有小问题：{detail}', en: 'The model {file} has a small issue: {detail}',
    fix: { zh: '多半是 "textures" 写了 atlas 没用到的图片，或者有部件在 atlas 里找不到。模型通常还能显示，在预览里看一下。', en: 'Usually "textures" names a picture the atlas does not use, or a part is missing from the atlas. The model usually still shows: look at it in the preview.' },
  },
  PLUGIN_SPINE_PARSE: {
    level: 'problem', doc: D.cosmetic,
    zh: '模型 {file} 读不出来：不是游戏能读的 Spine 3.8 二进制骨骼，或者里面没有动画', en: 'The model {file} cannot be read: not a Spine 3.8 binary skeleton the game reads, or it has no animations',
    fix: { zh: '用 Spine 3.8 导出二进制 .skel（不要 .json 骨骼），并确认导出时带了动画（Idle、Attack、Die …）。', en: 'Export a binary .skel with Spine 3.8 (not a .json skeleton), with its animations (Idle, Attack, Die …).' },
  },
  PLUGIN_LOCK: {
    level: 'problem', doc: D.cosmetic, autofix: 'pack',
    zh: 'plugin.lock.json 坏了，或者是旧格式', en: 'plugin.lock.json is broken or of another format',
    fix: { zh: '在工作台点「打包」，或运行 node tools/plugin.mjs pack，重新生成它；不要手改这个文件。', en: 'Make it again with the studio\'s 打包 or node tools/plugin.mjs pack; never edit it by hand.' },
  },
  PLUGIN_LOCK_MISSING: {
    level: 'problem', doc: D.cosmetic, autofix: 'pack',
    symptom: { zh: '插件没出现在列表里（被跳过），因为模型还没打包', en: 'The plugin is skipped: its model is not packed yet' },
    zh: '模型 {file} 还没有动画数据（plugin.lock.json 里没有它）', en: 'The model {file} has no clip data yet (plugin.lock.json lacks it)',
    fix: { zh: '点「打包」（或运行 node tools/plugin.mjs pack <插件>），它会读出模型的动画写进 plugin.lock.json。', en: 'Press 打包 (or run node tools/plugin.mjs pack <plugin>): it reads the model\'s clips into plugin.lock.json.' },
  },
  PLUGIN_LOCK_STALE: {
    level: 'problem', doc: D.cosmetic, autofix: 'pack',
    symptom: { zh: '换了模型文件后插件消失了', en: 'The plugin disappeared after a model file was replaced' },
    zh: '模型 {file} 改过了，plugin.lock.json 里还是旧模型的数据', en: 'The model {file} changed; plugin.lock.json still holds the old one\'s data',
    fix: { zh: '再点一次「打包」（或运行 node tools/plugin.mjs pack），锁文件就会跟上新模型。', en: 'Press 打包 again (or run node tools/plugin.mjs pack): the lock follows the new model.' },
  },

  // ---- the registry's scan ------------------------------------------------------------------------------------------
  PLUGIN_DUPLICATE: {
    level: 'problem', doc: D.manifest,
    zh: '插件 id 或语言重复了：{where}', en: 'A plugin id or a language is taken twice: {where}',
    fix: { zh: '换一个文件夹名（插件 id；Windows 和 macOS 上大小写不同也算同一个），或者删掉重复的那个。', en: 'Rename the folder (the plugin id; on Windows and macOS another case is the same name) or remove the duplicate.' },
  },
  PLUGIN_UNREADABLE: {
    level: 'problem', doc: D.files,
    zh: '读取插件时出错：{detail}', en: 'Reading the plugin failed: {detail}',
    fix: { zh: '检查文件的读取权限；如果有程序正在写这个文件夹，等它写完再试。', en: 'Check the files\' permissions; if a program is writing the folder, wait until it is done.' },
  },
  PLUGIN_REQUIRES_MISSING: {
    level: 'warning', doc: D.manifest,
    zh: '它需要的插件 {dep} 没有安装，或者版本不在 {range} 里', en: 'The plugin it requires, {dep}, is not installed or not within {range}',
    fix: { zh: '把需要的插件也装上（版本在范围内）；不然房主在房间里开它时会被拒绝。', en: 'Install the required plugin within its range; otherwise a host switching it on is refused.' },
  },

  // ---- the studio's API ---------------------------------------------------------------------------------------------
  PLUGIN_STUDIO_PATH: {
    level: 'studio', doc: D.studio,
    zh: '这个路径不能用：{detail}', en: 'This path cannot be used: {detail}',
    fix: { zh: '文件只能放在插件自己的文件夹里；路径不能有 ..、以 . 开头的部分或特殊字符，也不能经过链接跑到外面。', en: 'Files stay inside the plugin\'s own folder: no .., no part starting with ., no special characters, no link leading out.' },
  },
  PLUGIN_STUDIO_SIZE: {
    level: 'studio', doc: D.studio,
    zh: '文件太大了（上限 {max}）', en: 'The file is too large (at most {max})',
    fix: { zh: '把图片或声音压缩一下再拖进来（立绘用 1024 像素以内的 PNG/WebP 就够了）。', en: 'Compress the picture or sound first (a portrait within 1024 px as PNG / WebP is plenty).' },
  },
  PLUGIN_STUDIO_EXISTS: {
    level: 'studio', doc: D.studio,
    zh: '已经有一个叫「{id}」的插件了', en: 'There is a plugin “{id}” already',
    fix: { zh: '换一个 id，或者在列表里打开那个插件接着改。', en: 'Choose another id, or open that plugin from the list.' },
  },
  PLUGIN_STUDIO_TEMPLATE: {
    level: 'studio', doc: D.studio,
    zh: '不认识这个模板：{template}', en: 'No such template: {template}',
    fix: { zh: '从工作台的模板列表里选一个（node tools/plugin.mjs new 不带参数会列出全部模板）。', en: 'Pick one of the studio\'s templates (node tools/plugin.mjs new without arguments lists them).' },
  },
  PLUGIN_STUDIO_TARGET: {
    level: 'studio', doc: D.studio,
    zh: '找不到要替换的目标「{target}」', en: 'No target “{target}” to replace',
    fix: { zh: '用搜索框按官方名字找（例如「德克萨斯」），从结果里点一个。', en: 'Search by its official name (e.g. 德克萨斯) and pick one of the results.' },
  },
  PLUGIN_STUDIO_FILE_KIND: {
    level: 'studio', doc: D.studio,
    zh: '这个位置要放 {kind}，拖进来的文件是 {ext}', en: 'This place takes {kind}; the dropped file is {ext}',
    fix: { zh: '图片位置放 .png .jpg .webp，声音位置放 .mp3 .ogg，模型位置一次放 .skel、.atlas 和它的 .png。', en: 'A picture place takes .png .jpg .webp, a sound place .mp3 .ogg, a model place its .skel, .atlas and .png together.' },
  },
  PLUGIN_STUDIO_REQUEST: {
    level: 'studio', doc: D.studio,
    zh: '工作台的请求不对：{detail}', en: 'The studio\'s request is not right: {detail}',
    fix: { zh: '刷新工作台页面再试；还不行的话，到 GitHub 提问并附上这段文字。', en: 'Reload the studio and try again; if it stays, ask on GitHub with this text.' },
  },
  PLUGIN_STUDIO_KEY: {
    level: 'studio', doc: D.studio,
    symptom: { zh: '工作台只能查看，不能新建或修改插件', en: 'The studio only shows plugins; it cannot make or change one' },
    zh: '改动插件需要工作台钥匙，这个浏览器还没有（或者钥匙不对）', en: 'Changing a plugin needs the studio\'s key, which this browser does not have (or it is not the right one)',
    fix: { zh: '打开服务器窗口里「Studio」那一行的地址（它带着钥匙，钥匙也在 plugins/.studio-key 文件里），或把它粘贴到工作台顶部的输入框。', en: 'Open the address on the "Studio" line of the server\'s window (it carries the key, which is also in plugins/.studio-key), or paste it into the box at the top of the studio.' },
  },

  // ---- anything a check reported without a code of its own ----------------------------------------------------------
  PLUGIN_INVALID: {
    level: 'problem', doc: D.guide,
    zh: '插件有问题：{detail}', en: 'The plugin has a problem: {detail}',
    fix: { zh: '看后面的英文原文；看不懂的话，可以到 GitHub 提问并附上这段文字。', en: 'Read the original line; if it is unclear, ask on GitHub with it.' },
  },
});

/** The codes that a room's refusals use (ERR codes, translated in the language packs: shared/constants.js ERR_TEXT). */
export const REFUSAL_CODES = Object.freeze(Object.keys(PLUGIN_ERRORS).filter((c) => PLUGIN_ERRORS[c].level === 'refusal'));

/** What an author sees, by level, when an entry names no symptom of its own (the tables' first column). */
const SYMPTOM_BY_LEVEL = Object.freeze({
  problem: { zh: '插件没出现在列表里（被跳过）；启动日志和 check 写着原因', en: 'The plugin is not listed (skipped); the start log and check say why' },
  warning: { zh: '插件能用，但检查时有提示', en: 'The plugin works, with a note in the check' },
  refusal: { zh: '房间里开不了这个插件，面板弹出提示', en: 'The room will not switch it on; the panel says why' },
  studio: { zh: '工作台里的操作被拒绝，旁边显示原因', en: 'The studio refuses the action and says why' },
});

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** Is this a code of the catalogue? @param {unknown} code */
export const isPluginErrorCode = (code) => typeof code === 'string' && Object.hasOwn(PLUGIN_ERRORS, code);

/**
 * One issue (see the header). `extra`: `{ at, file, ...params }` — `at` a path into the manifest (strings), `file` a
 * path of the plugin folder; everything else goes to `params`.
 * @param {'problem' | 'warning'} level @param {string} code @param {string} text @param {Record<string, unknown>} [extra]
 * @returns {PluginIssue}
 */
export function makeIssue(level, code, text, extra = {}) {
  const { at, file, ...params } = isObj(extra) ? extra : {};
  /** @type {PluginIssue} */
  const issue = { level, code: isPluginErrorCode(code) ? code : 'PLUGIN_INVALID', text: String(text), params };
  if (Array.isArray(at) && at.length) issue.at = at.map(String);
  if (typeof file === 'string' && file) issue.file = file;
  if (issue.code !== code) issue.params = { ...params, detail: String(text), code: String(code) };
  return issue;
}

/**
 * A check's findings: its `problems` and `warnings` (the plain strings every caller has read since P0) and the same as
 * `issues` with their codes. `problem(code, text, extra)` / `warning(…)` add one; `take(result)` adds another check's
 * findings (its issues when it has them, else its strings as PLUGIN_INVALID).
 * @returns {IssueList}
 */
export function issueList() {
  /** @type {string[]} */ const problems = [];
  /** @type {string[]} */ const warnings = [];
  /** @type {PluginIssue[]} */ const issues = [];
  const add = (level, code, text, extra) => {
    (level === 'warning' ? warnings : problems).push(String(text));
    issues.push(makeIssue(level, code, text, extra));
  };
  return {
    problems, warnings, issues,
    /** @param {string} code @param {string} text @param {Record<string, unknown>} [extra] */
    problem: (code, text, extra) => add('problem', code, text, extra),
    /** @param {string} code @param {string} text @param {Record<string, unknown>} [extra] */
    warning: (code, text, extra) => add('warning', code, text, extra),
    /**
     * Add another check's findings.
     * @param {{ problems?: string[], warnings?: string[], issues?: PluginIssue[] } | null | undefined} r
     * @param {{ warningsToo?: boolean }} [opts] warningsToo: false to take its problems only
     */
    take(r, { warningsToo = true } = {}) {
      if (!r) return;
      for (const i of issuesOf(r)) {
        if (i.level === 'warning' && !warningsToo) continue;
        (i.level === 'warning' ? warnings : problems).push(i.text);
        issues.push(i);
      }
    },
  };
}

/**
 * The issues of a check's result: its own `issues` when it has them (one per problem and warning), else its plain strings
 * as PLUGIN_INVALID (a check that predates the catalogue, or another work package's before its codes join it).
 * @param {{ problems?: string[], warnings?: string[], issues?: PluginIssue[] } | null | undefined} r
 * @returns {PluginIssue[]}
 */
export function issuesOf(r) {
  if (!r) return [];
  const problems = Array.isArray(r.problems) ? r.problems : [];
  const warnings = Array.isArray(r.warnings) ? r.warnings : [];
  if (Array.isArray(r.issues) && r.issues.length === problems.length + warnings.length) return r.issues;
  return [...problems.map((t) => makeIssue('problem', 'PLUGIN_INVALID', t, { detail: t })), ...warnings.map((t) => makeIssue('warning', 'PLUGIN_INVALID', t, { detail: t }))];
}

/** The language of the catalogue's texts for an interface language: Chinese for zh and zh-TW, else English [ASSUMED]. */
export const errorLang = (lang) => (/^zh/i.test(String(lang || 'zh')) ? 'zh' : 'en');

/** A param as text: a string, a number, a list of them — anything else (a value of a broken manifest) as short JSON. @param {unknown} v */
const paramText = (v) => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(paramText).join(', ');
  try { return String(JSON.stringify(v)).slice(0, 80); } catch { return '?'; }
};

/** `{name}` placeholders filled from `params` (a missing one: ''). @param {string} text @param {Record<string, unknown>} params */
export function fillText(text, params) {
  return String(text).replace(/\{(\w+)\}/g, (_, k) => paramText(params && Object.hasOwn(params, k) ? params[k] : ''));
}

/**
 * The placeholders of an entry's texts (its explanation and its fix, both languages): what an issue of the code passes.
 * @param {string} code @returns {string[]}
 */
export function placeholdersOf(code) {
  const e = PLUGIN_ERRORS[code];
  if (!e) return [];
  const all = [e.zh, e.en, e.fix.zh, e.fix.en].join('\n');
  return [...new Set([...all.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

/** What an issue's `{where}` reads: its manifest path, else its file. @param {PluginIssue} issue */
export const issueWhere = (issue) => (issue.at && issue.at.length ? issue.at.join('.') : issue.file || '');

/**
 * An issue in plain words, in `lang` (errorLang): `{ code, level, message, fix, doc, detail, autofix }` — `detail` the
 * technical English line.
 * @param {PluginIssue} issue @param {string} [lang]
 */
export function describeIssue(issue, lang = 'zh') {
  const code = isPluginErrorCode(issue?.code) ? issue.code : 'PLUGIN_INVALID';
  const e = PLUGIN_ERRORS[code];
  const l = errorLang(lang);
  const params = { where: issueWhere(issue), file: issue?.file || issueWhere(issue), detail: issue?.text || '', ...(isObj(issue?.params) ? issue.params : {}) };
  return {
    code, level: issue?.level === 'warning' ? 'warning' : e.level === 'warning' ? 'warning' : 'problem',
    message: fillText(e[l], params), fix: fillText(e.fix[l], params), doc: e.doc, detail: issue?.text || '', autofix: e.autofix || null,
  };
}

/**
 * The plain-words line of an issue for a terminal or a log: `CODE message — fix (doc)`.
 * @param {PluginIssue} issue @param {string} [lang]
 */
export function issueLine(issue, lang = 'zh') {
  const d = describeIssue(issue, lang);
  return `${d.code} ${d.message}${errorLang(lang) === 'zh' ? '。改法：' : '. Fix: '}${d.fix} (${d.doc})`;
}

/**
 * A room's refusal in plain words (the ERR codes): `{ message, fix, doc }`, or null for another code.
 * @param {string} code @param {string} [lang] @param {Record<string, unknown>} [params]
 */
export function describeRefusal(code, lang = 'zh', params = {}) {
  if (!REFUSAL_CODES.includes(code)) return null;
  const e = PLUGIN_ERRORS[code];
  const l = errorLang(lang);
  return { message: fillText(e[l], params), fix: fillText(e.fix[l], params), doc: e.doc };
}

/** Markdown cell text: no line breaks, no table pipes. @param {string} s */
const cell = (s) => String(s).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');

/**
 * The symptom table of the catalogue (docs/PLUGINS.md §15 in English, docs/PLUGIN-GUIDE.md in Chinese): one row per code
 * — what an author sees, the code, the cause, what to do. Placeholders stay as `{name}` (they are filled per issue).
 * @param {'zh' | 'en'} [lang]
 * @returns {string}
 */
export function symptomTable(lang = 'en') {
  const l = errorLang(lang);
  const head = l === 'zh' ? '| 症状 | 代码 | 原因 | 怎么改 |' : '| Symptom | Code | Cause | Fix |';
  const rows = Object.entries(PLUGIN_ERRORS).map(([code, e]) => {
    const symptom = (e.symptom || SYMPTOM_BY_LEVEL[e.level])[l];
    const fix = e.autofix ? `${e.fix[l]}${l === 'zh' ? '（工作台可一键修复）' : ' (the studio fixes it in one click)'}` : e.fix[l];
    return `| ${cell(symptom)} | \`${code}\` | ${cell(e[l])} | ${cell(fix)} |`;
  });
  return [head, '|---|---|---|---|', ...rows].join('\n');
}

/** The markers around a generated table in a document (test/plugins/errors.test.js, tools/plugin.mjs errors --write). */
export const TABLE_MARKERS = Object.freeze({ start: '<!-- plugin-errors:start (generated by node tools/plugin.mjs errors --write) -->', end: '<!-- plugin-errors:end -->' });
