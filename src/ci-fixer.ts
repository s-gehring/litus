import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configStore } from "./config-store";
import { gitSpawn } from "./git-logger";
import { logger } from "./logger";
import { extractRepoFromUrl } from "./pr-merger";
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

export async function gatherAllFailureLogs(
	prUrl: string,
	failedChecks: CiCheckResult[],
): Promise<CiFailureLog[]> {
	const repo = extractRepoFromUrl(prUrl);
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

const CI_FIX_PROMPT_DIR = join(tmpdir(), "litus-ci-fix-prompts");

function writeFailureLogFile(failureLogs: CiFailureLog[]): string {
	const body = failureLogs
		.map((log) => `### ${log.checkName} (run ${log.runId})\n\`\`\`\n${log.logs}\n\`\`\``)
		.join("\n\n");

	mkdirSync(CI_FIX_PROMPT_DIR, { recursive: true });
	const fileName = `ci-fix-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`;
	const filePath = join(CI_FIX_PROMPT_DIR, fileName);
	writeFileSync(filePath, body, "utf8");
	logger.info(`[ci-fixer] Wrote CI failure logs to ${filePath} (${body.length} chars)`);
	return filePath;
}

export function buildFixPrompt(prUrl: string, failureLogs: CiFailureLog[]): string {
	const promptTemplate = configStore.get().prompts.ciFixInstruction;
	const repo = extractRepoFromUrl(prUrl) ?? "<unknown-repo>";

	let logSections: string;
	if (failureLogs.length === 0) {
		logSections =
			"No failure logs were captured for this cycle. Inspect the PR checks directly (e.g. `gh pr checks " +
			`${prUrl}\`) to determine what failed before attempting a fix.`;
	} else {
		const filePath = writeFailureLogFile(failureLogs);
		const sources = failureLogs
			.map(
				(log) =>
					`- ${log.checkName} (run ${log.runId}) — fetched via \`gh run view ${log.runId} --log-failed --repo ${repo}\``,
			)
			.join("\n");

		logSections = `The full CI failure logs are too large to embed inline and have been written to a temp file on this machine:

${filePath}

Read that file first — it contains one fenced \`\`\` block per failing check with the complete output of \`gh run view <run-id> --log-failed\` for PR ${prUrl}.

Log sources (one section per run in the file):
${sources}`;
	}

	return promptTemplate.replaceAll("${prUrl}", prUrl).replaceAll("${logSections}", logSections);
}
