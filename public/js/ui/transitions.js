// 转场 helpers (PR #643): small hooks for the one-off motion of the room and the pre-game screens. With
// prefers-reduced-motion nothing plays. [ASSUMED] The motion and its timings (700 ms here, the room's 480 / 70 ms rise in
// css/screens/room.css) come from the community PR #643 design, not from a recording of the event.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { reducedMotion } from './device.js';

/**
 * True for `ms` after `value` turns truthy — not on the first render, so a seat already ready when the room opens (or a
 * pick already made when the draft opens) does not flash; never with reduced motion. screens/room.js (a seat turns
 * ready, an AI teammate is added), screens/bandDraft.js (a pick lands on an order row).
 * @param {any} value
 * @param {number} [ms]
 * @param {boolean} [fresh] the component mounts after its screen was already showing (a seat card that just appeared): a
 *   truthy `value` at the first render flashes too
 */
export function useRise(value, ms = 700, fresh = false) {
  const prev = useRef(fresh ? false : !!value);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const was = prev.current;
    prev.current = !!value;
    if (!value) { setOn(false); return undefined; }
    if (was || reducedMotion()) return undefined;
    setOn(true);
    const id = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(id);
  }, [!!value]);
  return on;
}

// ---- 匹配流程的转场 (移植自用户分支, 2026-10-13: overlays leave the same way they enter) ----

/** How long a full-screen overlay takes to leave (its content fades, then the black lifts off what is below). */
export const LEAVE_MS = 300;

/**
 * [leaving, leave]: leave() marks the view as leaving (class is-leaving fades it out) and calls `done` once that has
 * played; a second call while leaving is ignored.
 * @param {() => void} done @param {number} [ms]
 */
export function useLeave(done, ms = LEAVE_MS) {
  const [leaving, setLeaving] = useState(false);
  const timer = useRef(null);
  const doneRef = useRef(done);
  doneRef.current = done;
  useEffect(() => () => clearTimeout(timer.current), []);
  const leave = () => {
    if (timer.current) return;
    if (reducedMotion()) { doneRef.current(); return; }
    setLeaving(true);
    timer.current = setTimeout(() => doneRef.current(), ms);
  };
  return [leaving, leave];
}

/** Resolves once a leaving animation of `ms` has played (at once with reduced motion). @param {number} [ms] */
export function afterLeave(ms = LEAVE_MS) {
  return new Promise((resolve) => { setTimeout(resolve, reducedMotion() ? 0 : ms); });
}

/**
 * Keeps a view mounted for `ms` after `show` turns false so its leaving animation can play: [mounted, leaving].
 * @param {boolean} show @param {number} [ms]
 */
export function usePresence(show, ms = 220) {
  const [kept, setKept] = useState(!!show);
  useEffect(() => {
    if (show) { setKept(true); return undefined; }
    if (!kept) return undefined;
    if (reducedMotion()) { setKept(false); return undefined; }
    const id = setTimeout(() => setKept(false), ms);
    return () => clearTimeout(id);
  }, [!!show]);
  return [!!show || kept, !show && kept];
}
