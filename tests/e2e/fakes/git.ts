#!/usr/bin/env bun
/**
 * Fake `git` CLI used by the E2E harness.
 *
 * Behaviour:
 *   - `scenario.git[key]` looked up by normalised subcommand (lowercased,
 *     space-joined positionals, gh-style key-prefix fallback).
 *   - Keys present in the map are scripted; keys ABSENT pass through to the
 *     real git at `$LITUS_E2E_REAL_GIT` (the fake execs the real binary with
 *     the original argv).
 *   - When a scripted response is a `GitResponse[]`, selection mirrors
 *     `gh.ts`: first `matchArg`-matching entry wins; otherwise FIFO across
 *     unconstrained entries, with last-entry-repeats. `matchArg` keys are
 *     0-based indices over the positional args AFTER the subcommand.
 *   - `clone.useTemplate`: when set, recursively copies
 *     `$LITUS_E2E_CLONE_TEMPLATE` to the scripted clone's destination, then
 *     calls `$LITUS_E2E_REAL_GIT -C <dest> remote set-url origin <url>` so
 *     downstream `git fetch origin …` still resolves locally.
 *   - Pass-through uses an absolute `$LITUS_E2E_REAL_GIT` path, so recursive
 *     invocations from real-git subprocesses re-enter the fake via PATH but
 *     the fake's own pass-through always resolves the real binary directly —
 *     no infinite loop.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { GitResponse, ScenarioScript } from "../harness/scenario-types";

const FAKE = "git";

function die(msg: string, code = 2): never {
	process.stderr.write(`[litus-e2e-fake:${FAKE}] ${msg}\n`);
	process.exit(code);
}

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) die(`missing env ${name}`);
	return v as string;
}

function loadScenario(): { scenario: ScenarioScript; path: string } {
	const path = requireEnv("LITUS_E2E_SCENARIO");
	if (!existsSync(path)) die(`scenario file not found: ${path}`);
	try {
		return { scenario: JSON.parse(readFileSync(path, "utf8")), path };
	} catch (e) {
		die(`scenario parse error: ${path} (${(e as Error).message})`);
	}
}

interface Parsed {
	/** Positionals in order (including the subcommand at index 0). */
	positional: string[];
	/** Raw argv (preserved for pass-through). */
	argv: string[];
}

function parseArgs(argv: string[]): Parsed {
	const positional: string[] = [];
	let i = 0;
	// git accepts many pre-subcommand flags like `-C <dir>`, `-c k=v`, `--git-dir=…`.
	// We only need the subcommand + its positionals for scripted lookup; skip flags.
	while (i < argv.length) {
		const token = argv[i];
		if (token === "-C" || token === "-c" || token === "--exec-path" || token === "--git-dir") {
			// Skip flag and its value
			i += 2;
			continue;
		}
		if (token.startsWith("-")) {
			i += 1;
			continue;
		}
		positional.push(token);
		i += 1;
	}
	return { positional, argv };
}

function normaliseKey(positional: string[]): string {
	return positional.map((p) => p.toLowerCase()).join(" ");
}

function keyPrefixes(positional: string[]): string[] {
	const keys: string[] = [];
	for (let k = positional.length; k >= 1; k--) {
		keys.push(normaliseKey(positional.slice(0, k)));
	}
	return keys;
}

function counterFile(): string | null {
	const base = process.env.LITUS_E2E_COUNTER;
	if (!base) return null;
	return `${base}.git.json`;
}

function readCounters(): Record<string, number> {
	const f = counterFile();
	if (!f || !existsSync(f)) return {};
	try {
		const parsed = JSON.parse(readFileSync(f, "utf8"));
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}

function writeCounters(counters: Record<string, number>): void {
	const f = counterFile();
	if (!f) return;
	try {
		writeFileSync(f, JSON.stringify(counters));
	} catch {
		// best-effort
	}
}

function matchesArg(response: GitResponse, positionalAfterSubcmd: string[]): boolean {
	if (!response.matchArg) return true;
	for (const [k, v] of Object.entries(response.matchArg)) {
		const idx = Number(k);
		if (positionalAfterSubcmd[idx] !== v) return false;
	}
	return true;
}

function pickResponse(
	entry: GitResponse | GitResponse[],
	positionalAfterSubcmd: string[],
	key: string,
): GitResponse | null {
	if (!Array.isArray(entry)) return entry;

	for (const r of entry) {
		if (r.matchArg && Object.keys(r.matchArg).length > 0 && matchesArg(r, positionalAfterSubcmd)) {
			return r;
		}
	}

	const unconstrained = entry.filter((r) => !r.matchArg || Object.keys(r.matchArg).length === 0);
	if (unconstrained.length === 0) return null;

	const counters = readCounters();
	const idx = counters[key] ?? 0;
	const picked = unconstrained[Math.min(idx, unconstrained.length - 1)] ?? null;
	counters[key] = idx + 1;
	writeCounters(counters);
	return picked;
}

function passThrough(argv: string[]): void {
	const realGit = process.env.LITUS_E2E_REAL_GIT;
	if (!realGit) die("pass-through requested but LITUS_E2E_REAL_GIT unset");
	if (!isAbsolute(realGit)) die(`LITUS_E2E_REAL_GIT must be absolute, got ${realGit}`);
	const child = spawn(realGit, argv, { stdio: "inherit" });
	// Process exits via the child's exit handler; callers return immediately
	// after this call so bun doesn't exit before the child completes.
	child.on("exit", (code, signal) => {
		if (signal) {
			process.kill(process.pid, signal);
		} else {
			process.exit(code ?? 0);
		}
	});
	child.on("error", (err) => {
		die(`pass-through spawn error: ${err.message}`);
	});
}

function isNonEmptyDir(path: string): boolean {
	try {
		const entries = readdirSync(path);
		return entries.length > 0;
	} catch {
		return false;
	}
}

async function handleCloneTemplate(
	response: GitResponse,
	positionalAfterSubcmd: string[],
): Promise<void> {
	if (response.exitCode !== 0) {
		die(`inconsistent response: exitCode=${response.exitCode} with clone.useTemplate=true`);
	}
	if (positionalAfterSubcmd.length < 2) {
		die(
			`clone: expected 'clone <url> <dest>', got positional=${JSON.stringify(positionalAfterSubcmd)}`,
		);
	}
	const url = positionalAfterSubcmd[0];
	const destRaw = positionalAfterSubcmd[1];
	const dest = isAbsolute(destRaw) ? destRaw : resolve(process.cwd(), destRaw);
	if (existsSync(dest) && isNonEmptyDir(dest)) {
		process.stderr.write(
			`fatal: destination path '${dest}' already exists and is not an empty directory.\n`,
		);
		process.exit(128);
	}
	const template = requireEnv("LITUS_E2E_CLONE_TEMPLATE");
	if (!existsSync(template)) die(`LITUS_E2E_CLONE_TEMPLATE does not exist: ${template}`);
	try {
		cpSync(template, dest, { recursive: true, dereference: true });
	} catch (e) {
		die(`clone: template copy failed: ${(e as Error).message}`);
	}
	const realGit = requireEnv("LITUS_E2E_REAL_GIT");
	// `remote set-url` fails if `origin` does not exist; `remote add origin`
	// fails if it does. Try set-url first and fall back to add so the fake
	// works whether or not the template was initialised with an origin.
	const setResult = spawnSync(realGit, ["-C", dest, "remote", "set-url", "origin", url], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (setResult.status !== 0) {
		const addResult = spawnSync(realGit, ["-C", dest, "remote", "add", "origin", url], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (addResult.status !== 0) {
			const stderr = addResult.stderr?.toString("utf8") ?? "";
			die(`clone: origin rewrite failed: ${stderr}`, 128);
		}
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);

	// Short-circuit probe invocations.
	if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
		process.stdout.write("git version 2.40.1 (litus-e2e-fake)\n");
		process.exit(0);
	}

	const parsed = parseArgs(argv);
	if (parsed.positional.length === 0) {
		// No subcommand — pass through (git prints its help).
		passThrough(argv);
		return;
	}

	const { scenario, path } = loadScenario();
	if (!scenario.git) {
		passThrough(argv);
		return;
	}

	let matched: GitResponse | null = null;
	let matchedKey = "";
	let positionalAfterSubcmd: string[] = [];
	let scriptedKeyHit: { key: string; afterKey: string[] } | null = null;
	for (const key of keyPrefixes(parsed.positional)) {
		const entry = scenario.git[key];
		if (!entry) continue;
		const afterKey = parsed.positional.slice(key.split(" ").length);
		// Remember the first (longest-prefix) scripted key hit so we can die
		// loudly if no response in its array matches — mirrors gh.ts and the
		// contract's dispatch step 5. Silent pass-through in that case would
		// hide authoring mistakes and leak requests to the real network.
		if (!scriptedKeyHit) scriptedKeyHit = { key, afterKey };
		const resp = pickResponse(entry, afterKey, key);
		if (resp) {
			matched = resp;
			matchedKey = key;
			positionalAfterSubcmd = afterKey;
			break;
		}
	}

	if (!matched) {
		if (scriptedKeyHit) {
			die(`no scripted response for key="${scriptedKeyHit.key}" argv=${JSON.stringify(argv)}`);
		}
		// No scripted key at all — pass through to real git.
		passThrough(argv);
		return;
	}

	if (matched.delayMs && matched.delayMs > 0) {
		await new Promise((r) => setTimeout(r, matched.delayMs));
	}

	if (matched.clone?.useTemplate) {
		if (matchedKey !== "clone") {
			die(
				`clone.useTemplate only valid on the 'clone' key; got key=${JSON.stringify(matchedKey)} in scenario ${path}`,
			);
		}
		await handleCloneTemplate(matched, positionalAfterSubcmd);
	}

	if (matched.stdout) process.stdout.write(matched.stdout);
	if (matched.stderr) process.stderr.write(matched.stderr);
	process.exit(matched.exitCode);
}

main().catch((e) => die(`unexpected: ${(e as Error).message}`, 99));
