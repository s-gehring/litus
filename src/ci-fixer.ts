import { configStore } from "./config-store";
import { gitSpawn } from "./git-logger";
import type { CiCheckResult, CiFailureLog } from "./types";

const RUN_ID_REGEX = /\/runs\/(\d+)\//;

export function extractRunIds(
	failedChecks: CiCheckResult[],
): { checkName: string; runId: string }[] {
	const seen = new Set<string>();
	const results: { checkName: string; runId: string }[] = [];

	for (const check of failedChecks) {
		const match = check.link.match(RUN_ID_REGEX);
		if (match && !seen.has(match[1])) {
			seen.add(match[1]);
			results.push({ checkName: check.name, runId: match[1] });
		}
	}
	return results;
}

export async function fetchFailureLogs(
	runId: string,
	repo: string,
	checkName: string,
): Promise<CiFailureLog> {
	const result = await gitSpawn(["gh", "run", "view", runId, "--log-failed", "--repo", repo], {
		extra: { check: checkName, runId, repo },
	});

	if (result.code !== 0) {
		return {
			checkName,
			runId,
			logs: `Failed to fetch logs: ${result.stderr || `exit code ${result.code}`}`,
		};
	}

	const maxLogLength = configStore.get().timing.maxCiLogLength;
	return {
		checkName,
		runId,
		logs: result.stdout.length > maxLogLength ? result.stdout.slice(-maxLogLength) : result.stdout,
	};
}

function extractRepoFromPrUrl(prUrl: string): string {
	// https://github.com/owner/repo/pull/123
	const match = prUrl.match(/github\.com\/([^/]+\/[^/]+)\//);
	return match ? match[1] : "";
}

export async function gatherAllFailureLogs(
	prUrl: string,
	failedChecks: CiCheckResult[],
): Promise<CiFailureLog[]> {
	const repo = extractRepoFromPrUrl(prUrl);
	if (!repo) {
		throw new Error(`Could not extract repository from PR URL: ${prUrl}`);
	}

	const runEntries = extractRunIds(failedChecks);
	const logs: CiFailureLog[] = [];

	for (const entry of runEntries) {
		const log = await fetchFailureLogs(entry.runId, repo, entry.checkName);
		logs.push(log);
	}

	return logs;
}

export function buildFixPrompt(prUrl: string, failureLogs: CiFailureLog[]): string {
	const logSections = failureLogs
		.map((log) => `### ${log.checkName} (run ${log.runId})\n\`\`\`\n${log.logs}\n\`\`\``)
		.join("\n\n");

	const promptTemplate = configStore.get().prompts.ciFixInstruction;
	return promptTemplate.replaceAll("${prUrl}", prUrl).replaceAll("${logSections}", logSections);
}
