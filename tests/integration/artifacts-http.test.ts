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
import {
	getArtifactsRoot,
	mintArtifactId,
	snapshotStepArtifacts,
} from "../../src/workflow-artifacts";
import { createMockWorkflowStore } from "../../tests/test-infra/mock-stores";
import { makeWorkflow } from "../helpers";
import { withTempDir } from "../test-infra";

function seedSpecs(dir: string, branch: string, files: Record<string, string>): string {
	const root = join(dir, "specs", branch);
	mkdirSync(root, { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
	}
	return root;
}

function seedSnapshot(
	workflowId: string,
	step: string,
	ordinal: number | null,
	relPath: string,
	content: string,
): string {
	const ordSeg = ordinal == null ? "_" : String(ordinal);
	const abs = join(getArtifactsRoot(workflowId), step, ordSeg, relPath);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content);
	return abs;
}

function depsWith(workflow: Workflow): Pick<HandlerDeps, "orchestrators" | "sharedStore"> {
	const store = createMockWorkflowStore();
	store.seedWorkflow(workflow);
	return {
		orchestrators: new Map(),
		sharedStore: store.mock as unknown as HandlerDeps["sharedStore"],
	};
}

describe("artifacts HTTP: list endpoint", () => {
	test("returns descriptors grouped by step from persistent snapshots", async () => {
		await withTempDir(async (dir) => {
			seedSpecs(dir, "001-feat", {
				"spec.md": "# spec",
				"plan.md": "# plan",
				"tasks.md": "# tasks",
			});
			const wf = makeWorkflow({
				id: "wf-list",
				worktreePath: dir,
				featureBranch: "001-feat",
			});
			snapshotStepArtifacts(wf, "specify");
			// Simulate clarify running on the same file.
			snapshotStepArtifacts(wf, "clarify");
			snapshotStepArtifacts(wf, "plan");
			snapshotStepArtifacts(wf, "tasks");

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

	test("omits steps that never snapshotted (FR-005)", async () => {
		await withTempDir(async (dir) => {
			seedSpecs(dir, "001-feat", { "spec.md": "# spec" });
			const wf = makeWorkflow({
				id: "wf-miss",
				worktreePath: dir,
				featureBranch: "001-feat",
			});
			snapshotStepArtifacts(wf, "specify");
			const res = await handleArtifactList("wf-miss", depsWith(wf));
			const body = (await res.json()) as ArtifactListResponse;
			const steps = body.items.map((i) => i.step);
			expect(steps).not.toContain("plan");
			expect(steps).not.toContain("tasks");
		});
	});

	test("Plan with 4 base files + one contract yields 5 plan descriptors", async () => {
		await withTempDir(async (dir) => {
			seedSpecs(dir, "001-feat", {
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
			snapshotStepArtifacts(wf, "plan");
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

	test("review / implement-review descriptors pair by runOrdinal", async () => {
		seedSnapshot("wf-ord", "review", 1, "code-review.md", "r1");
		seedSnapshot("wf-ord", "review", 2, "code-review-2.md", "r2");
		seedSnapshot("wf-ord", "review", 3, "code-review-3.md", "r3");
		seedSnapshot("wf-ord", "implement-review", 1, "code-review.md", "r1f");
		seedSnapshot("wf-ord", "implement-review", 2, "code-review-2.md", "r2f");
		const wf = makeWorkflow({
			id: "wf-ord",
			worktreePath: "/tmp",
			featureBranch: "001-feat",
		});
		const res = await handleArtifactList("wf-ord", depsWith(wf));
		const body = (await res.json()) as ArtifactListResponse;
		const reviews = body.items.filter((i) => i.step === "review");
		const impls = body.items.filter((i) => i.step === "implement-review");
		expect(reviews.map((r) => r.runOrdinal)).toEqual([1, 2, 3]);
		expect(impls.map((i) => i.runOrdinal)).toEqual([1, 2]);
		const secondReview = reviews.find((r) => r.runOrdinal === 2);
		expect(secondReview?.relPath).toBe("code-review-2.md");
		for (const ord of [1, 2]) {
			const r = reviews.find((x) => x.runOrdinal === ord);
			const i = impls.find((x) => x.runOrdinal === ord);
			expect(r?.relPath).toBe(i?.relPath ?? "");
		}
	});

	test("returns empty items when no snapshots exist", async () => {
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

describe("artifacts HTTP: content endpoint", () => {
	test("returns snapshotted bytes with text/markdown content-type", async () => {
		await withTempDir(async (dir) => {
			seedSpecs(dir, "001-feat", { "spec.md": "# hello" });
			const wf = makeWorkflow({
				id: "wf-c1",
				worktreePath: dir,
				featureBranch: "001-feat",
			});
			snapshotStepArtifacts(wf, "specify");
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

	test("snapshot is point-in-time: later writes to specs/ do NOT change content (FR-002)", async () => {
		await withTempDir(async (dir) => {
			const root = seedSpecs(dir, "001-feat", { "spec.md": "v1" });
			const wf = makeWorkflow({
				id: "wf-c2",
				worktreePath: dir,
				featureBranch: "001-feat",
			});
			snapshotStepArtifacts(wf, "specify");
			const list = (await (
				await handleArtifactList("wf-c2", depsWith(wf))
			).json()) as ArtifactListResponse;
			const spec = list.items.find((i) => i.step === "specify");
			if (!spec) throw new Error("specify descriptor missing");

			const r1 = await handleArtifactContent("wf-c2", spec.id, depsWith(wf));
			expect(await r1.text()).toBe("v1");

			writeFileSync(join(root, "spec.md"), "v2");

			const r2 = await handleArtifactContent("wf-c2", spec.id, depsWith(wf));
			expect(await r2.text()).toBe("v1");
		});
	});

	test("returns 400 invalid_artifact when descriptor relPath escapes the artifact root", () => {
		seedSnapshot("wf-traversal", "specify", null, "spec.md", "x");
		const wf = makeWorkflow({
			id: "wf-traversal",
			worktreePath: "/tmp",
			featureBranch: "001-feat",
		});
		const badId = mintArtifactId("wf-traversal", "specify", "../outside.md", null);
		return handleArtifactContent("wf-traversal", badId, depsWith(wf)).then(async (res) => {
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe("invalid_artifact");
		});
	});

	test("returns 404 artifact_unavailable when snapshot is deleted between list and content (FR-007)", async () => {
		const snapPath = seedSnapshot("wf-vanish", "specify", null, "spec.md", "v1");
		const wf = makeWorkflow({
			id: "wf-vanish",
			worktreePath: "/tmp",
			featureBranch: "001-feat",
		});
		const list = (await (
			await handleArtifactList("wf-vanish", depsWith(wf))
		).json()) as ArtifactListResponse;
		const spec = list.items.find((i) => i.step === "specify");
		if (!spec) throw new Error("specify descriptor missing");

		unlinkSync(snapPath);

		const res = await handleArtifactContent("wf-vanish", spec.id, depsWith(wf));
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("artifact_unavailable");
	});

	test("returns 404 artifact_unavailable for unknown id", () => {
		const wf = makeWorkflow({
			id: "wf-c3",
			worktreePath: "/tmp",
			featureBranch: "001-feat",
		});
		return handleArtifactContent("wf-c3", "a_bogus", depsWith(wf)).then(async (res) => {
			expect(res.status).toBe(404);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe("artifact_unavailable");
		});
	});
});

describe("artifacts HTTP: download endpoint", () => {
	test("sets Content-Disposition with sanitized branch prefix", async () => {
		await withTempDir(async (dir) => {
			seedSpecs(dir, "feat-with-spaces", { "spec.md": "hi" });
			const wf = makeWorkflow({
				id: "wf-d1",
				worktreePath: dir,
				featureBranch: "feat/with spaces",
				worktreeBranch: "feat-with-spaces",
			});
			// snapshot reads from specs/<featureBranch>/, but featureBranch is
			// "feat/with spaces" here so the specs path won't match. Use a
			// branch whose sanitized form matches what we seeded.
			snapshotStepArtifacts(
				{ ...wf, featureBranch: null, worktreeBranch: "feat-with-spaces" },
				"specify",
			);
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

	test("download body bytes equal snapshot bytes exactly", async () => {
		await withTempDir(async (dir) => {
			const content = "# h\n\nLine with unicode ü\n";
			seedSpecs(dir, "feat", { "spec.md": content });
			const wf = makeWorkflow({
				id: "wf-d2",
				worktreePath: dir,
				featureBranch: "feat",
			});
			snapshotStepArtifacts(wf, "specify");
			const list = (await (
				await handleArtifactList("wf-d2", depsWith(wf))
			).json()) as ArtifactListResponse;
			const spec = list.items.find((i) => i.step === "specify");
			if (!spec) throw new Error("specify descriptor missing");
			const res = await handleArtifactDownload("wf-d2", spec.id, depsWith(wf));
			expect(await res.text()).toBe(content);
		});
	});

	test("artifacts-step download honours the manifest's contentType hint and returns original bytes", async () => {
		// Stage a fake manifest-collected artifact directly in the persistent
		// store + a descriptions sidecar with a custom contentType. listArtifacts
		// then picks them up and the download handler should emit that exact
		// MIME type instead of inferring from the file extension.
		const id = `wf-ct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x42]);
		const stepDir = join(getArtifactsRoot(id), "artifacts", "_");
		mkdirSync(stepDir, { recursive: true });
		const storePath = join(stepDir, "screenshot.bin");
		writeFileSync(storePath, content);
		writeFileSync(
			join(stepDir, "descriptions.json"),
			JSON.stringify({
				"screenshot.bin": {
					description: "Playwright smoke-test screenshot",
					contentType: "image/png",
				},
			}),
		);
		try {
			const wf = makeWorkflow({
				id,
				worktreePath: "/tmp",
				featureBranch: "feat",
			});
			const list = (await (
				await handleArtifactList(id, depsWith(wf))
			).json()) as ArtifactListResponse;
			const entry = list.items.find((i) => i.step === "artifacts");
			expect(entry?.contentType).toBe("image/png");
			if (!entry) throw new Error("artifacts descriptor missing");

			const contentRes = await handleArtifactContent(id, entry.id, depsWith(wf));
			expect(contentRes.headers.get("Content-Type")).toBe("image/png");

			const downloadRes = await handleArtifactDownload(id, entry.id, depsWith(wf));
			expect(downloadRes.headers.get("Content-Type")).toBe("image/png");
			// Bytes must round-trip unchanged.
			const arrBuf = await downloadRes.arrayBuffer();
			expect(Buffer.from(arrBuf).equals(content)).toBe(true);
		} finally {
			try {
				unlinkSync(storePath);
			} catch {}
			try {
				unlinkSync(join(stepDir, "descriptions.json"));
			} catch {}
		}
	});
});
