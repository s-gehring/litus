import type { CiCheckResult, CiCycle } from "./types";

export function parseCiChecks(jsonOutput: string): CiCheckResult[] {
	const parsed = JSON.parse(jsonOutput);
	if (!Array.isArray(parsed)) return [];
	return parsed.map((item: Record<string, unknown>) => ({
		name: String(item.name ?? ""),
		state: String(item.state ?? ""),
		conclusion: item.conclusion != null ? String(item.conclusion) : null,
		link: String(item.link ?? ""),
	}));
}

export function allChecksComplete(results: CiCheckResult[]): boolean {
	return results.every((r) => r.state === "COMPLETED");
}

export function allChecksPassed(results: CiCheckResult[]): boolean {
	return results.length === 0 || results.every((r) => r.conclusion === "SUCCESS");
}

export async function pollCiChecks(prUrl: string): Promise<CiCheckResult[]> {
	const proc = Bun.spawn(["gh", "pr", "checks", prUrl, "--json", "name,state,conclusion,link"], {
		stdout: "pipe",
		stderr: "pipe",
	});

	const code = await proc.exited;
	const stdout = await new Response(proc.stdout as ReadableStream).text();
	const stderr = await new Response(proc.stderr as ReadableStream).text();

	if (code !== 0) {
		throw new Error(stderr.trim() || `gh pr checks failed with code ${code}`);
	}

	return parseCiChecks(stdout);
}

export interface MonitorResult {
	passed: boolean;
	timedOut: boolean;
	results: CiCheckResult[];
}

export async function startMonitoring(
	prUrl: string,
	ciCycle: CiCycle,
	onOutput: (msg: string) => void,
	signal?: AbortSignal,
): Promise<MonitorResult> {
	const startedAt = ciCycle.monitorStartedAt
		? new Date(ciCycle.monitorStartedAt).getTime()
		: Date.now();
	let pollCount = 0;
	const maxPolls = Math.ceil(ciCycle.globalTimeoutMs / 15_000);

	while (!signal?.aborted) {
		if (Date.now() - startedAt > ciCycle.globalTimeoutMs) {
			const lastResults = ciCycle.lastCheckResults;
			onOutput(`[poll ${pollCount}/${maxPolls}] Global timeout reached (${ciCycle.globalTimeoutMs / 60_000}min)`);
			return { passed: false, timedOut: true, results: lastResults };
		}

		pollCount++;
		try {
			const results = await pollCiChecks(prUrl);
			ciCycle.lastCheckResults = results;

			const statusLine = results
				.map((r) => `${r.name}: ${r.state}${r.conclusion ? ` (${r.conclusion})` : ""}`)
				.join(" | ");
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
				const failed = results.filter((r) => r.conclusion !== "SUCCESS");
				onOutput(
					`[poll ${pollCount}/${maxPolls}] ${failed.length} check(s) failed: ${failed.map((r) => r.name).join(", ")}`,
				);
				return { passed: false, timedOut: false, results };
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("rate limit")) {
				onOutput(`[poll ${pollCount}/${maxPolls}] Rate limited — waiting 60s`);
				await Bun.sleep(60_000);
				continue;
			}
			onOutput(`[poll ${pollCount}/${maxPolls}] Poll error: ${msg} — retrying in 15s`);
		}

		await Bun.sleep(15_000);
	}

	return { passed: false, timedOut: false, results: ciCycle.lastCheckResults };
}
