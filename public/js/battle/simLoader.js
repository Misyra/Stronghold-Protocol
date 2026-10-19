// Browser/Worker engine loader. Workers receive data and never fetch it (DESIGN §32.11).
import { resourceUrl, resourceCache, dataBasePath } from '../resourceUrl.js';

export const SIM_DATA_FILES = Object.freeze(['chess', 'enemies', 'tokens', 'stages', 'waves', 'bonds', 'items', 'garrisons', 'bands', 'effects', 'backups']);

function deepFreeze(root) {
  const stack = [root];
  while (stack.length) {
    const o = stack.pop();
    if (o === null || typeof o !== 'object' || Object.isFrozen(o)) continue;
    Object.freeze(o);
    for (const v of Object.values(o)) if (v !== null && typeof v === 'object') stack.push(v);
  }
  return root;
}

/**
 * Browser sim loader: the /sim/ modules + the data files (own frozen copies — the server's data is frozen too, so a
 * content bug that writes into a record fails identically on both sides). `raw` is that frozen data: the rehearsal
 * worker (battle/rehearsal.js) is handed the page's official copy once instead of fetching the files again. `data`
 * (DESIGN §32.6): the files of a room's content set the page checked (public/js/content.js) instead of fetching
 * /data/; `cs` names what was loaded; `bounds` its official-bounds snapshot (installSimBounds).
 */
let loadedScripts = false;
// 浏览器侧的 sim 模块一律走发布 tag（`/_v/<runtimeTag>/sim/…`，见 public/js/resourceUrl.js）：
// tag 是内容的摘要，内容一变 URL 就变，所以这些地址可以被浏览器直接存一年 —— 桩 nginx 上的
// `/sim/*.js` 原来每个都走 `no-cache` + 304 往返，一次页面加载十几个模块就是十几个来回
// （server/http/static.js 现在把「URL 上的 tag == 本次发布的 tag」直接当 immutable）。
// 自定义 base（测试的 file:/http: 基址、插件的临时目录）原样返回：那些字节不在发布的指纹里。
const simModule = (url) => (typeof url === 'string' && /^\/(?:sim|shared|data|packs)\//.test(url) ? resourceUrl(url) : url);
export async function loadBrowserSim({ base = '/sim/', dataBase = dataBasePath(), fetchFn = (...a) => globalThis.fetch(...a), data = null, cs = null, bounds = null,
  scripts = [], hashInput = null, nativeVerified = false, deferScripts = false } = {}) {
  const [spec, simdata, support] = await Promise.all([
    import(simModule(`${base}spec.js`)), import(simModule(`${base}simdata.js`)), import(simModule(`${base}content/support/index.js`)),
  ]);
  const fetchOnce = async (n) => {
    try {
      const url = resourceUrl(`${dataBase}${n}.json`);
      const res = await fetchFn(url, { cache: resourceCache(url) });
      return res && res.ok ? await res.json() : null;
    } catch { return null; }
  };
  // (a content set's data: structured copies, frozen below like downloaded files)
  const files = data ? SIM_DATA_FILES.map((n) => (data[n] && typeof data[n] === 'object' ? structuredClone(data[n]) : null))
    : await Promise.all(SIM_DATA_FILES.map(async (n) => (await fetchOnce(n)) ?? fetchOnce(n)));
  // a battle simulated without part of the data would still produce a plausible result the server accepts: never run
  // one — the loader fails (the next b.start retries it; meanwhile the server's deadline takes the field over)
  const missing = SIM_DATA_FILES.filter((n, i) => !files[i] || typeof files[i] !== 'object');
  if (missing.length) throw new Error(`simulation data unavailable: ${missing.join(', ')}`);
  const raw = {};
  SIM_DATA_FILES.forEach((n, i) => { raw[n] = deepFreeze(files[i]); });
  simdata.setSimData(raw);
  if (typeof support.setGameData === 'function') support.setGameData(null); // re-read through the injected data
  await installSimBounds(base, raw, data ? bounds : undefined);
  if (!deferScripts && scripts.length) {
    // sdk/scriptLoad/extensions 同样走发布 tag：插件运行时也是「内容变、URL 变」才敢让浏览器长缓存。
    const sdkPath = /^file:/i.test(base) ? null : simModule('/shared/plugins/sdk.js');
    const sdkUrl = sdkPath ? new URL(sdkPath, globalThis.location.href).href
      : new URL('../../shared/plugins/sdk.js',base).href;
    const {loadScripts} = await import(new URL('scriptLoad.js',sdkUrl).href);
    await loadScripts(scripts,{hashInput,sdkUrl,extensionsUrl:simModule(base+'content/extensions.js'),cs,nativeVerified});
  } else if (loadedScripts) (await import(simModule(base+'content/extensions.js'))).resetExtensions();
  loadedScripts = !deferScripts && scripts.length > 0;
  return { spec, ds: new simdata.DataSource(raw, null), cs, raw };
}

/**
 * The official-bounds table of the engine's plugin caps (shared/plugins/officialBounds.js, DESIGN §32.5): the original
 * content's page scans the data it loaded (no request); a room's content set installs the snapshot its index lists
 * (public/js/content.js loads and checks it beside the data files) — the one the server validated against and its match
 * host installs too, so both simulate a modded battle with the same caps. A content set without one runs on the floor,
 * never on a scan of its own tables (a bomb would raise its own cap). `bounds` undefined: the original content.
 * @param {string} base @param {Record<string, any>} raw @param {any} [bounds]
 */
async function installSimBounds(base, raw, bounds) {
  let boundsMod;
  try {
    const spec = /^https?:|^file:/i.test(String(base))
      ? new URL('../../shared/plugins/officialBounds.js', base).href
      : simModule('/shared/plugins/officialBounds.js');
    boundsMod = await import(spec);
  } catch { return; }
  if (bounds === undefined) boundsMod.rememberOfficialBounds(raw);
  else boundsMod.installOfficialBounds(bounds && bounds.v === 1 ? bounds : null);
}

