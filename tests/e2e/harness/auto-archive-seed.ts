import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Pre-server seed for the auto-archive e2e: writes terminal workflow + epic
 * records with `updatedAt`/`completedAt` timestamps far in the past so that
 * the auto-archive sweep (which compares against `Date.now()` minus a
 * threshold) treats them as eligible on first run.
 *
 * Mirrors `purge-seed.ts` in shape but bypasses store APIs to avoid Bun-only
 * primitives in the Playwright Node worker.
 */
export interface AutoArchiveSeedOptions {
	/** Standalone (non-epic-child) terminal workflows to seed. */
	standaloneWorkflows: number;
	/** When set, also seed a completed epic with N child workflows. */
	epicWithChildren: number | null;
}

const OLD_TIMESTAMP = "2026-01-01T00:00:00.000Z";

function buildSeedWorkflow(
	id: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id,
		workflowKind: "spec",
		specification: `Seeded workflow ${id}`,
		status: "completed",
		targetRepository: null,
		worktreePath: null,
		worktreeBranch: "master",
		featureBranch: null,
		summary: "",
		stepSummary: "",
		flavor: "",
		pendingQuestion: null,
		lastOutput: "",
		steps: [
			{
				id: "seed",
				name: "seed",
				status: "completed",
				output: "",
				outputLog: [],
				history: [],
			},
		],
		currentStepIndex: 0,
		reviewCycle: { iteration: 0 },
		ciCycle: { attempt: 0, maxAttempts: 0 },
		mergeCycle: { attempt: 0, maxAttempts: 3 },
		prUrl: null,
		epicId: null,
		epicTitle: null,
		epicDependencies: [],
		epicDependencyStatus: null,
		epicAnalysisMs: 0,
		activeWorkMs: 0,
		activeWorkStartedAt: null,
		feedbackEntries: [],
		feedbackPreRunHead: null,
		activeInvocation: null,
		managedRepo: null,
		error: null,
		createdAt: OLD_TIMESTAMP,
		updatedAt: OLD_TIMESTAMP,
		archived: false,
		archivedAt: null,
		...overrides,
	};
}

export async function seedAutoArchiveState(
	homeDir: string,
	options: AutoArchiveSeedOptions,
): Promise<void> {
	const baseDir = join(homeDir, ".litus", "workflows");
	await mkdir(baseDir, { recursive: true });

	const indexEntries: Array<Record<string, unknown>> = [];
	const writeWorkflow = async (wf: Record<string, unknown>) => {
		await writeFile(join(baseDir, `${wf.id}.json`), JSON.stringify(wf, null, 2), "utf8");
		indexEntries.push({
			id: wf.id,
			workflowKind: wf.workflowKind,
			status: wf.status,
			specification: wf.specification,
			summary: wf.summary,
			createdAt: wf.createdAt,
			updatedAt: wf.updatedAt,
			archived: wf.archived,
			archivedAt: wf.archivedAt,
			epicId: wf.epicId,
		});
	};

	for (let i = 1; i <= options.standaloneWorkflows; i++) {
		await writeWorkflow(buildSeedWorkflow(`seed-aa-wf-${i}`));
	}

	const epics: Array<Record<string, unknown>> = [];
	if (options.epicWithChildren !== null) {
		const epicId = "seed-aa-epic-1";
		const childIds: string[] = [];
		for (let i = 1; i <= options.epicWithChildren; i++) {
			const childId = `seed-aa-epic-child-${i}`;
			childIds.push(childId);
			await writeWorkflow(
				buildSeedWorkflow(childId, {
					epicId,
					epicTitle: "Seeded auto-archive epic",
					status: "completed",
				}),
			);
		}
		epics.push({
			epicId,
			description: "Seeded epic for auto-archive coverage",
			status: "completed",
			title: "Seeded auto-archive epic",
			workflowIds: childIds,
			startedAt: OLD_TIMESTAMP,
			completedAt: OLD_TIMESTAMP,
			errorMessage: null,
			infeasibleNotes: null,
			analysisSummary: null,
			archived: false,
			archivedAt: null,
		});
	}

	await writeFile(join(baseDir, "index.json"), JSON.stringify(indexEntries, null, 2), "utf8");
	await writeFile(join(baseDir, "epics.json"), JSON.stringify(epics, null, 2), "utf8");
}
