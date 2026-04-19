#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ScenarioScript } from "../harness/scenario-types";

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

function readOutputFormat(argv: string[]): string {
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--output-format") return argv[i + 1] ?? "";
		if (argv[i].startsWith("--output-format=")) return argv[i].slice("--output-format=".length);
	}
	return "text"; // matches `runClaude` default
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

	if (outputFormat === "stream-json") {
		if (!script.events) {
			die(
				`claude invocation ${idx} was called with --output-format stream-json but scenario entry has no \`events\` (argv=${JSON.stringify(argv)})`,
			);
		}
		for (const event of script.events) {
			process.stdout.write(`${JSON.stringify(event)}\n`);
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
