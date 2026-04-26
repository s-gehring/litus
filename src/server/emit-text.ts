import type { Channel, ServerMessage } from "../types";

/**
 * Map a `Channel` + free text to its corresponding `ServerMessage` wire frame.
 *
 * The exhaustive `switch` over `channel.kind` (with a `never`-typed default
 * arm) is the FR-010 ratchet: adding a `Channel` variant without a matching
 * arm here is a compile-time error.
 */
export function channelToMessage(channel: Channel, text: string): ServerMessage {
	switch (channel.kind) {
		case "workflow":
			return { type: "workflow:output", workflowId: channel.workflowId, text };
		case "epic":
			return { type: "epic:output", epicId: channel.epicId, text };
		case "console":
			return { type: "console:output", text };
		default: {
			const _exhaustive: never = channel;
			return _exhaustive;
		}
	}
}

/**
 * Build an `emitText` bound to a specific `broadcast` function. The returned
 * function is the only sanctioned producer of `workflow:output`, `epic:output`,
 * and `console:output` wire frames — see `tests/unit/emit-text-source-scan.test.ts`.
 */
export function createEmitText(
	broadcast: (msg: ServerMessage) => void,
): (channel: Channel, text: string) => void {
	return (channel, text) => {
		broadcast(channelToMessage(channel, text));
	};
}
