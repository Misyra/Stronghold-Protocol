// server/sim/content/kits/tier1.js — re-export shim (0.2.0 refactor, R4): the tier-1 kits live one per file in ops/,
// registered by index.js; their shared helpers and notes are in shared/tier1.js (README.md). This module keeps the
// old imports working until the shims are removed after the 0.2.0 refactor wave.
import { TIER_KITS } from './index.js';

export * from './shared/tier1.js';
export { tinmanKit } from './ops/chess_char_1_16-tinman.js';
export default TIER_KITS[0];
