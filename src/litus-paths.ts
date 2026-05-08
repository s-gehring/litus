/**
 * Central source of truth for every path under `~/.litus`.
 *
 * Resolution order for `litusHome()` (recomputed on every call — no cache):
 *  1. The most-recent value passed to `setLitusHome()` (cleared by `clearLitusHome()`).
 *  2. `process.env.LITUS_HOME` if set and non-empty after trimming, with leading
 *     `~` / `~/` expanded against `os.homedir()` and relative paths resolved
 *     against `process.cwd()`.
 *  3. `<os.homedir()>/.litus`.
 *
 * Each named accessor returns one absolute path; no I/O, no env reads beyond
 * `LITUS_HOME`, no logging, no throws. Suffixes (relative to `litusHome()`):
 *
 *  | accessor                    | suffix                       |
 *  |-----------------------------|------------------------------|
 *  | `workflowsDir()`            | `workflows`                  |
 *  | `epicsFile()`               | `workflows/epics.json`       |
 *  | `auditDir()`                | `audit` (also used by `cli-runner.ts` for `events.jsonl`) |
 *  | `alertsDir()`               | `alerts`                     |
 *  | `configFile()`              | `config.json`                |
 *  | `defaultModelCacheFile()`   | `default-model.json`         |
 *  | `reposDir()`                | `repos`                      |
 *  | `artifactsDir(workflowId)`  | `artifacts/<workflowId>`     |
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

let override: string | undefined;

function expandTilde(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) {
		return join(homedir(), value.slice(2));
	}
	return value;
}

function resolveFromEnv(value: string): string {
	const expanded = expandTilde(value);
	return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export function litusHome(): string {
	if (override !== undefined) return override;
	const env = process.env.LITUS_HOME;
	if (env !== undefined) {
		const trimmed = env.trim();
		if (trimmed.length > 0) return resolveFromEnv(trimmed);
	}
	return join(homedir(), ".litus");
}

/**
 * Set the in-process override that wins over `LITUS_HOME` and the home default.
 *
 * Note: unlike the env-var path, this setter does NOT expand a leading `~`.
 * `setLitusHome("~/foo")` stores `<cwd>/~/foo`, since the setter is intended
 * for tests that pass an already-resolved temp dir (e.g. `mkdtempSync` output).
 */
export function setLitusHome(absoluteOrRelativePath: string): void {
	override = resolve(absoluteOrRelativePath);
}

export function clearLitusHome(): void {
	override = undefined;
}

export function workflowsDir(): string {
	return join(litusHome(), "workflows");
}

export function epicsFile(): string {
	return join(litusHome(), "workflows", "epics.json");
}

export function auditDir(): string {
	return join(litusHome(), "audit");
}

export function alertsDir(): string {
	return join(litusHome(), "alerts");
}

export function configFile(): string {
	return join(litusHome(), "config.json");
}

export function telegramQuestionsFile(): string {
	return join(litusHome(), "telegram-questions.json");
}

export function defaultModelCacheFile(): string {
	return join(litusHome(), "default-model.json");
}

export function reposDir(): string {
	return join(litusHome(), "repos");
}

export function artifactsDir(workflowId: string): string {
	return join(litusHome(), "artifacts", workflowId);
}
