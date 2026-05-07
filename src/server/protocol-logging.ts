// Structured server-side logging for wire-protocol failures (FR-022, R-8).
//
// Routes through the project logger (which wraps `console.warn`) so the
// failure shape is consistent with the rest of the server's observability
// surface. Always emitted regardless of `NODE_ENV` — production drift
// remains observable.

import type { ErrorCode } from "@litus/protocol";
import { logger } from "../logger";

export interface ProtocolFailure {
	code: ErrorCode;
	originalType?: string;
	socketId?: string;
	issues?: ReadonlyArray<unknown>;
	details?: Record<string, unknown>;
}

export function logProtocolFailure(failure: ProtocolFailure): void {
	logger.warn("[ws] protocol failure", {
		code: failure.code,
		originalType: failure.originalType,
		socketId: failure.socketId,
		issues: failure.issues,
		details: failure.details,
	});
}
