import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Pre-purge seed shape. Consumed by the `purge-all` spec's fixture to
 * populate `$HOME/.litus/workflows/` BEFORE the server spawns — the store's
 * `loadAll` startup path then picks the records up on connect so the client
 * renders workflow cards + epics that purge can subsequently clear.
 */
export interface PurgeSeedOptions {
	workflows: number;
	epics: number;
}

function now(): string {
	return new Date().toISOString();
}

/**
 * Build a minimal workflow JSON. `WorkflowStore.load` validates:
 *   - `data.id`, `data.status`, `data.steps` (Array)
 *   - `data.currentStepIndex` within `steps.length`
 * Missing fields are backfilled by the store's migration logic on load, so
 * we only need to write the absolute minimum here.
 */
function buildSeedWorkflow(index: number): Record<string, unknown> {
	const id = `seed-wf-${index}`;
	const timestamp = now();
	return {
		id,
		workflowKind: "spec",
		specification: `Seeded workflow ${index} for purge coverage`,
		status: "completed",
		// null targetRepository + null worktreePath so the purge handler has no
		// worktree/branch to clean via real git — state wipe alone is exercised
		// in the happy path.
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
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

function buildSeedEpic(index: number): Record<string, unknown> {
	return {
		epicId: `seed-epic-${index}`,
		description: `Seeded epic ${index} for purge coverage`,
		status: "completed",
		title: `Seed Epic ${index}`,
		workflowIds: [],
		startedAt: now(),
		completedAt: now(),
		errorMessage: null,
		infeasibleNotes: null,
		analysisSummary: null,
	};
}

/**
 * Write `options.workflows` workflow records, an `index.json`, and an
 * `epics.json` containing `options.epics` epics into the sandbox's
 * `$HOME/.litus/workflows/`. Must run BEFORE the server spawns — the server
 * loads persisted state during `loadAll` at startup, which is the signal the
 * happy-path assertion relies on.
 *
 * Writes raw JSON rather than using `WorkflowStore.save` / `EpicStore.save`
 * so the Playwright worker (Node) doesn't hit Bun-only APIs like
 * `Promise.withResolvers` used by the stores.
 */
export async function seedPurgeState(homeDir: string, options: PurgeSeedOptions): Promise<void> {
	const baseDir = join(homeDir, ".litus", "workflows");
	await mkdir(baseDir, { recursive: true });

	const indexEntries: Array<Record<string, unknown>> = [];
	for (let i = 1; i <= options.workflows; i++) {
		const wf = buildSeedWorkflow(i);
		await writeFile(join(baseDir, `${wf.id}.json`), JSON.stringify(wf, null, 2), "utf8");
		indexEntries.push({
			id: wf.id,
			workflowKind: wf.workflowKind,
			status: wf.status,
			specification: wf.specification,
			summary: wf.summary,
			createdAt: wf.createdAt,
			updatedAt: wf.updatedAt,
		});
	}
	await writeFile(join(baseDir, "index.json"), JSON.stringify(indexEntries, null, 2), "utf8");

	const epics: Array<Record<string, unknown>> = [];
	for (let i = 1; i <= options.epics; i++) {
		epics.push(buildSeedEpic(i));
	}
	await writeFile(join(baseDir, "epics.json"), JSON.stringify(epics, null, 2), "utf8");
}
