// server/sim/content/kits/tier6.js — re-export shim (0.2.0 refactor, R4): the tier-6 kits live one per file in ops/,
// registered by index.js; their shared helpers and notes are in shared/tier6.js (README.md). This module keeps the
// old imports working until the shims are removed after the 0.2.0 refactor wave.
import { TIER_KITS } from './index.js';

export { PITHST_ELEMENTS } from './ops/chess_char_1_15-pithst.js';
export default TIER_KITS[5];
