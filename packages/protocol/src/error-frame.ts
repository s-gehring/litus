// Unified error frame contract (FR-021, R-4).
//
// `message` is human-readable. `details` carries structured machine-
// readable context (Zod issues, version info). `requestType` is
// preserved for backward compatibility with the existing
// `workflow:retry-workflow` flow.
//
// NOTE: per FR-021/R-4 `code` is intended to be required. It is
// declared optional here for migration compatibility — the legacy server
// has ~50 emission sites that emit error frames without `code`.
// New emission sites (message-router safeParse path, version
// handshake) MUST set an explicit `code`. Tightening this to `required`
// is a follow-up that updates the legacy sites.

import { z } from "zod";

export const errorCodeSchema = z.enum([
	"schema_violation",
	"version_mismatch",
	"missing_protocol_version",
	"message_too_large",
	"internal",
	"invalid_state",
	"not_found",
	"persist_failed",
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorFrameSchema = z.object({
	type: z.literal("error"),
	code: errorCodeSchema.optional(),
	message: z.string(),
	details: z.unknown().optional(),
	requestType: z.string().optional(),
});

export type ErrorFrame = z.infer<typeof errorFrameSchema>;
