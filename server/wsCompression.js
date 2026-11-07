// Bounded, opt-in WS compression (ported from the Stardust fork, DESIGN §37.138). Credentials and unknown/control
// messages stay uncompressed. Server→browser frames share one deflate context per connection (context takeover,
// 32 KiB window, ~144 KiB of zlib state per socket): a state snapshot or battle frame mostly repeats the previous
// one, so it costs a fraction of its own size. Only allowlisted frames ever enter that context — never welcome
// (credential) or control messages.
// The server side of the offer is left to the client: browsers offer neither parameter and get the shared context
// with the full window, and an offer that asks for server_no_context_takeover or a smaller server window is accepted
// as asked. Pinning `serverNoContextTakeover: false` / `serverMaxWindowBits: 15` made ws refuse such offers, which
// fails the whole upgrade with HTTP 400 instead of degrading the compression (ws permessage-deflate acceptAsServer).
export const WS_COMPRESSION_OPTIONS = Object.freeze({
  threshold: 0,
  clientNoContextTakeover: true,
  concurrencyLimit: 8,
  zlibDeflateOptions: Object.freeze({ level: 6, memLevel: 5 }),
});

// State frames and the battle stream. Deflating each small b.snap/b.ev on its own cost more CPU than it saved; with
// the shared context they shrink several-fold for little CPU. b.ext (a boss replica's pool record) rides along.
// m.state carries m.public / m.private (server/stateTransport.js). Everything else — welcome (credentials), error,
// ok/pong, room setup — is sent plain: never compressed, never in the shared context (net.js sendRaw/send).
const COMPRESSIBLE = new Set([
  'm.public', 'm.private', 'm.state', 'm.unitStats', 'm.field', 'm.damage',
  'b.damage', 'b.start', 'b.snap', 'b.ev', 'b.ext',
]);

/**
 * The permessage-deflate config SP_WS_COMPRESSION asks for: the preset for 'on', `false` (compression off) for
 * 'off'. Anything else throws — a mistyped value must refuse to boot, not silently pick a side.
 * @param {string} mode 'on' | 'off'
 * @returns {false | typeof WS_COMPRESSION_OPTIONS}
 */
export function resolveWsCompression(mode) {
  if (mode === 'off') return false;
  if (mode === 'on') return WS_COMPRESSION_OPTIONS;
  throw new TypeError('SP_WS_COMPRESSION must be on or off');
}

/**
 * Whether a message of this `t` may enter the connection's shared deflate context.
 * @param {unknown} type a message's `t`
 * @returns {boolean}
 */
export function isCompressibleType(type) {
  return typeof type === 'string' && COMPRESSIBLE.has(type);
}
