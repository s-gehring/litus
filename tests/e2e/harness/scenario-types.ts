export interface StreamJsonEvent {
	type: "system" | "assistant" | "user" | "result";
	[key: string]: unknown;
}

/**
 * A file the fake `claude` writes into its CWD (the active worktree) before
 * emitting any stdout. `path` is validated to stay under CWD — any `..`
 * segment or absolute path causes the fake to exit non-zero with
 * `[litus-e2e-fake:claude] refusing to write outside CWD: …`. For `base64`
 * entries, invalid base64 is a hard failure.
 */
export interface ScenarioFile {
	path: string;
	encoding: "utf8" | "base64";
	content: string;
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
 *
 * `exitCode` defaults to `0`. Any non-zero value signals a scripted step
 * failure; the pipeline step runner surfaces that as a user-visible alert,
 * which is how the alerts story drives real alert events end-to-end.
 *
 * `files` (optional) is a list of files the fake materialises into its CWD
 * before emitting output, mirroring how the real `claude` writes artifacts
 * into the worktree.
 */
export interface ClaudeInvocationScript {
	events?: StreamJsonEvent[];
	text?: string;
	exitCode?: number;
	delayMs?: number;
	files?: ScenarioFile[];
	/**
	 * When set, the fake runs `git add -A && git commit -m <message>` in its
	 * CWD after materialising `files` and before emitting output. This lets
	 * scenarios move HEAD the same way a real `claude` invocation would in
	 * steps (notably `fix-implement`) that classify success by pre/post HEAD
	 * divergence.
	 */
	commit?: { message: string };
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
	/**
	 * Canned response for the review-classifier side-channel call (server runs
	 * `claude -p "Classify the highest severity ..." --output-format text`).
	 * When set, the fake routes any matching invocation here without consuming
	 * a `claude[]` FIFO slot — this avoids order-coupling the scripted pipeline
	 * sequence to the non-deterministic timing of classifier calls during
	 * concurrent workflows. Defaults to `"nit\n"` if omitted.
	 *
	 * When an array is supplied, each classifier call consumes the next entry
	 * (bounded FIFO, last entry repeats indefinitely). Scenarios that drive a
	 * multi-iteration review loop use this to produce different severities on
	 * successive calls (e.g. `["major\n", "nit\n"]` to loop once then advance).
	 */
	classifier?: string | string[];
}
