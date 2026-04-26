import { runClaude } from "./claude-spawn";
import { configStore } from "./config-store";
import { logger } from "./logger";
import type { AppConfig, EffortLevel } from "./types";

export interface RunConfiguredHelperOptions<T> {
	selector: (config: AppConfig) => {
		promptTemplate: string;
		model: string;
		effort: EffortLevel;
	};
	vars: Record<string, string>;
	parser: (stdout: string) => T;
	fallback: T;
	callerLabel: string;
	timeoutMs?: number;
}

export type ClaudeHelperFailureMode = "spawn" | "parse";

export async function runConfiguredHelper<T>(options: RunConfiguredHelperOptions<T>): Promise<T> {
	const warn = (err: unknown, failureMode: ClaudeHelperFailureMode): void => {
		logger.warn({ callerLabel: options.callerLabel, err, failureMode }, "claude helper failed");
	};

	let promptTemplate: string;
	let model: string;
	let effort: EffortLevel;
	try {
		const selected = options.selector(configStore.get());
		promptTemplate = selected.promptTemplate;
		model = selected.model;
		effort = selected.effort;
	} catch (err) {
		warn(err, "spawn");
		return options.fallback;
	}

	if (!promptTemplate) {
		warn(new Error("missing or empty promptTemplate"), "spawn");
		return options.fallback;
	}
	if (!model) {
		warn(new Error("missing or empty model"), "spawn");
		return options.fallback;
	}
	if (!effort) {
		warn(new Error("missing or empty effort"), "spawn");
		return options.fallback;
	}

	let prompt = promptTemplate;
	for (const [key, value] of Object.entries(options.vars)) {
		prompt = prompt.replaceAll(`\${${key}}`, value);
	}

	let result: Awaited<ReturnType<typeof runClaude>>;
	try {
		result = await runClaude({
			prompt,
			model,
			effort,
			callerLabel: options.callerLabel,
			timeoutMs: options.timeoutMs ?? 30_000,
		});
	} catch (err) {
		warn(err, "spawn");
		return options.fallback;
	}

	if (!result.ok) {
		warn(result, "spawn");
		return options.fallback;
	}

	try {
		return options.parser(result.stdout);
	} catch (err) {
		warn(err, "parse");
		return options.fallback;
	}
}
