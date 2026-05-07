// Wire-protocol version (FR-010, R-10).
//
// Bumping policy lives in the package README:
//   - minor: additions (new optional field, new variant, new error code)
//   - major: removals/renames/incompatible type changes; discriminator
//     value changes
//
// A connecting client whose `protocolVersion.major` differs from the
// server's emits a typed `error` frame with `code: "version_mismatch"`
// and the socket closes with `CLOSE_CODE_PROTOCOL = 4001`. Minor
// differences are accepted (FR-014).

import { z } from "zod";

export const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;

export const protocolVersionSchema = z.object({
	major: z.number().int().nonnegative(),
	minor: z.number().int().nonnegative(),
});

export type ProtocolVersion = z.infer<typeof protocolVersionSchema>;
