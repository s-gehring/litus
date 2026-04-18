#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import type { GhResponse, ScenarioScript } from "../harness/scenario-types";

const FAKE = "gh";

function die(msg: string, code = 2): never {
	process.stderr.write(`[litus-e2e-fake:${FAKE}] ${msg}\n`);
	process.exit(code);
}

function loadScenario(): { scenario: ScenarioScript; path: string } {
	const path = process.env.LITUS_E2E_SCENARIO;
	if (!path) die("missing env LITUS_E2E_SCENARIO: (no scenario path provided)");
	if (!existsSync(path as string)) die(`scenario file not found: ${path}`);
	try {
		return { scenario: JSON.parse(readFileSync(path as string, "utf8")), path: path as string };
	} catch (e) {
		die(`scenario parse error: ${path} (${(e as Error).message})`);
	}
}

interface ParsedArgs {
	positional: string[];
	flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
	const positional: string[] = [];
	const flags: Record<string, string> = {};
	let i = 0;
	// collect leading positional (up to first flag)
	while (i < argv.length && !argv[i].startsWith("-")) {
		positional.push(argv[i]);
		i += 1;
	}
	while (i < argv.length) {
		const token = argv[i];
		if (token.startsWith("--")) {
			const eq = token.indexOf("=");
			if (eq >= 0) {
				flags[token.slice(2, eq)] = token.slice(eq + 1);
				i += 1;
			} else {
				const key = token.slice(2);
				const next = argv[i + 1];
				if (next === undefined || next.startsWith("-")) {
					flags[key] = "true";
					i += 1;
				} else {
					flags[key] = next;
					i += 2;
				}
			}
		} else if (token.startsWith("-") && token.length > 1) {
			flags[token.slice(1)] = "true";
			i += 1;
		} else {
			// trailing positional (rare for gh)
			positional.push(token);
			i += 1;
		}
	}
	return { positional, flags };
}

function normaliseKey(positional: string[]): string {
	return positional.map((p) => p.toLowerCase()).join(" ");
}

function matches(response: GhResponse, flags: Record<string, string>): boolean {
	if (!response.matchFlags) return true;
	for (const [k, v] of Object.entries(response.matchFlags)) {
		if (flags[k] !== v) return false;
	}
	return true;
}

function pickResponse(
	entry: GhResponse | GhResponse[],
	flags: Record<string, string>,
): GhResponse | null {
	const list = Array.isArray(entry) ? entry : [entry];
	// Prefer responses whose matchFlags actually match; fall back to an
	// unconstrained one.
	let fallback: GhResponse | null = null;
	for (const r of list) {
		if (r.matchFlags && Object.keys(r.matchFlags).length > 0) {
			if (matches(r, flags)) return r;
		} else if (fallback === null) {
			fallback = r;
		}
	}
	return fallback;
}

function keyPrefixes(positional: string[]): string[] {
	const keys: string[] = [];
	for (let k = positional.length; k >= 1; k--) {
		keys.push(normaliseKey(positional.slice(0, k)));
	}
	return keys;
}

function main() {
	const { scenario, path } = loadScenario();
	const argv = process.argv.slice(2);
	const parsed = parseArgs(argv);
	if (parsed.positional.length === 0) {
		die(`no subcommand provided: argv=${JSON.stringify(argv)}`);
	}

	let matched: GhResponse | null = null;
	for (const key of keyPrefixes(parsed.positional)) {
		const entry = scenario.gh[key];
		if (!entry) continue;
		const resp = pickResponse(entry, parsed.flags);
		if (resp) {
			matched = resp;
			break;
		}
	}

	if (!matched) {
		die(
			`no scripted response for key=${JSON.stringify(normaliseKey(parsed.positional))} argv=${JSON.stringify(argv)} in scenario ${path}`,
		);
	}

	if (matched.stdout) process.stdout.write(matched.stdout);
	if (matched.stderr) process.stderr.write(matched.stderr);
	process.exit(matched.exitCode);
}

main();
