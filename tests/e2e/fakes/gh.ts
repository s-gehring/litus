#!/usr/bin/env bun
/**
 * Fake `gh` CLI used by the E2E harness.
 *
 * Response-selection semantics (subtle — read before changing):
 *   - `scenario.gh[key]` may be a single `GhResponse` or an array of them.
 *   - When it's an array, entries with `matchFlags` are tried match-first
 *     (the first whose `matchFlags` fully match the invocation's flags wins).
 *   - When no match is found, we fall back to advancing a PER-SUBCOMMAND FIFO
 *     counter (persisted in a sidecar file alongside `LITUS_E2E_COUNTER`).
 *     Consecutive calls to the same subcommand key without `matchFlags`
 *     consume successive array entries; once exhausted, the LAST entry
 *     repeats indefinitely. This gives scenarios deterministic, readable
 *     control over state transitions (e.g. `pr view` flipping from OPEN to
 *     MERGED after the first poll).
 *   - A single-object entry (not an array) always returns that object, and
 *     never advances the per-subcommand counter.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

function ghCounterFile(): string | null {
	const base = process.env.LITUS_E2E_COUNTER;
	if (!base) return null;
	return `${base}.gh.json`;
}

function readGhCounters(): Record<string, number> {
	const file = ghCounterFile();
	if (!file || !existsSync(file)) return {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

function writeGhCounters(counters: Record<string, number>): void {
	const file = ghCounterFile();
	if (!file) return;
	try {
		writeFileSync(file, JSON.stringify(counters));
	} catch {
		// best-effort
	}
}

function pickResponse(
	entry: GhResponse | GhResponse[],
	flags: Record<string, string>,
	key: string,
): GhResponse | null {
	// Single-object entry: return as-is, never advance any counter.
	if (!Array.isArray(entry)) return entry;

	// Match-first: a response with matchFlags that fully match takes
	// precedence and does NOT consume a FIFO slot (matchFlags selection is
	// content-addressed, not order-sensitive).
	for (const r of entry) {
		if (r.matchFlags && Object.keys(r.matchFlags).length > 0 && matches(r, flags)) {
			return r;
		}
	}

	// Otherwise, FIFO across unconstrained entries, with last-entry-repeats.
	const unconstrained = entry.filter(
		(r) => !r.matchFlags || Object.keys(r.matchFlags).length === 0,
	);
	if (unconstrained.length === 0) return null;

	const counters = readGhCounters();
	const idx = counters[key] ?? 0;
	const picked = unconstrained[Math.min(idx, unconstrained.length - 1)] ?? null;
	counters[key] = idx + 1;
	writeGhCounters(counters);
	return picked;
}

function keyPrefixes(positional: string[]): string[] {
	const keys: string[] = [];
	for (let k = positional.length; k >= 1; k--) {
		keys.push(normaliseKey(positional.slice(0, k)));
	}
	return keys;
}

async function main() {
	const argv = process.argv.slice(2);

	// Short-circuit probe invocations (e.g. setup checker's `gh --version`)
	// so they don't go through subcommand lookup.
	if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
		process.stdout.write("gh version 2.60.0 (litus-e2e-fake)\n");
		process.exit(0);
	}

	const { scenario, path } = loadScenario();
	const parsed = parseArgs(argv);
	if (parsed.positional.length === 0) {
		die(`no subcommand provided: argv=${JSON.stringify(argv)}`);
	}

	let matched: GhResponse | null = null;
	for (const key of keyPrefixes(parsed.positional)) {
		const entry = scenario.gh[key];
		if (!entry) continue;
		const resp = pickResponse(entry, parsed.flags, key);
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

	if (matched.delayMs && matched.delayMs > 0) {
		await new Promise((r) => setTimeout(r, matched.delayMs));
	}

	if (matched.stdout) process.stdout.write(matched.stdout);
	if (matched.stderr) process.stderr.write(matched.stderr);
	process.exit(matched.exitCode);
}

main().catch((e) => die(`unexpected: ${(e as Error).message}`, 99));
