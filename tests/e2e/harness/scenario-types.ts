export interface StreamJsonEvent {
	type: string;
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
 * Entries may provide both to be tolerant of either caller; the fake
 * picks based on `--output-format` at invocation time.
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
}

export interface ScenarioScript {
	name: string;
	claude: ClaudeInvocationScript[];
	gh: Record<string, GhResponse | GhResponse[]>;
}
