// Component-level memoization for the vendored Preact (public/vendor/ has no `memo` export and must not be
// touched — tools/vendor.mjs generates it): `memo(Component)` returns a wrapper whose shouldComponentUpdate
// shallow-compares the next props against the current ones (store.js shallowEqual, the same semantics as
// `useStore(sel, shallowEqual)`) and skips re-rendering the wrapped component — and with it the whole subtree —
// while every prop is `Object.is`-equal. On a skipped update Preact still assigns the new props onto the
// instance, so the next accepted render (or the wrapped component's own setState) sees them.
//
// The wrapper is a preact class component (prototype.render makes diff take the class path and honor
// shouldComponentUpdate) that can still be CALLED as a plain function: the unit tests invoke the wrapped cards
// directly (`ChessCard({ … })`) to inspect their rendered tree, and a plain call just renders once.
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
 * @returns {(props: P) => any} the memoized component (a class component; plain-callable for direct tests)
 */
export function memo(wrapped, propsAreEqual = null) {
  function Memoed(props) {
    if (new.target) { this.props = props; return; } // preact's class path: `new Memoed(props, context)`
    return wrapped(props); // a plain call (the unit tests render the cards directly): one render, no memo
  }
  Memoed.prototype.render = function () { return createElement(wrapped, this.props); };
  Memoed.prototype.shouldComponentUpdate = function (nextProps) {
    return !(propsAreEqual ? propsAreEqual(this.props, nextProps) : shallowEqual(this.props, nextProps));
  };
  // the base component's setState / forceUpdate / instanceof (the wrapper itself never calls them)
  Object.setPrototypeOf(Memoed.prototype, Component.prototype);
  // the profiler / devtools name (read-only in some engines; cosmetic either way)
  try { Object.defineProperty(Memoed, 'displayName', { value: `Memo(${wrapped.displayName || wrapped.name || 'Anonymous'})`, configurable: true }); } catch { /* ignore */ }
  return Memoed;
}
