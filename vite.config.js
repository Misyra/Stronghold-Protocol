// Production bundle of the browser UI layer: public/index.html, public/js and public/css → public/build/
// (`npm run build`; served when the bundle is on disk — server/http/static.js, `SP_CLIENT=source` forces the source
// page). Ported from Stardust-minus (vite.config.js at cd28e162, itself after xinhai-ai/Stronghold-Protocol f164a5e),
// narrowed the same way (owner's choice of 2026-10-16, brought back 2026-11-04): /shared, /sim and /data are NOT
// bundled. They stay native modules and JSON at their own URLs, so the page imports /shared/* and loads the
// simulation exactly as it does unbundled. Also left as they are: the classic boot scripts (/js/boot.js,
// /js/bootLegacy.js, /js/webFonts.js), the Pixi classic scripts and three.js under /vendor/, and both Web Workers
// (/js/battle/simWorker.js keeps its own CSP header and plugin sandbox; /js/battle/rehearsalWorker.js is named by a
// literal URL in battle/rehearsal.js) — so /js/ is still deployed beside /build/.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, normalizePath } from 'vite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const abs = (rel) => normalizePath(path.join(ROOT, rel));
const SHARED = abs('shared') + '/';
const SIM = abs('server/sim') + '/';
const PUBLIC = abs('public') + '/';
// public/ paths that stay at their own URL (not bundled): the vendored three.js (imported by URL at run time anyway)
const KEEP_PUBLIC = new Set(['vendor/three.module.js', 'vendor/three.core.js']);

/** Keep /shared/*, /sim/* and the kept /vendor/ files as native imports of their site URL. */
export function keepNativeModules() {
  return {
    name: 'stronghold-native-modules',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source.startsWith('/shared/') || source.startsWith('/sim/')) return { id: source, external: 'absolute' };
      if (!importer || !(source.startsWith('.') || source.startsWith('/'))) return null;
      const file = source.startsWith('/') && !source.startsWith(ROOT)
        ? normalizePath(path.join(ROOT, 'public', source)) : normalizePath(path.resolve(path.dirname(importer), source));
      if (file.startsWith(SHARED)) return { id: '/shared/' + file.slice(SHARED.length), external: 'absolute' };
      if (file.startsWith(SIM)) return { id: '/sim/' + file.slice(SIM.length), external: 'absolute' };
      if (file.startsWith(PUBLIC) && KEEP_PUBLIC.has(file.slice(PUBLIC.length))) return { id: '/' + file.slice(PUBLIC.length), external: 'absolute' };
      return null;
    },
    transform(code, id) {
      // The simulation Worker stays /js/battle/simWorker.js: its CSP header (static.js SIM_WORKER_CSP) and the plugin
      // sandbox are tied to that URL. Vite would otherwise bundle the `new URL(…, import.meta.url)` worker.
      if (id !== abs('public/js/battle/simHost.js')) return null;
      const from = "new Worker(new URL('./simWorker.js', import.meta.url), { type: 'module' })";
      if (!code.includes(from)) this.error('simHost.js: the simulation Worker construction changed; update vite.config.js');
      return { code: code.replace(from, "new Worker('/js/battle/simWorker.js', { type: 'module' })"), map: null };
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        // the bundle needs neither the import map nor the source modulepreloads (Vite adds its own for its chunks)
        let out = html.replace(/\s*<script type="importmap">[\s\S]*?<\/script>/, '').replace(/\s*<link rel="modulepreload"[^>]*>/g, '');
        if (out.includes('type="importmap"') || out.includes('rel="modulepreload"')) throw new Error('index.html: import map / modulepreload not removed');
        // icons, the web app manifest, the web-font links, the self-hosted fonts and the Pixi prefetches keep their
        // own URLs (vite-ignore: Vite neither copies nor rewrites them, and drops the attribute)
        out = out.replace(/<link rel="(?:manifest|icon|apple-touch-icon|prefetch)"[^>]*?(?=\s*\/?>)/g, (tag) => `${tag} vite-ignore`)
          .replace(/<link rel="stylesheet" href="\/fonts\/fonts\.css"(?=\s*\/?>)/, (tag) => `${tag} vite-ignore`)
          .replace(/<link rel="stylesheet" media="print" data-web-fonts href="\/fonts\/webfonts\.css"(?=\s*\/?>)/, (tag) => `${tag} vite-ignore`);
        if ((out.match(/ vite-ignore/g) || []).length < 10) throw new Error('index.html: the kept links changed; update vite.config.js');
        return out;
      },
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const page = bundle['index.html'];
        if (!page || page.type !== 'asset') this.error('the build has no index.html');
        let html = String(page.source);
        // Vite moves the entry script into <head>. Put it back where the source has it — after /js/boot.js, whose
        // capture listener reports a failed load of #sp-main — and keep that id.
        const entry = /\s*<script type="module" crossorigin src="(\/build\/assets\/[^"]+\.js)"><\/script>/.exec(html);
        if (!entry || !html.includes('<script nomodule')) this.error('index.html: entry script or nomodule fallback not found');
        html = html.replace(entry[0], '').replace('<script nomodule', `<script type="module" crossorigin src="${entry[1]}" id="sp-main"></script>\n  <script nomodule`);
        page.source = html;
      },
    },
  };
}

export default defineConfig({
  root: abs('public'),
  publicDir: false, // never copy art, fonts or vendor files: they keep their own URLs
  base: '/build/',
  logLevel: 'warn',
  plugins: [keepNativeModules()],
  build: {
    outDir: abs('public/build'),
    emptyOutDir: true,
    // the supported browsers (README; public/js/boot.js): Chrome / Edge 90+, Firefox 108+ (ESR 115), Safari 16.4+
    target: ['chrome90', 'edge90', 'firefox108', 'safari16.4'],
    cssTarget: ['chrome90', 'edge90', 'firefox108', 'safari16.4'],
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    manifest: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
    rolldownOptions: { input: abs('public/index.html') },
  },
});
