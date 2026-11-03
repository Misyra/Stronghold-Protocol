// Older builds wrote a runtime-existence document next to the cache index (`{ version: 1, files }`). Nothing ever read
// it back — `ResourceStore#status()` enumerates the keys a card really holds — so the writer is gone and this module now
// only names the document a sweep deletes (resources/store.js, docs/ASSETS.md「Preload」).
import { absoluteUrl } from './common.js';

export const RUNTIME_INDEX_PATH = '/__sp-runtime-resource-index__';

export const runtimeIndexUrl = (origin) => absoluteUrl(RUNTIME_INDEX_PATH, origin);
