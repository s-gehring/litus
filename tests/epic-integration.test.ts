import { afterAll, describe, expect, test } from "bun:test";
import type { Workflow } from "../src/types";
import type { EpicAnalysisResult } from "../src/types";
import { createEpicWorkflows } from "../src/workflow-engine";

// Track all workflows created during tests for cleanup
const createdWorkflows: Workflow[] = [];

afterAll(async () => {
	for (const wf of createdWorkflows) {
		if (!wf.worktreePath) continue;
		try {
			const cwd = wf.targetRepository || process.cwd();
			const rm = Bun.spawn(["git", "worktree", "remove", wf.worktreePath, "--force"], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			await rm.exited;
			const del = Bun.spawn(["git", "branch", "-D", wf.worktreeBranch], {
				cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			await del.exited;
		} catch {
			// Best-effort cleanup
		}
	}
	createdWorkflows.length = 0;
});

async function createAndTrack(
	result: EpicAnalysisResult,
	targetRepository: string | undefined,
	autoStart: boolean,
) {
	const out = await createEpicWorkflows(result, targetRepository, autoStart);
	createdWorkflows.push(...out.workflows);
	return out;
}

describe("createEpicWorkflows", () => {
	const mockResult: EpicAnalysisResult = {
		title: "Auth System",
		specs: [
			{ id: "a", title: "OAuth2", description: "Add OAuth2 login", dependencies: [] },
			{ id: "b", title: "Profiles", description: "Add user profiles", dependencies: ["a"] },
			{ id: "c", title: "Admin", description: "Add admin dashboard", dependencies: ["a", "b"] },
		],
		infeasibleNotes: null,
	};

	test("creates workflows with shared epicId", async () => {
		const { workflows, epicId } = await createAndTrack(mockResult, undefined, false);
		expect(workflows).toHaveLength(3);
		for (const wf of workflows) {
			expect(wf.epicId).toBe(epicId);
			expect(wf.epicTitle).toBe("Auth System");
		}
	});

	test("maps temp dependency IDs to real workflow IDs", async () => {
		const { workflows } = await createAndTrack(mockResult, undefined, false);
		const [wfA, wfB, wfC] = workflows;
		expect(wfA.epicDependencies).toEqual([]);
		expect(wfB.epicDependencies).toEqual([wfA.id]);
		expect(wfC.epicDependencies).toEqual([wfA.id, wfB.id]);
	});

	test("sets dependency status correctly", async () => {
		const { workflows } = await createAndTrack(mockResult, undefined, false);
		const [wfA, wfB, wfC] = workflows;
		expect(wfA.epicDependencyStatus).toBe("satisfied");
		expect(wfB.epicDependencyStatus).toBe("waiting");
		expect(wfC.epicDependencyStatus).toBe("waiting");
	});

	test("autoStart sets waiting_for_dependencies on dependent specs", async () => {
		const { workflows } = await createAndTrack(mockResult, undefined, true);
		const [wfA, wfB, wfC] = workflows;
		// Independent spec stays idle (startPipeline handles the transition)
		expect(wfA.status).toBe("idle");
		expect(wfB.status).toBe("waiting_for_dependencies");
		expect(wfC.status).toBe("waiting_for_dependencies");
	});

	test("without autoStart all specs stay idle", async () => {
		const { workflows } = await createAndTrack(mockResult, undefined, false);
		for (const wf of workflows) {
			expect(wf.status).toBe("idle");
		}
	});

	test("single-spec fallback creates one workflow", async () => {
		const singleResult: EpicAnalysisResult = {
			title: "Simple Feature",
			specs: [{ id: "a", title: "Only spec", description: "Do the thing", dependencies: [] }],
			infeasibleNotes: null,
		};
		const { workflows, epicId } = await createAndTrack(singleResult, undefined, true);
		expect(workflows).toHaveLength(1);
		expect(workflows[0].epicId).toBe(epicId);
		expect(workflows[0].epicDependencyStatus).toBe("satisfied");
	});
});
