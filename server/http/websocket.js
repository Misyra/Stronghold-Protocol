// server/http/websocket.js — the WebSocket endpoint (moved from server/index.js).

/** Inbound WebSocket frame limit (DESIGN §8). */
export const WS_MAX_PAYLOAD = 64 * 1024;
