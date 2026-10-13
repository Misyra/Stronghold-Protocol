/** Page-local preload state. Compare only changed fields, not the entire progress document twice. */
export function createResourceState(initial) {
  const state = { ...initial }, listeners = new Set();
  const snapshot = () => ({ ...state });
  const equal = (a, b) => Object.is(a, b) || (a !== null && b !== null && typeof a === 'object' &&
    typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
  return {
    state,
    snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(patch) {
      const changed = Object.keys(patch).some((key) => !equal(state[key], patch[key]));
      Object.assign(state, patch);
      if (!changed) return;
      for (const fn of [...listeners]) {
        try { fn(snapshot()); } catch (error) { console.error('[resources] listener failed', error); }
      }
    },
  };
}
