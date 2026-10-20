// Adapted from xinhai-ai/Stronghold-Protocol (GPL-3.0-or-later).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, normalizePath } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const absolute = (rel) => normalizePath(path.join(root, rel));
const browserData = '\0stronghold-browser-data';
const guardedImports = new Map([
  [absolute('server/sim/content/index.js'), ['./kits/index.js', ...['tokens', 'devices', 'enemies', 'bosses', 'bonds', 'garrisons', 'items', 'bands', 'choices'].map((name) => `./${name}.js`)]],
  [absolute('server/sim/content/bands.js'), ['./bands/battle.js', './bands/meta.js']],
  [absolute('server/sim/content/bonds.js'), ['./bonds/core.js', './bonds/addon.js', './support/meta.js']],
  [absolute('server/sim/content/kits/index.js'), ['./ops/*.js']],
]);

/** The sim modules are fetched as /sim/* at run time and mapped onto server/sim/ for the bundle.
 *  The worker pass is its own Rollup build and does not inherit this plugin, so it is registered there too
 *  (public/js/battle/simHost.js bundles simWorker.js, whose runtime does import('/sim/detmath.js')). */
const simPaths = () => ({
  name: 'stronghold-sim-paths',
  enforce: 'pre',
  resolveId(source) {
    if (source.startsWith('/sim/')) return absolute(`server${source}`);
  },
});

function browserContracts() {
  return {
    name: 'stronghold-browser-contracts',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === '/vendor/three.module.js') return absolute('public/vendor/three.module.js');
      const resolved = source.startsWith('.') && importer
        ? normalizePath(path.resolve(path.dirname(importer), source)) : normalizePath(source);
      if (resolved === absolute('server/data.js')) return browserData;
      if (resolved === absolute('server/sim/nodeData.js')) this.error('Node-only simulation data cannot enter the client bundle');
    },
    load(id) {
      if (id === browserData) return `
        import { getSimData } from ${JSON.stringify(absolute('server/sim/simdata.js'))};
        export function getData() { return getSimData() || {}; }
        export function resetData() {}
      `;
    },
    transform(code, id) {
      if (id === absolute('public/js/resources/common.js')) {
        // A worker has no page import map. Bundle its complete module graph separately, instead of
        // revalidating dozens of unversioned /js/resources and /shared files on every update check.
        // Worker builds intentionally do not inherit this plugin, avoiding recursive worker bundling.
        return { code: `import __spBuiltResourceWorker from '../../resource-sw.js?worker&url';\n`
          + code.replace("const BUILT_SW_URL = '';", 'const BUILT_SW_URL = __spBuiltResourceWorker;'), map: null };
      }
      if (guardedImports.has(id)) {
        // Keep the native loader/error isolation, but make its complete module set visible to Vite.
        const kit = id === absolute('server/sim/content/kits/index.js');
        const expression = kit ? 'import(`./ops/${file}`)' : 'import(path)';
        if (!code.includes(expression)) this.error(`Guarded simulation loader changed: ${id}`);
        const lookup = kit ? '`./ops/${file}`' : 'path';
        return { code: `const __spContentLoaders = import.meta.glob(${JSON.stringify(guardedImports.get(id))});\n`
          + code.replace(expression, `__spContentLoaders[${lookup}]()`), map: null };
      }
      if (id === absolute('public/js/render/app/pixi.js')) {
        // Classic scripts must use the same retained content hashes as the HTML prefetches.
        return { code: code.replace(/'\/vendor\/(pixi\.min\.js|pixi-spine\.js)'/g,
          (_, name) => `new URL('../../../vendor/${name}', import.meta.url).href`), map: null };
      }
      if (id !== absolute('server/sim/simdata.js')) return;
      const branch = this.parse(code).body.find((node) => node.type === 'IfStatement' && node.test.type === 'Identifier'
        && node.test.name === 'IS_NODE');
      if (!branch || branch.alternate) this.error('Cannot identify the simulation Node-only initializer');
      return { code: code.slice(0, branch.start) + code.slice(branch.end), map: null };
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html
          .replace(/\s*<script type="importmap">[\s\S]*?<\/script>/, '')
          .replace(/\s*<link rel="modulepreload"[^>]*>/g, '')
          .replace(/\s*<link rel="manifest"[^>]*>/, '')
          .replace(/\s*<link rel="stylesheet" href="\/fonts\/fonts.css"\s*\/>/, '')
          .replace("why === 'old' || !im", "why === 'old'");
      },
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const html = bundle['index.html'];
        if (!html || html.type !== 'asset') this.error('Missing client HTML');
        let source = String(html.source);
        for (const name of ['pixi.min.js', 'pixi-spine.js']) {
          const asset = Object.values(bundle).find((item) => item.type === 'asset' && item.names.includes(name));
          if (!asset) this.error(`Missing bundled vendor asset: ${name}`);
          source = source.replace(`/vendor/${name}`, `/build/${asset.fileName}`);
        }
        source = source.replace(/(<script type="module"[^>]*)(><\/script>)/,
          '$1 onerror="window.__spBootFail && window.__spBootFail(\'load\')"$2');
        html.source = source.replace('<meta name="theme-color"', '<link rel="manifest" href="/manifest.json" />\n  <link rel="stylesheet" href="/fonts/fonts.css" />\n  <meta name="theme-color"');
      },
    },
  };
}

export default defineConfig({
  root: absolute('public'),
  publicDir: false,
  base: '/build/',
  plugins: [simPaths(), browserContracts()],
  // The module worker simHost.js spawns is bundled as ESM (it imports /vendor/acorn.mjs at run time).
  worker: { format: 'es', plugins: () => [simPaths()] },
  build: {
    outDir: absolute('public/build'),
    // An open tab may still need the preceding build's lazy modules after a deploy.
    emptyOutDir: false,
    target: ['chrome90', 'edge90', 'firefox108', 'safari16.4'],
    assetsInlineLimit: 0,
    manifest: true,
    rollupOptions: {
      // 服务端在请求时生成 /js/asset-cdn.js（Xinhai 的 static.js 按 SP_ASSETS_CDN / SP_DATA_CDN 写）：
      // 构建必须把它留成同源外部 URL，否则会把磁盘上的空配置打进包。
      external: [/^\/js\/asset-cdn\.js$/],
      makeAbsoluteExternalsRelative: false,
      output: {
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          if (/\/vendor\/(preact|hooks|htm)\.module\.js$/.test(id)) return 'ui-vendor';
          if (/\/vendor\/three\.(core|module)\.js$/.test(id)) return 'three';
          if (id.startsWith(absolute('shared') + '/')) return 'shared';
          if (id === browserData || (id.includes('/server/sim/') && !id.endsWith('/constants.js'))) return 'simulation';
        },
      },
    },
  },
});
