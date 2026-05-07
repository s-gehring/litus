// Wire-protocol runtime constants shared between server and clients.

// Coalescing window for `StateChange` deltas before they flush to clients.
// 50 ms trades a small added latency for meaningful message coalescing
// under burst (CLI stream events arriving in the same tick collapse into
// one frame).
export const DELTA_FLUSH_TIMEOUT_MS = 50;

// Sentinel sent in place of a saved Telegram bot token so the plaintext
// value never leaves the server. Re-saving the form with this value
// preserves the stored token; any other value (including "") replaces it.
export const TELEGRAM_TOKEN_SENTINEL = "***configured***";

// WebSocket close code emitted on a protocol-version mismatch or a missing
// initial `client:hello` frame (FR-013, edge case "no first frame").
export const CLOSE_CODE_PROTOCOL = 4001;
