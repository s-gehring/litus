#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ScenarioFile, ScenarioScript } from "../harness/scenario-types";

const FAKE = "claude";

function die(msg: string, code = 2): never {
	process.stderr.write(`[litus-e2e-fake:${FAKE}] ${msg}\n`);
	process.exit(code);
}

function loadScenario(): { scenario: ScenarioScript; path: string } {
	const path = process.env.LITUS_E2E_SCENARIO;
	if (!path) die("missing env LITUS_E2E_SCENARIO: (no scenario path provided)");
	if (!existsSync(path as string)) die(`scenario file not found: ${path}`);
	let scenario: ScenarioScript;
	try {
		scenario = JSON.parse(readFileSync(path as string, "utf8"));
	} catch (e) {
		die(`scenario parse error: ${path} (${(e as Error).message})`);
	}
	return { scenario, path: path as string };
}

function nextIndex(counterFile: string): number {
	let counter: Record<string, number> = {};
	if (existsSync(counterFile)) {
		try {
			counter = JSON.parse(readFileSync(counterFile, "utf8"));
		} catch {
			counter = {};
		}
	}
	const next = counter.claude ?? 0;
	counter.claude = next + 1;
	writeFileSync(counterFile, JSON.stringify(counter));
	return next;
}

function nextClassifierResponse(scenario: ScenarioScript): string {
	const fallback = "nit\n";
	const cfg = scenario.classifier;
	if (cfg == null) return fallback;
	if (typeof cfg === "string") return cfg;
	if (!Array.isArray(cfg) || cfg.length === 0) return fallback;

	const counterFile = process.env.LITUS_E2E_COUNTER;
	if (!counterFile) return cfg[0] ?? fallback;
	let counter: Record<string, number> = {};
	if (existsSync(counterFile)) {
		try {
			counter = JSON.parse(readFileSync(counterFile, "utf8"));
		} catch {
			counter = {};
		}
	}
	const idx = counter.classifier ?? 0;
	counter.classifier = idx + 1;
	try {
		writeFileSync(counterFile, JSON.stringify(counter));
	} catch {
		// best-effort: a failed counter write degrades to repeating the final entry
	}
	return cfg[Math.min(idx, cfg.length - 1)] ?? fallback;
}

function readOutputFormat(argv: string[]): string {
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--output-format") return argv[i + 1] ?? "";
		if (argv[i].startsWith("--output-format=")) return argv[i].slice("--output-format=".length);
	}
	return "text"; // matches `runClaude` default
}

/**
 * Resolve a scenario file path against the fake's CWD and reject any path
 * that escapes it. `..` anywhere in the path, absolute paths, and paths that
 * normalise outside CWD all fail fast. Paths that stay inside return the
 * absolute target.
 */
function resolveSafePath(cwd: string, file: ScenarioFile): string {
	if (isAbsolute(file.path)) {
		die(`refusing to write outside CWD: ${file.path}`);
	}
	const target = resolve(cwd, file.path);
	const rel = relative(cwd, target);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		die(`refusing to write outside CWD: ${file.path}`);
	}
	return target;
}

function writeScenarioFiles(files: ScenarioFile[] | undefined, idx: number): void {
	if (!files || files.length === 0) return;
	const cwd = process.cwd();
	for (const file of files) {
		const target = resolveSafePath(cwd, file);
		mkdirSync(dirname(target), { recursive: true });
		if (file.encoding === "base64") {
			// `Buffer.from(…, "base64")` never throws — it silently discards
			// invalid characters. Validate the input with a strict base64
			// character-set regex first (allow standard base64 alphabet plus
			// optional trailing `=` padding, plus any whitespace the scenario
			// author may have embedded for readability).
			const normalised = file.content.replace(/\s+/g, "");
			if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalised)) {
				die(
					`claude invocation ${idx}: invalid base64 content for ${file.path} (non-base64 characters present)`,
				);
			}
			const bytes = Buffer.from(normalised, "base64");
			writeFileSync(target, bytes);
		} else if (file.encoding === "utf8") {
			writeFileSync(target, file.content, "utf8");
		} else {
			die(
				`claude invocation ${idx}: unsupported encoding ${JSON.stringify((file as ScenarioFile).encoding)} for ${file.path}`,
			);
		}
	}
}

async function main() {
	const argv = process.argv.slice(2);

	// Short-circuit probe invocations (e.g. setup checker's `claude --version`)
	// without consuming a scenario slot. These are not part of the scripted
	// pipeline sequence and must not advance the FIFO counter.
	if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
		process.stdout.write("1.0.0 (litus-e2e-fake)\n");
		process.exit(0);
	}
	if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
		process.stdout.write("litus-e2e-fake claude\n");
		process.exit(0);
	}

	// Short-circuit the default-model detection probe. The server runs
	// `claude -p "Respond with ONLY a single JSON object..."` at startup to
	// identify which Claude model is currently active. This is a side-channel
	// call, not part of the scripted pipeline sequence, and must not consume
	// a scenario slot.
	const pIdx = argv.indexOf("-p");
	const promptArg = pIdx >= 0 ? (argv[pIdx + 1] ?? "") : "";
	if (promptArg.startsWith("Respond with ONLY a single JSON object")) {
		process.stdout.write(
			`${JSON.stringify({ modelId: "claude-e2e-fake", displayName: "E2E Fake" })}\n`,
		);
		process.exit(0);
	}

	const outputFormat = readOutputFormat(argv);
	const { scenario, path } = loadScenario();

	// Short-circuit the review-classifier side-channel call. Like the model
	// detection probe above, this is not part of the scripted pipeline
	// sequence and must not consume a FIFO slot — concurrent workflows would
	// otherwise interleave classifier calls into the FIFO non-deterministically.
	if (outputFormat === "text" && promptArg.startsWith("Classify the highest severity")) {
		process.stdout.write(nextClassifierResponse(scenario));
		process.exit(0);
	}

	// Short-circuit the artifacts step. The step's prompt is dynamic (embeds a
	// per-workflow output directory), so rather than forcing every scenario to
	// carry a slot for it, the fake auto-handles it: parse the output dir out
	// of the prompt, write an empty manifest there, and emit a minimal
	// stream-json sequence so the orchestrator advances with outcome=empty.
	if (promptArg.includes('"Generating Artifacts" step')) {
		const match = promptArg.match(/(\S+)\/manifest\.json/);
		if (!match) die("artifacts prompt missing manifest path");
		const outputDir = match[1];
		mkdirSync(outputDir, { recursive: true });
		const override = scenario.artifactsOverride;
		const manifest = override?.manifest ?? { version: 1, artifacts: [] };
		writeFileSync(resolve(outputDir, "manifest.json"), JSON.stringify(manifest));
		if (override?.files) {
			for (const file of override.files) {
				const target = resolveSafePath(outputDir, file);
				mkdirSync(dirname(target), { recursive: true });
				if (file.encoding === "utf8") writeFileSync(target, file.content, "utf8");
				else if (file.encoding === "base64") {
					const normalised = file.content.replace(/\s+/g, "");
					if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalised)) {
						die(`artifactsOverride: invalid base64 content for ${file.path}`);
					}
					writeFileSync(target, Buffer.from(normalised, "base64"));
				}
			}
		}
		if (override?.delayMs && override.delayMs > 0) {
			await new Promise((r) => setTimeout(r, override.delayMs));
		}
		if (outputFormat === "stream-json") {
			const events = [
				{ type: "system", subtype: "init", session_id: "sess-artifacts" },
				{
					type: "result",
					subtype: "success",
					session_id: "sess-artifacts",
					result: "No artifacts to collect.",
				},
			];
			for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
		} else {
			process.stdout.write("No artifacts to collect.\n");
		}
		await new Promise<void>((resolveFlush) => {
			process.stdout.write("", () => resolveFlush());
		});
		process.exit(override?.exitCode ?? 0);
	}

	const counterFile = process.env.LITUS_E2E_COUNTER;
	if (!counterFile) die("missing env LITUS_E2E_COUNTER");
	const idx = nextIndex(counterFile as string);

	// Record scripted invocations (argv + output format) so tests can assert
	// on resume-call payloads etc. Probe invocations short-circuit above and
	// are not captured. One JSON object per line, appended in FIFO order.
	try {
		appendFileSync(
			`${counterFile}.argv.jsonl`,
			`${JSON.stringify({ index: idx, outputFormat, argv })}\n`,
		);
	} catch {
		// best-effort: never fail a scenario because capture IO hiccupped
	}
	const script = scenario.claude[idx];
	if (!script) {
		die(
			`claude invocation ${idx} has no scripted response in scenario ${path} (argv=${JSON.stringify(argv)})`,
		);
	}

	if (script.delayMs && script.delayMs > 0) {
		await new Promise((r) => setTimeout(r, script.delayMs));
	}

	// Materialise scripted files into the worktree BEFORE emitting output, so
	// the server's artifact snapshotter — which runs after step completion —
	// picks them up as real workflow outputs.
	writeScenarioFiles(script.files, idx);

	// Scripted commit: some steps (notably `fix-implement`) classify success by
	// HEAD divergence before/after the claude invocation. Without a real commit
	// from the fake, those steps would see an empty diff and fail. When a
	// scenario entry sets `commit`, stage everything in CWD and create one
	// commit with the given message.
	if (script.commit) {
		const env = {
			...process.env,
			GIT_AUTHOR_NAME: "Litus E2E",
			GIT_AUTHOR_EMAIL: "e2e@litus.local",
			GIT_COMMITTER_NAME: "Litus E2E",
			GIT_COMMITTER_EMAIL: "e2e@litus.local",
		};
		const add = spawnSync("git", ["add", "-A"], { cwd: process.cwd(), env });
		if (add.status !== 0) {
			die(
				`claude invocation ${idx}: scripted \`git add -A\` failed (${add.status}): ${add.stderr?.toString() ?? ""}`,
			);
		}
		const commit = spawnSync("git", ["commit", "-m", script.commit.message, "--allow-empty"], {
			cwd: process.cwd(),
			env,
		});
		if (commit.status !== 0) {
			die(
				`claude invocation ${idx}: scripted \`git commit\` failed (${commit.status}): ${commit.stderr?.toString() ?? ""}`,
			);
		}
	}

	if (outputFormat === "stream-json") {
		if (!script.events) {
			die(
				`claude invocation ${idx} was called with --output-format stream-json but scenario entry has no \`events\` (argv=${JSON.stringify(argv)})`,
			);
		}
		// Per-event delay (`delayMs`, optional, ms): emits the event, then waits
		// before the next. Lets a scenario set up a "running" window where the
		// session_id has already been captured (init fired) but the step has
		// not yet completed — required for paused-with-sessionId E2Es. Capped
		// at MAX_EVENT_DELAY_MS so a stray scenario can't blow the e2e budget.
		const MAX_EVENT_DELAY_MS = 5000;
		for (const event of script.events) {
			const rawDelay = (event as { delayMs?: number }).delayMs;
			process.stdout.write(`${JSON.stringify(event)}\n`);
			if (typeof rawDelay === "number" && rawDelay > 0) {
				await new Promise((r) => setTimeout(r, Math.min(rawDelay, MAX_EVENT_DELAY_MS)));
			}
		}
	} else if (outputFormat === "text") {
		if (script.text === undefined) {
			die(
				`claude invocation ${idx} was called with --output-format text but scenario entry has no \`text\` (argv=${JSON.stringify(argv)})`,
			);
		}
		process.stdout.write(script.text);
	} else {
		die(
			`claude invocation ${idx} called with unsupported --output-format: ${JSON.stringify(outputFormat)} (argv=${JSON.stringify(argv)})`,
		);
	}

	// Flush buffered stdout before process.exit — otherwise piped output may be
	// truncated and the server observes a short read.
	await new Promise<void>((resolve) => {
		process.stdout.write("", () => resolve());
	});

	process.exit(script.exitCode ?? 0);
}

main().catch((e) => die(`unexpected: ${(e as Error).message}`, 99));
