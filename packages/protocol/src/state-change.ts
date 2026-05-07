// In-process observer types. These do NOT cross the WebSocket — they live
// in `@litus/protocol` because they were historically co-located with the
// wire types in `protocol.ts`. Server-internal listeners receive them
// alongside the `ServerMessage` payload that triggered the change.

import type { ServerMessage } from "./server-messages";

export type StateChangeScope =
	| { entity: "workflow"; id: string }
	| { entity: "epic"; id: string }
	| { entity: "config"; key?: string }
	| { entity: "global" }
	| { entity: "output"; id: string }
	| { entity: "none" };

export type StateChangeAction = "added" | "updated" | "removed" | "cleared" | "appended";

export interface StateChange {
	scope: StateChangeScope;
	action: StateChangeAction;
}

export type StateChangeListener = (change: StateChange, msg: ServerMessage) => void;
