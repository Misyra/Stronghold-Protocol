// Fork-specific transport hints. Match code must not import the socket-owning network layer.
export const ENCODED = Symbol('sp.encoded');
export const STATE_COALESCE = Symbol('sp.stateCoalesce');

/** Capture a shared battle frame once; symbol metadata is invisible in its JSON form. */
export function preencode(message) {
  try { message[ENCODED] = JSON.stringify(message); }
  catch { message[ENCODED] = null; }
}
