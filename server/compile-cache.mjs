// server/compile-cache.mjs — the V8 compile cache of the module graph (package.json start/dev pass it via
// node --import, so it is enabled BEFORE server/index.js and its ~400 modules compile). Pure startup speedup:
// the first boot fills .cache/compile (gitignored), every later one reads the compiled modules from it, and Node
// invalidates entries whenever a source file changes — nothing about the loaded code differs. A cache that cannot
// be written (read-only checkout, unusual HOME) only costs compile time, so it never blocks boot; direct
// `node server/index.js` runs without it.
import { enableCompileCache } from 'node:module';
import { fileURLToPath } from 'node:url';
try {
  enableCompileCache(fileURLToPath(new URL('../.cache/compile/', import.meta.url)));
} catch { /* diagnostic only — an unusable cache dir is not a boot problem */ }
