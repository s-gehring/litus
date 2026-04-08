import type { ServerMessage, StateChange, StateChangeListener } from "../types";
import type { ClientStateManager } from "./client-state-manager";

export class MessageDispatcher {
	private stateManager: ClientStateManager;
	private listener: StateChangeListener | null = null;

	constructor(stateManager: ClientStateManager) {
		this.stateManager = stateManager;
	}

	onViewUpdate(cb: StateChangeListener): void {
		this.listener = cb;
	}

	dispatch(msg: ServerMessage): StateChange {
		const change = this.stateManager.handleMessage(msg);
		if (this.listener) {
			this.listener(change, msg);
		}
		return change;
	}
}
