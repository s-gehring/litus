import { TELEGRAM_TOKEN_SENTINEL } from "../config-store";
import type { AppConfig } from "../config-types";
import type { ClientMessage, ServerMessage } from "../protocol";
import type { MessageHandler } from "./handler-types";

/**
 * Replace secret fields in `config.telegram.botToken` with the masked sentinel
 * before sending the config over the wire. The plaintext token MUST NOT appear
 * in any `config:state` payload (data-model R3 / FR-004).
 */
export function maskConfigForBroadcast(config: AppConfig): AppConfig {
	const masked: AppConfig = {
		...config,
		telegram: {
			...config.telegram,
			botToken: config.telegram.botToken === "" ? "" : TELEGRAM_TOKEN_SENTINEL,
		},
	};
	return masked;
}

export const handleConfigGet: MessageHandler = (ws, _data, deps) => {
	deps.sendTo(ws, { type: "config:state", config: maskConfigForBroadcast(deps.configStore.get()) });
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
		config: maskConfigForBroadcast(config),
		...(warnings.length > 0 ? { warnings } : {}),
	};
	deps.broadcast(response);

	// Full-auto mode: drain all pending questions
	if (msg.config.autoMode === "full-auto") {
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
	deps.broadcast({
		type: "config:state",
		config: maskConfigForBroadcast(deps.configStore.get()),
	});
};
