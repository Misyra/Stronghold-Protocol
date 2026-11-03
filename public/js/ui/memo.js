// Component-level memoization for the vendored Preact (public/vendor/ has no `memo` export and must not be
// touched — tools/vendor.mjs generates it): `memo(Component)` returns a wrapper class component whose
// shouldComponentUpdate shallow-compares the next props against the current ones (store.js shallowEqual, the
// same semantics as `useStore(sel, shallowEqual)`) and skips re-rendering the wrapped component — and with it
// the whole subtree — while every prop is `Object.is`-equal. On a skipped update Preact still assigns the new
// props onto the instance, so the next accepted render (or the wrapped component's own setState) sees them.
//
// MatchScreen re-renders as a whole on every `m.public` / `m.private` / `m.field` push and on every local
// interaction state; the memoized panels (ui/shopBar.js, ui/detailPanel.js, ui/teamPanel.js, ui/hud.js TopBar)
// sit out the pushes and interactions that do not touch their props. A memoized component therefore requires
// stable function/object props at its call sites (useCallback / useMemo) — a prop that is rebuilt each render
// keeps the component re-rendering every time.
//
// Only props are compared (state changes always re-render); nested objects are compared by reference, never
// deep. A custom `propsAreEqual(a, b)` replaces the default compare for components whose props carry a
// derived value that is rebuilt each render (see ChessCard/ItemCard/RewardCards in ui/shopBar.js).
import { Component, createElement } from '../../vendor/preact.module.js';
import { shallowEqual } from '../store.js';

/**
 * Memoize a component: re-render it only when a prop changed (shallow compare, or `propsAreEqual`).
 * @template P
 * @param {(props: P) => any} wrapped the component to wrap (a function component; hooks inside it keep working)
 * @param {(a: P, b: P) => boolean} [propsAreEqual] custom equality (true = skip the render)
 * @returns {typeof Component} the memoized component
 */
export function memo(wrapped, propsAreEqual = null) {
  class Memoed extends Component {
    shouldComponentUpdate(nextProps) {
      return !(propsAreEqual ? propsAreEqual(this.props, nextProps) : shallowEqual(this.props, nextProps));
    }

    render() {
      return createElement(wrapped, this.props);
    }
  }
  // the profiler / devtools name (read-only in some engines; cosmetic either way)
  try { Object.defineProperty(Memoed, 'displayName', { value: `Memo(${wrapped.displayName || wrapped.name || 'Anonymous'})`, configurable: true }); } catch { /* ignore */ }
  return Memoed;
}
