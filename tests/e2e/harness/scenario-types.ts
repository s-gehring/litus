export interface StreamJsonEvent {
	type: "system" | "assistant" | "user" | "result";
	[key: string]: unknown;
}

/**
 * A single scripted `claude` invocation. Branches on the `--output-format`
 * flag the server passes:
 *
 *   - When `events` is present, the fake emits each entry as one
 *     newline-delimited JSON event on stdout (stream-json mode, used by
 *     the pipeline step runner).
 *   - When `text` is present, the fake writes it verbatim to stdout
 *     (text mode, used by `QuestionDetector` and `ReviewClassifier`).
 *
 * An entry must provide exactly one of `events` or `text` (mirrors the
 * `oneOf` in `scenario-script.schema.json`). The fake dies if the invocation's
 * `--output-format` does not match the field the entry provides.
 */
export interface ClaudeInvocationScript {
	events?: StreamJsonEvent[];
	text?: string;
	exitCode?: number;
	delayMs?: number;
}

export interface GhResponse {
	exitCode: number;
	stdout?: string;
	stderr?: string;
	matchFlags?: Record<string, string>;
	delayMs?: number;
}

export interface ScenarioScript {
	name: string;
	claude: ClaudeInvocationScript[];
	gh: Record<string, GhResponse | GhResponse[]>;
}
