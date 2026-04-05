import { afterAll, describe, expect, test } from "bun:test";
import type { EpicAnalysisResult, Workflow } from "../src/types";
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

async function createAndTrack(result: EpicAnalysisResult, targetRepository: string | undefined) {
	const out = await createEpicWorkflows(result, targetRepository);
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
		summary: null,
	};

	test("creates workflows with shared epicId", async () => {
		const { workflows, epicId } = await createAndTrack(mockResult, undefined);
		expect(workflows).toHaveLength(3);
		for (const wf of workflows) {
			expect(wf.epicId).toBe(epicId);
			expect(wf.epicTitle).toBe("Auth System");
		}
	});

	test("maps temp dependency IDs to real workflow IDs with transitive reduction", async () => {
		const { workflows } = await createAndTrack(mockResult, undefined);
		const [wfA, wfB, wfC] = workflows;
		expect(wfA.epicDependencies).toEqual([]);
		expect(wfB.epicDependencies).toEqual([wfA.id]);
		// C's dep on A is transitive (B already depends on A), so only B remains
		expect(wfC.epicDependencies).toEqual([wfB.id]);
	});

	test("sets dependency status correctly", async () => {
		const { workflows } = await createAndTrack(mockResult, undefined);
		const [wfA, wfB, wfC] = workflows;
		expect(wfA.epicDependencyStatus).toBe("satisfied");
		expect(wfB.epicDependencyStatus).toBe("waiting");
		expect(wfC.epicDependencyStatus).toBe("waiting");
	});

	test("independent specs stay idle, dependent specs get waiting_for_dependencies", async () => {
		const { workflows } = await createAndTrack(mockResult, undefined);
		const [wfA, wfB, wfC] = workflows;
		expect(wfA.status).toBe("idle");
		expect(wfB.status).toBe("waiting_for_dependencies");
		expect(wfC.status).toBe("waiting_for_dependencies");
	});

	test("single-spec fallback creates one workflow", async () => {
		const singleResult: EpicAnalysisResult = {
			title: "Simple Feature",
			specs: [{ id: "a", title: "Only spec", description: "Do the thing", dependencies: [] }],
			infeasibleNotes: null,
			summary: null,
		};
		const { workflows, epicId } = await createAndTrack(singleResult, undefined);
		expect(workflows).toHaveLength(1);
		expect(workflows[0].epicId).toBe(epicId);
		expect(workflows[0].epicDependencyStatus).toBe("satisfied");
	});
});
