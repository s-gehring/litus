import { existsSync, statSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const IS_WINDOWS = process.platform === "win32";
const GIT_CANDIDATES = IS_WINDOWS ? ["git.exe", "git.cmd", "git"] : ["git"];

export function fakesDir(): string {
	return resolve(HERE, "..", "fakes");
}

export function buildPathWithFakes(existingPath: string | undefined): string {
	const fakes = fakesDir();
	const parts = (existingPath ?? "").split(delimiter).filter(Boolean);
	const deduped = parts.filter((p) => resolve(p) !== fakes);
	return [fakes, ...deduped].join(delimiter);
}

/**
 * Discover the first real `git` binary on the inherited PATH, skipping any
 * entry that resolves inside the fakes dir. Returns an absolute path.
 *
 * Used by the harness to populate `LITUS_E2E_REAL_GIT` in the spawned
 * server's env so the `git` fake can pass through unscripted subcommands
 * (and run `remote set-url` inside the `clone.useTemplate` side-effect
 * sequence) without recursing through itself.
 *
 * Throws if no real git is found — tests that depend on pass-through would
 * hang otherwise.
 */
export function discoverRealGit(existingPath: string | undefined): string {
	const fakes = fakesDir();
	const parts = (existingPath ?? "").split(delimiter).filter(Boolean);
	for (const part of parts) {
		const abs = resolve(part);
		if (abs === fakes) continue;
		for (const candidate of GIT_CANDIDATES) {
			const full = resolve(abs, candidate);
			if (existsSync(full)) {
				try {
					if (statSync(full).isFile()) return full;
				} catch {
					// ignore
				}
			}
		}
	}
	throw new Error(
		"[litus-e2e] no real git binary found on PATH outside the fakes dir — required for e2e",
	);
}
