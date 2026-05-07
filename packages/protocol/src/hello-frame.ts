// Hello-frame variants for the connection-level version handshake
// (FR-010..FR-014, R-3). The server emits `hello` as the very first
// frame on connect; the client emits `client:hello` as its first frame
// after `ws.onopen` (no need to wait for the server's hello — concurrent
// send).

import { z } from "zod";
import { protocolVersionSchema } from "./version";

export const serverHelloSchema = z.object({
	type: z.literal("hello"),
	protocolVersion: protocolVersionSchema,
});

export const clientHelloSchema = z.object({
	type: z.literal("client:hello"),
	protocolVersion: protocolVersionSchema,
});

export type ServerHello = z.infer<typeof serverHelloSchema>;
export type ClientHello = z.infer<typeof clientHelloSchema>;
