import { describe, expect, test } from "bun:test";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HandlerDeps } from "../../src/server/handler-types";
import {
	handleArtifactContent,
	handleArtifactDownload,
	handleArtifactList,
} from "../../src/server/workflow-handlers";
import type { ArtifactListResponse, Workflow } from "../../src/types";
import { mintArtifactId } from "../../src/workflow-artifacts";
import { createMockWorkflowStore } from "../../tests/test-infra/mock-stores";
import { makeWorkflow } from "../helpers";
import { withTempDir } from "../test-infra";

function seed(dir: string, branch: string, files: Record<string, string>): string {
	const root = join(dir, "specs", branch);
	mkdirSync(root, { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
	}
	return root;
}

function depsWith(workflow: Workflow): Pick<HandlerDeps, "orchestrators" | "sharedStore"> {
	const store = createMockWorkflowStore();
	store.seedWorkflow(workflow);
	return {
		orchestrators: new Map(),
		sharedStore: store.mock as unknown as HandlerDeps["sharedStore"],
	};
}

describe("artifacts HTTP: list endpoint (US1)", () => {
	test("returns descriptors grouped by step", async () => {
		await withTempDir(async (dir) => {
			seed(dir, "001-feat", {
				"spec.md": "# spec",
				"plan.md": "# plan",
				"tasks.md": "# tasks",
			});
			const wf = makeWorkflow({
				id: "wf-list",
				worktreePath: dir,
				featureBranch: "001-feat",
			});
			const clarifyStep = wf.steps.find((s) => s.name === "clarify");
			if (!clarifyStep) throw new Error("missing clarify step");
			clarifyStep.status = "completed";
			const res = await handleArtifactList("wf-list", depsWith(wf));
			expect(res.status).toBe(200);
			const body = (await res.json()) as ArtifactListResponse;
			expect(body.workflowId).toBe("wf-list");
			expect(body.branch).toBe("001-feat");
			const steps = body.items.map((i) => i.step).sort();
			expect(steps).toContain("specify");
			expect(steps).toContain("clarify");
			expect(steps).toContain("plan");
			expect(steps).toContain("tasks");
		});
	});

	test("omits descriptors whose files do not exist (FR-005, US3)", async () => {
		await withTempDir(async (dir) => {
			seed(dir, "001-feat", { "spec.md": "# spec" });
			const wf = makeWorkflow({
				id: "wf-miss",
				worktreePath: dir,
				featureBranch: "001-feat",
			});
			const res = await handleArtifactList("wf-miss", depsWith(wf));
			const body = (await res.json()) as ArtifactListResponse;
			const steps = body.items.map((i) => i.step);
			expect(steps).not.toContain("plan");
			expect(steps).not.toContain("tasks");
		});
	});

	test("Planning with 4 base files + one contract yields 5 plan descriptors (US3)", async () => {
		await withTempDir(async (dir) => {
			seed(dir, "001-feat", {
				"plan.md": "p",
				"research.md": "r",
				"data-model.md": "dm",
				"quickstart.md": "qs",
				"contracts/foo.md": "f",
			});
			const wf = makeWorkflow({
				id: "wf-plan",
				worktreePath: dir,
				featureBranch: "001-feat",
			});
			const res = await handleArtifactList("wf-plan", depsWith(wf));
			const body = (await res.json()) as ArtifactListResponse;
			const plans = body.items.filter((i) => i.step === "plan");
			expect(plans).toHaveLength(5);
		});
	});

	test("returns 404 workflow_not_found when workflow is unknown", async () => {
		const store = createMockWorkflowStore();
		const deps = {
			orchestrators: new Map(),
			sharedStore: store.mock as unknown as HandlerDeps["sharedStore"],
		};
		const res = await handleArtifactList("nope", deps);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("workflow_not_found");
	});

	test("review / implement-review descriptors pair by runOrdinal in the HTTP response", async () => {
		await withTempDir(async (dir) => {
			seed(dir, "001-feat", {
				"code-review.md": "r1",
				"code-review-2.md": "r2",
				"code-review-3.md": "r3",
			});
			const wf = makeWorkflow({
				id: "wf-ord",
				worktreePath: dir,
				featureBranch: "001-feat",
			});
			const impl = wf.steps.find((s) => s.name === "implement-review");
			if (!impl) throw new Error("missing implement-review step");
			impl.status = "completed";
			impl.history = [
				{
					runNumber: 1,
					status: "completed",
					output: "",
					error: null,
					startedAt: new Date().toISOString(),
					completedAt: new Date().toISOString(),
				},
			];

			const res = await handleArtifactList("wf-ord", depsWith(wf));
			const body = (await res.json()) as ArtifactListResponse;
			const reviews = body.items.filter((i) => i.step === "review");
			const impls = body.items.filter((i) => i.step === "implement-review");
			expect(reviews.map((r) => r.runOrdinal)).toEqual([1, 2, 3]);
			expect(impls.map((i) => i.runOrdinal)).toEqual([1, 2]);
			// runOrdinal must survive JSON serialization of the response.
			const secondReview = reviews.find((r) => r.runOrdinal === 2);
			expect(secondReview?.relPath).toBe("code-review-2.md");
			for (const ord of [1, 2]) {
				const r = reviews.find((x) => x.runOrdinal === ord);
				const i = impls.find((x) => x.runOrdinal === ord);
				expect(r?.relPath).toBe(i?.relPath ?? "");
			}
		});
	});

	test("returns empty items when worktree/branch missing (not 404)", async () => {
		const wf = makeWorkflow({
			id: "wf-empty",
			worktreePath: null,
			featureBranch: null,
			worktreeBranch: "tmp",
		});
		const res = await handleArtifactList("wf-empty", depsWith(wf));
		expect(res.status).toBe(200);
		const body = (await res.json()) as ArtifactListResponse;
		expect(body.items).toEqual([]);
	});
});

describe("artifacts HTTP: content endpoint (US1)", () => {
	test("returns current on-disk bytes with text/markdown content-type", async () => {
		await withTempDir(async (dir) => {
			seed(dir, "001-feat", { "spec.md": "# hello" });
			const wf = makeWorkflow({
				id: "wf-c1",
				worktreePath: dir,
				featureBranch: "001-feat",
			});
			const listRes = await handleArtifactList("wf-c1", depsWith(wf));
			const list = (await listRes.json()) as ArtifactListResponse;
			const spec = list.items.find((i) => i.step === "specify");
			if (!spec) throw new Error("specify descriptor missing");

			const res = await handleArtifactContent("wf-c1", spec.id, depsWith(wf));
			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toContain("text/markdown");
			expect(await res.text()).toBe("# hello");
		});
	});

	test("re-writing file on disk returns new bytes (FR-006, no cache)", async () => {
		await withTempDir(async (dir) => {
			const root = seed(dir, "001-feat", { "spec.md": "v1" });
			const wf = makeWorkflow({
				id: "wf-c2",
				worktreePath: dir,
				featureBranch: "001-feat",
			});
			const list = (await (
				await handleArtifactList("wf-c2", depsWith(wf))
			).json()) as ArtifactListResponse;
			const spec = list.items.find((i) => i.step === "specify");
			if (!spec) throw new Error("specify descriptor missing");

			const r1 = await handleArtifactContent("wf-c2", spec.id, depsWith(wf));
			expect(await r1.text()).toBe("v1");

			writeFileSync(join(root, "spec.md"), "v2");

			const r2 = await handleArtifactContent("wf-c2", spec.id, depsWith(wf));
			expect(await r2.text()).toBe("v2");
		});
	});

	test("returns 400 invalid_artifact when the descriptor resolves outside the specs root", async () => {
		await withTempDir(async (dir) => {
			seed(dir, "001-feat", { "spec.md": "x" });
			writeFileSync(join(dir, "outside.md"), "secret");
			const wf = makeWorkflow({
				id: "wf-traversal",
				worktreePath: dir,
				featureBranch: "001-feat",
			});
			const badId = mintArtifactId("wf-traversal", "specify", "../outside.md", null);
			const res = await handleArtifactContent("wf-traversal", badId, depsWith(wf));
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe("invalid_artifact");
		});
	});

	test("returns 404 artifact_unavailable when the file is deleted between list and content (FR-007)", async () => {
		await withTempDir(async (dir) => {
			const root = seed(dir, "001-feat", { "spec.md": "v1" });
			const wf = makeWorkflow({
				id: "wf-vanish",
				worktreePath: dir,
				featureBranch: "001-feat",
			});
			const list = (await (
				await handleArtifactList("wf-vanish", depsWith(wf))
			).json()) as ArtifactListResponse;
			const spec = list.items.find((i) => i.step === "specify");
			if (!spec) throw new Error("specify descriptor missing");

			unlinkSync(join(root, "spec.md"));

			const res = await handleArtifactContent("wf-vanish", spec.id, depsWith(wf));
			expect(res.status).toBe(404);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe("artifact_unavailable");
		});
	});

	test("returns 404 artifact_unavailable for unknown id", async () => {
		await withTempDir(async (dir) => {
			seed(dir, "001-feat", { "spec.md": "x" });
			const wf = makeWorkflow({
				id: "wf-c3",
				worktreePath: dir,
				featureBranch: "001-feat",
			});
			const res = await handleArtifactContent("wf-c3", "a_bogus", depsWith(wf));
			expect(res.status).toBe(404);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe("artifact_unavailable");
		});
	});
});

describe("artifacts HTTP: download endpoint (US2)", () => {
	test("sets Content-Disposition with sanitized branch prefix", async () => {
		await withTempDir(async (dir) => {
			seed(dir, "feat/with spaces", { "spec.md": "hi" });
			const wf = makeWorkflow({
				id: "wf-d1",
				worktreePath: dir,
				featureBranch: "feat/with spaces",
			});
			const list = (await (
				await handleArtifactList("wf-d1", depsWith(wf))
			).json()) as ArtifactListResponse;
			const spec = list.items.find((i) => i.step === "specify");
			if (!spec) throw new Error("specify descriptor missing");

			const res = await handleArtifactDownload("wf-d1", spec.id, depsWith(wf));
			expect(res.status).toBe(200);
			const disp = res.headers.get("Content-Disposition");
			expect(disp).toContain("attachment");
			expect(disp).toContain('filename="feat-with-spaces-spec.md"');
			expect(disp).toContain("filename*=UTF-8''feat-with-spaces-spec.md");
		});
	});

	test("download body bytes equal source file bytes exactly", async () => {
		await withTempDir(async (dir) => {
			const content = "# h\n\nLine with unicode ü\n";
			seed(dir, "feat", { "spec.md": content });
			const wf = makeWorkflow({
				id: "wf-d2",
				worktreePath: dir,
				featureBranch: "feat",
			});
			const list = (await (
				await handleArtifactList("wf-d2", depsWith(wf))
			).json()) as ArtifactListResponse;
			const spec = list.items.find((i) => i.step === "specify");
			if (!spec) throw new Error("specify descriptor missing");
			const res = await handleArtifactDownload("wf-d2", spec.id, depsWith(wf));
			expect(await res.text()).toBe(content);
		});
	});
});
