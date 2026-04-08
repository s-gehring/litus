import type { ClientMessage, ServerMessage } from "../types";
import type { MessageHandler } from "./handler-types";

export const handleConfigGet: MessageHandler = (ws, _data, deps) => {
	deps.sendTo(ws, { type: "config:state", config: deps.configStore.get() });
};

export const handleConfigSave: MessageHandler = (ws, data, deps) => {
	const msg = data as ClientMessage & { type: "config:save" };
	const { errors, warnings } = deps.configStore.save(msg.config);
	if (errors.length > 0) {
		deps.sendTo(ws, { type: "config:error", errors });
		return;
	}
	const config = deps.configStore.get();
	const response: ServerMessage = {
		type: "config:state",
		config,
		...(warnings.length > 0 ? { warnings } : {}),
	};
	deps.broadcast(response);

	// Auto-mode just turned on: drain all pending questions
	if (msg.config.autoMode === true) {
		for (const [, orch] of deps.orchestrators) {
			const wf = orch.getEngine().getWorkflow();
			if (wf?.pendingQuestion && wf.status === "waiting_for_input") {
				orch.skipQuestion(wf.id, wf.pendingQuestion.id);
			}
		}
	}
};

export const handleConfigReset: MessageHandler = (_ws, data, deps) => {
	const msg = data as ClientMessage & { type: "config:reset" };
	deps.configStore.reset(msg.key);
	deps.broadcast({ type: "config:state", config: deps.configStore.get() });
};
