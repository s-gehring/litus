import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { listArtifacts, resolveArtifactPath } from "../../src/workflow-artifacts";
import { makeWorkflow } from "../helpers";
import { withTempDir } from "../test-infra";

function seedSpecs(dir: string, branch: string, files: Record<string, string>): string {
	const specsRoot = join(dir, "specs", branch);
	mkdirSync(specsRoot, { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(specsRoot, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
	}
	return specsRoot;
}

describe("workflow-artifacts: step mapping and discovery", () => {
	test("specify alone surfaces only the spec descriptor (FR-005)", async () => {
		await withTempDir(async (dir) => {
			seedSpecs(dir, "feat-branch", { "spec.md": "# hi" });
			const wf = makeWorkflow({
				id: "wf-1a",
				worktreePath: dir,
				featureBranch: "feat-branch",
			});
			const res = listArtifacts(wf);
			expect(res.branch).toBe("feat-branch");
			const spec = res.items.find((i) => i.step === "specify");
			const clarify = res.items.find((i) => i.step === "clarify");
			expect(spec?.affordanceLabel).toBe("View spec");
			expect(spec?.relPath).toBe("spec.md");
			expect(clarify).toBeUndefined();
		});
	});

	test("clarify descriptor appears only once the clarify step has run (FR-005)", async () => {
		await withTempDir(async (dir) => {
			seedSpecs(dir, "feat-branch", { "spec.md": "# hi" });
			const wf = makeWorkflow({
				id: "wf-1b",
				worktreePath: dir,
				featureBranch: "feat-branch",
			});
			const clarifyStep = wf.steps.find((s) => s.name === "clarify");
			if (!clarifyStep) throw new Error("missing clarify step");
			clarifyStep.status = "completed";

			const res = listArtifacts(wf);
			const spec = res.items.find((i) => i.step === "specify");
			const clarify = res.items.find((i) => i.step === "clarify");
			expect(spec?.affordanceLabel).toBe("View spec");
			expect(clarify?.affordanceLabel).toBe("View spec with clarifications");
			expect(clarify?.relPath).toBe("spec.md");
			expect(spec?.id).not.toBe(clarify?.id);
		});
	});

	test("plan step surfaces plan.md + side artifacts + contracts/**/*.md", async () => {
		await withTempDir(async (dir) => {
			seedSpecs(dir, "feat-branch", {
				"plan.md": "p",
				"research.md": "r",
				"data-model.md": "dm",
				"quickstart.md": "qs",
				"contracts/foo.md": "f",
				"contracts/nested/bar.md": "b",
			});
			const wf = makeWorkflow({
				id: "wf-2",
				worktreePath: dir,
				featureBranch: "feat-branch",
			});
			const plans = listArtifacts(wf).items.filter((i) => i.step === "plan");
			const names = plans.map((p) => p.relPath).sort();
			expect(names).toEqual([
				"contracts/foo.md",
				"contracts/nested/bar.md",
				"data-model.md",
				"plan.md",
				"quickstart.md",
				"research.md",
			]);
		});
	});

	test("missing files are filtered out", async () => {
		await withTempDir(async (dir) => {
			seedSpecs(dir, "feat-branch", { "plan.md": "p" });
			const wf = makeWorkflow({
				id: "wf-3",
				worktreePath: dir,
				featureBranch: "feat-branch",
			});
			const res = listArtifacts(wf);
			const steps = res.items.map((i) => i.step);
			expect(steps).not.toContain("specify");
			expect(steps).not.toContain("tasks");
			expect(steps).toContain("plan");
		});
	});

	test("review + implement-review pair by ordinal", async () => {
		await withTempDir(async (dir) => {
			seedSpecs(dir, "feat", {
				"code-review.md": "r1",
				"code-review-2.md": "r2",
				"code-review-3.md": "r3",
			});
			const wf = makeWorkflow({
				id: "wf-4",
				worktreePath: dir,
				featureBranch: "feat",
			});
			// Mark implement-review as having completed 2 runs (history=1 + status=completed)
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

			const res = listArtifacts(wf);
			const reviews = res.items.filter((i) => i.step === "review");
			const impls = res.items.filter((i) => i.step === "implement-review");
			expect(reviews.map((r) => r.runOrdinal)).toEqual([1, 2, 3]);
			expect(impls.map((i) => i.runOrdinal)).toEqual([1, 2]);
			// Matching ordinals must reference the same file
			for (const ord of [1, 2]) {
				const r = reviews.find((x) => x.runOrdinal === ord);
				const i = impls.find((x) => x.runOrdinal === ord);
				expect(r?.relPath).toBe(i?.relPath ?? "");
			}
		});
	});

	test("implement-review history entries with non-completed status do not count", async () => {
		await withTempDir(async (dir) => {
			seedSpecs(dir, "feat", {
				"code-review.md": "r1",
				"code-review-2.md": "r2",
				"code-review-3.md": "r3",
			});
			const wf = makeWorkflow({
				id: "wf-4b",
				worktreePath: dir,
				featureBranch: "feat",
			});
			const impl = wf.steps.find((s) => s.name === "implement-review");
			if (!impl) throw new Error("missing implement-review step");
			impl.status = "completed";
			// One errored run + one completed run in history, plus the current
			// completed status: historical error must NOT be paired.
			impl.history = [
				{
					runNumber: 1,
					status: "error",
					output: "",
					error: "boom",
					startedAt: new Date().toISOString(),
					completedAt: new Date().toISOString(),
				},
				{
					runNumber: 2,
					status: "completed",
					output: "",
					error: null,
					startedAt: new Date().toISOString(),
					completedAt: new Date().toISOString(),
				},
			];

			const res = listArtifacts(wf);
			const impls = res.items.filter((i) => i.step === "implement-review");
			expect(impls.length).toBe(2);
			expect(impls.map((i) => i.runOrdinal)).toEqual([1, 2]);
		});
	});

	test("empty list when worktreePath missing or specs dir absent", async () => {
		await withTempDir(async (dir) => {
			const wf = makeWorkflow({
				id: "wf-5",
				worktreePath: dir,
				featureBranch: "missing-branch",
			});
			const res = listArtifacts(wf);
			expect(res.items).toEqual([]);
			expect(res.branch).toBe("missing-branch");
		});
	});
});

describe("resolveArtifactPath: traversal rejection", () => {
	test("accepts legitimate relative paths", async () => {
		await withTempDir(async (dir) => {
			const root = join(dir, "specs", "b");
			mkdirSync(root, { recursive: true });
			const out = resolveArtifactPath(root, "spec.md");
			expect(out).toBe(join(root, "spec.md"));
		});
	});

	test("rejects `..` escape", async () => {
		await withTempDir(async (dir) => {
			const root = join(dir, "specs", "b");
			mkdirSync(root, { recursive: true });
			expect(resolveArtifactPath(root, "../outside.md")).toBeNull();
			expect(resolveArtifactPath(root, "../../etc/passwd")).toBeNull();
		});
	});

	test("rejects absolute paths that escape root", async () => {
		await withTempDir(async (dir) => {
			const root = join(dir, "specs", "b");
			mkdirSync(root, { recursive: true });
			const outside = join(dir, "other.md");
			expect(resolveArtifactPath(root, outside)).toBeNull();
		});
	});

	test("accepts nested subdir paths", async () => {
		await withTempDir(async (dir) => {
			const root = join(dir, "specs", "b");
			mkdirSync(root, { recursive: true });
			const out = resolveArtifactPath(root, "contracts/api.md");
			expect(out).toBe(`${root}${sep}contracts${sep}api.md`);
		});
	});
});
