import { configStore } from "./config-store";
import { toErrorMessage } from "./errors";
import { gitSpawn } from "./git-logger";
import type { CiCheckResult, CiCycle } from "./types";

export async function checkGhAuth(): Promise<void> {
	const result = await gitSpawn(["gh", "auth", "status"]);
	if (result.code !== 0) {
		throw new Error(`gh CLI not authenticated: ${result.stderr || "run 'gh auth login' first"}`);
	}
}

export function parseCiChecks(jsonOutput: string): CiCheckResult[] {
	const parsed = JSON.parse(jsonOutput);
	if (!Array.isArray(parsed)) return [];
	return parsed.map((item: Record<string, unknown>) => ({
		name: String(item.name ?? ""),
		state: String(item.state ?? ""),
		bucket: String(item.bucket ?? "pending"),
		link: String(item.link ?? ""),
	}));
}

export function allChecksComplete(results: CiCheckResult[]): boolean {
	return results.every((r) => r.bucket !== "pending");
}

/** Returns `true` when all non-SUCCESS checks were cancelled (likely billing/usage-limit). */
export function allFailuresCancelled(results: CiCheckResult[]): boolean {
	const failed = results.filter((r) => r.bucket !== "pass");
	return failed.length > 0 && failed.every((r) => r.bucket === "cancel");
}

/** Must only be called after `allChecksComplete(results)` returns `true`. */
export function allChecksPassed(results: CiCheckResult[]): boolean {
	return results.length === 0 || results.every((r) => r.bucket === "pass");
}

export async function pollCiChecks(prUrl: string): Promise<CiCheckResult[]> {
	const result = await gitSpawn(["gh", "pr", "checks", prUrl, "--json", "name,state,bucket,link"], {
		extra: { pr: prUrl },
	});

	if (result.code !== 0) {
		// gh returns non-zero when no checks exist — treat as empty
		if (
			result.stderr.includes("no checks") ||
			result.stderr.includes("no commit") ||
			result.stdout === "[]"
		) {
			return [];
		}
		throw new Error(result.stderr || `gh pr checks failed with code ${result.code}`);
	}

	return parseCiChecks(result.stdout);
}

export interface MonitorResult {
	passed: boolean;
	timedOut: boolean;
	results: CiCheckResult[];
}

const PR_URL_REGEX = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

export function isValidPrUrl(url: string): boolean {
	return PR_URL_REGEX.test(url);
}

export async function startMonitoring(
	prUrl: string,
	ciCycle: CiCycle,
	onOutput: (msg: string) => void,
	signal?: AbortSignal,
): Promise<MonitorResult> {
	if (!isValidPrUrl(prUrl)) {
		throw new Error(`Invalid PR URL: ${prUrl}`);
	}

	await checkGhAuth();

	const startedAt = ciCycle.monitorStartedAt
		? new Date(ciCycle.monitorStartedAt).getTime()
		: Date.now();
	let pollCount = 0;
	const pollInterval = configStore.get().timing.ciPollIntervalMs;
	const maxPolls = Math.ceil(ciCycle.globalTimeoutMs / pollInterval);

	while (!signal?.aborted) {
		if (Date.now() - startedAt > ciCycle.globalTimeoutMs) {
			const lastResults = ciCycle.lastCheckResults;
			onOutput(
				`[poll ${pollCount}/${maxPolls}] Global timeout reached (${ciCycle.globalTimeoutMs / 60_000}min)`,
			);
			return { passed: false, timedOut: true, results: lastResults };
		}

		pollCount++;
		try {
			const results = await pollCiChecks(prUrl);
			ciCycle.lastCheckResults = results;

			const statusLine = results.map((r) => `${r.name}: ${r.state} (${r.bucket})`).join(" | ");
			onOutput(`[poll ${pollCount}/${maxPolls}] ${statusLine || "No checks found"}`);

			if (results.length === 0) {
				onOutput(`[poll ${pollCount}/${maxPolls}] No checks registered — treating as passed`);
				return { passed: true, timedOut: false, results };
			}

			if (allChecksComplete(results)) {
				if (allChecksPassed(results)) {
					onOutput(`[poll ${pollCount}/${maxPolls}] All ${results.length} checks passed`);
					return { passed: true, timedOut: false, results };
				}
				const failed = results.filter((r) => r.bucket !== "pass");
				onOutput(
					`[poll ${pollCount}/${maxPolls}] ${failed.length} check(s) failed: ${failed.map((r) => r.name).join(", ")}`,
				);
				return { passed: false, timedOut: false, results };
			}
		} catch (err) {
			const msg = toErrorMessage(err);
			if (msg.includes("rate limit")) {
				const backoff = configStore.get().timing.rateLimitBackoffMs;
				onOutput(`[poll ${pollCount}/${maxPolls}] Rate limited — waiting ${backoff / 1000}s`);
				await Bun.sleep(backoff);
				continue;
			}
			const interval = configStore.get().timing.ciPollIntervalMs;
			onOutput(
				`[poll ${pollCount}/${maxPolls}] Poll error: ${msg} — retrying in ${interval / 1000}s`,
			);
		}

		await Bun.sleep(configStore.get().timing.ciPollIntervalMs);
	}

	return { passed: false, timedOut: false, results: ciCycle.lastCheckResults };
}
