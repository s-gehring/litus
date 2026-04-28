import type { Alert, ServerMessage } from "../../types";
import type { AlertSliceState, ReducerResult } from "./types";

const ALERT_OWNED = ["alert:list", "alert:created", "alert:dismissed", "alert:seen"] as const;

export type AlertOwnedType = (typeof ALERT_OWNED)[number];
export const OWNED_TYPES: ReadonlySet<AlertOwnedType> = new Set(ALERT_OWNED);
export type AlertSliceMessage = Extract<ServerMessage, { type: AlertOwnedType }>;

export function createState(): AlertSliceState {
	return { alerts: new Map<string, Alert>() };
}

export function reduce(
	state: AlertSliceState,
	message: AlertSliceMessage,
): ReducerResult<AlertSliceState> {
	switch (message.type) {
		case "alert:list":
			return handleList(state, message);
		case "alert:created":
			return handleCreated(state, message);
		case "alert:dismissed":
			return handleDismissed(state, message);
		case "alert:seen":
			return handleSeen(state, message);
	}
}

function handleList(
	state: AlertSliceState,
	msg: Extract<AlertSliceMessage, { type: "alert:list" }>,
): ReducerResult<AlertSliceState> {
	state.alerts.clear();
	for (const a of msg.alerts) state.alerts.set(a.id, a);
	return {
		state,
		change: { notify: true, affectsCardOrder: false },
		stateChange: { scope: { entity: "global" }, action: "updated" },
	};
}

function handleCreated(
	state: AlertSliceState,
	msg: Extract<AlertSliceMessage, { type: "alert:created" }>,
): ReducerResult<AlertSliceState> {
	state.alerts.set(msg.alert.id, msg.alert);
	return {
		state,
		change: { notify: true, affectsCardOrder: false },
		stateChange: { scope: { entity: "global" }, action: "added" },
	};
}

function handleDismissed(
	state: AlertSliceState,
	msg: Extract<AlertSliceMessage, { type: "alert:dismissed" }>,
): ReducerResult<AlertSliceState> {
	let removed = 0;
	for (const id of msg.alertIds) {
		if (state.alerts.delete(id)) removed += 1;
	}
	return {
		state,
		change: { notify: removed > 0, affectsCardOrder: false },
		stateChange: { scope: { entity: "global" }, action: "removed" },
	};
}

function handleSeen(
	state: AlertSliceState,
	msg: Extract<AlertSliceMessage, { type: "alert:seen" }>,
): ReducerResult<AlertSliceState> {
	let changed = 0;
	for (const id of msg.alertIds) {
		const a = state.alerts.get(id);
		if (a && !a.seen) {
			a.seen = true;
			changed += 1;
		}
	}
	return {
		state,
		change: { notify: changed > 0, affectsCardOrder: false },
		stateChange: { scope: { entity: "global" }, action: "updated" },
	};
}

export function reset(state: AlertSliceState): ReducerResult<AlertSliceState> {
	state.alerts.clear();
	return {
		state,
		change: { notify: true, affectsCardOrder: false },
		stateChange: { scope: { entity: "global" }, action: "cleared" },
	};
}
