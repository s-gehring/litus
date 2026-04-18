#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
	const outputFormat = readOutputFormat(argv);
	const { scenario, path } = loadScenario();
	const counterFile = process.env.LITUS_E2E_COUNTER;
	if (!counterFile) die("missing env LITUS_E2E_COUNTER");
	const idx = nextIndex(counterFile as string);
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
	} else {
		// text (or anything else the server might try); emit the scripted text verbatim
		if (script.text === undefined) {
			die(
				`claude invocation ${idx} was called with --output-format ${outputFormat || "text"} but scenario entry has no \`text\` (argv=${JSON.stringify(argv)})`,
			);
		}
		process.stdout.write(script.text);
	}

	await new Promise<void>((resolve) => {
		process.stdout.write("", () => resolve());
	});

	process.exit(script.exitCode ?? 0);
}

main().catch((e) => die(`unexpected: ${(e as Error).message}`, 99));
