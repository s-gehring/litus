// Outgoing-frame schema validation, gated by `NODE_ENV` (R-5, R-7).
//
// In production this is a no-op so the schema walk does not pay any cost
// on the hot path. In dev/test it calls `serverMessageSchema.parse(msg)`
// — the THROWING variant — so a schema-drift failure surfaces with a
// stack trace that points at the offending `sendTo` / `broadcast` site,
// rather than a quietly malformed frame on the wire.

import { type ServerMessage, serverMessageSchema } from "./server-messages";

const VALIDATE_OUTGOING = process.env.NODE_ENV !== "production";

export function validateOutgoingInDev(msg: ServerMessage): void {
	if (!VALIDATE_OUTGOING) return;
	serverMessageSchema.parse(msg);
}
