// An <img> that failed is asked for again (feedback #44): a fetch or Spine load takes retry rounds, but a picture had
// one failure and its fallback stayed until the page reloaded. On a line taken by a material download both sources can
// time out while the art is fine, which leaves bond icons, avatars and tier chips as a letter on a disc. A failed URL
// now rests and is tried again, three times per page life.

import { useEffect, useState } from '../../vendor/hooks.module.js';

/** How long a failed picture rests before it is asked for again; a URL gets one try per entry in a page's life. */
export const IMAGE_RETRY_MS = Object.freeze([10000, 30000, 120000]);
const retried = new Map();

/**
 * A picture that failed, for the fallback a caller draws: `[failed, fail]`. The rounds are counted per URL, so a
 * picture that really is missing costs a few requests at most.
 * @param {string|null|undefined} src @returns {[boolean, () => void]}
 */
export function useImageFailure(src) {
  const [bad, setBad] = useState(null);
  useEffect(() => {
    if (bad == null) return undefined;
    const n = retried.get(bad) || 0;
    if (n >= IMAGE_RETRY_MS.length) return undefined;
    const timer = setTimeout(() => { retried.set(bad, n + 1); setBad(null); }, IMAGE_RETRY_MS[n]);
    return () => clearTimeout(timer);
  }, [bad]);
  return [bad != null && bad === src, () => setBad(src)];
}
