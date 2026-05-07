// Routing target for a free-text server→client message. Not directly
// emitted on the wire — the server resolves a `Channel` to a concrete
// `workflow:output` / `epic:output` / `console:output` frame.

import { z } from "zod";

export const channelSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("workflow"), workflowId: z.string() }),
	z.object({ kind: z.literal("epic"), epicId: z.string() }),
	z.object({ kind: z.literal("console") }),
]);

export type Channel = z.infer<typeof channelSchema>;
