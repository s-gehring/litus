import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import {
	getArtifactsRoot,
	listArtifacts,
	resolveArtifactPath,
	snapshotStepArtifacts,
} from "../../src/workflow-artifacts";
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

/** Seed a snapshot file directly at $HOME/.litus/artifacts/<wf>/<step>/<ordinal>/<rel>. */
function seedSnapshot(
	workflowId: string,
	step: string,
	ordinal: number | null,
	relPath: string,
	content: string,
): void {
	const ordSeg = ordinal == null ? "_" : String(ordinal);
	const abs = join(getArtifactsRoot(workflowId), step, ordSeg, relPath);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content);
}

describe("workflow-artifacts: step mapping and discovery", () => {
	test("specify alone surfaces only the spec descriptor (FR-005)", () => {
		const id = `wf-1a-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		seedSnapshot(id, "specify", null, "spec.md", "# hi");
		const wf = makeWorkflow({ id, featureBranch: "feat-branch" });
		const res = listArtifacts(wf);
		expect(res.branch).toBe("feat-branch");
		const spec = res.items.find((i) => i.step === "specify");
		const clarify = res.items.find((i) => i.step === "clarify");
		expect(spec?.displayLabel).toBe("spec.md");
		expect(spec?.relPath).toBe("spec.md");
		expect(clarify).toBeUndefined();
	});

	test("clarify descriptor appears once a clarify snapshot exists (FR-005)", () => {
		const id = `wf-1b-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		seedSnapshot(id, "specify", null, "spec.md", "# v1");
		seedSnapshot(id, "clarify", null, "spec.md", "# v2");
		const wf = makeWorkflow({ id, featureBranch: "feat-branch" });
		const res = listArtifacts(wf);
		const spec = res.items.find((i) => i.step === "specify");
		const clarify = res.items.find((i) => i.step === "clarify");
		expect(spec?.displayLabel).toBe("spec.md");
		expect(clarify?.displayLabel).toBe("spec.md (clarified)");
		expect(clarify?.relPath).toBe("spec.md");
		expect(spec?.id).not.toBe(clarify?.id);
	});

	test("plan step surfaces plan.md + side artifacts + contracts/**/*.md via snapshotting", async () => {
		await withTempDir(async (dir) => {
			seedSpecs(dir, "feat-branch", {
				"plan.md": "p",
				"research.md": "r",
				"data-model.md": "dm",
				"quickstart.md": "qs",
				"contracts/foo.md": "f",
				"contracts/nested/bar.md": "b",
			});
			const id = `wf-2-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			const wf = makeWorkflow({
				id,
				worktreePath: dir,
				featureBranch: "feat-branch",
			});
			snapshotStepArtifacts(wf, "plan");
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

	test("missing snapshots are not listed", () => {
		const id = `wf-3-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		seedSnapshot(id, "plan", null, "plan.md", "p");
		const wf = makeWorkflow({ id, featureBranch: "feat-branch" });
		const res = listArtifacts(wf);
		const steps = res.items.map((i) => i.step);
		expect(steps).not.toContain("specify");
		expect(steps).not.toContain("tasks");
		expect(steps).toContain("plan");
	});

	test("review + implement-review pair by ordinal", () => {
		const id = `wf-4-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		seedSnapshot(id, "review", 1, "code-review.md", "r1");
		seedSnapshot(id, "review", 2, "code-review-2.md", "r2");
		seedSnapshot(id, "review", 3, "code-review-3.md", "r3");
		seedSnapshot(id, "implement-review", 1, "code-review.md", "r1-fixed");
		seedSnapshot(id, "implement-review", 2, "code-review-2.md", "r2-fixed");
		const wf = makeWorkflow({ id, featureBranch: "feat" });
		const res = listArtifacts(wf);
		const reviews = res.items.filter((i) => i.step === "review");
		const impls = res.items.filter((i) => i.step === "implement-review");
		expect(reviews.map((r) => r.runOrdinal)).toEqual([1, 2, 3]);
		expect(impls.map((i) => i.runOrdinal)).toEqual([1, 2]);
		for (const ord of [1, 2]) {
			const r = reviews.find((x) => x.runOrdinal === ord);
			const i = impls.find((x) => x.runOrdinal === ord);
			expect(r?.relPath).toBe(i?.relPath ?? "");
		}
	});

	test("review snapshot writes code-review.md at ordinal 1 for the first iteration", async () => {
		await withTempDir(async (dir) => {
			seedSpecs(dir, "feat", { "code-review.md": "initial review body" });
			const id = `wf-rev1-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			const wf = makeWorkflow({ id, worktreePath: dir, featureBranch: "feat" });
			wf.reviewCycle.iteration = 1;
			snapshotStepArtifacts(wf, "review");
			const reviews = listArtifacts(wf).items.filter((i) => i.step === "review");
			expect(reviews.map((r) => r.runOrdinal)).toEqual([1]);
			expect(reviews[0]?.relPath).toBe("code-review.md");
		});
	});

	test("implement-review snapshot uses the SAME ordinal+file as the review it responds to", async () => {
		// Regression: previously, reviewCycle.iteration was incremented
		// between review and implement-review, which left implement-review
		// snapshots pointing at a code-review-N.md that did not exist in
		// the worktree. The correct invariant is that iteration is stable
		// across the review → implement-review pair, and implement-review
		// captures the same file — now carrying appended responses — under
		// the same ordinal.
		await withTempDir(async (dir) => {
			seedSpecs(dir, "feat", { "code-review.md": "review only" });
			const id = `wf-impl1-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			const wf = makeWorkflow({ id, worktreePath: dir, featureBranch: "feat" });
			wf.reviewCycle.iteration = 1;

			// Review step snapshots its output.
			snapshotStepArtifacts(wf, "review");

			// Implement-review appends a response to the same file.
			writeFileSync(
				join(dir, "specs", "feat", "code-review.md"),
				"review only\n\n## Response\nfixed it",
			);
			snapshotStepArtifacts(wf, "implement-review");

			const impls = listArtifacts(wf).items.filter((i) => i.step === "implement-review");
			expect(impls.map((i) => i.runOrdinal)).toEqual([1]);
			expect(impls[0]?.relPath).toBe("code-review.md");
			expect(impls[0]?.displayLabel).toBe("code-review.md (after fixes)");
		});
	});

	test("multi-iteration review cycle snapshots pairs for every iteration", async () => {
		await withTempDir(async (dir) => {
			const id = `wf-cycle-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			const wf = makeWorkflow({ id, worktreePath: dir, featureBranch: "feat" });
			mkdirSync(join(dir, "specs", "feat"), { recursive: true });

			// Iteration 1: review writes code-review.md, implement-review
			// appends a response to the same file.
			writeFileSync(join(dir, "specs", "feat", "code-review.md"), "r1");
			wf.reviewCycle.iteration = 1;
			snapshotStepArtifacts(wf, "review");
			writeFileSync(join(dir, "specs", "feat", "code-review.md"), "r1 + response 1");
			snapshotStepArtifacts(wf, "implement-review");

			// Cycle loops back. The feedback-implementer bumps iteration
			// before the next review runs.
			wf.reviewCycle.iteration = 2;
			writeFileSync(join(dir, "specs", "feat", "code-review-2.md"), "r2");
			snapshotStepArtifacts(wf, "review");
			writeFileSync(join(dir, "specs", "feat", "code-review-2.md"), "r2 + response 2");
			snapshotStepArtifacts(wf, "implement-review");

			// Third iteration — review only, cycle then advances.
			wf.reviewCycle.iteration = 3;
			writeFileSync(join(dir, "specs", "feat", "code-review-3.md"), "r3");
			snapshotStepArtifacts(wf, "review");

			const res = listArtifacts(wf);
			const reviews = res.items.filter((i) => i.step === "review");
			const impls = res.items.filter((i) => i.step === "implement-review");

			// Three review iterations visible as separate artifacts.
			expect(reviews.map((r) => r.runOrdinal)).toEqual([1, 2, 3]);
			expect(reviews.map((r) => r.relPath)).toEqual([
				"code-review.md",
				"code-review-2.md",
				"code-review-3.md",
			]);

			// Both implement-review runs are surfaced, paired with the review
			// they responded to — not silently dropped as before the fix.
			expect(impls.map((i) => i.runOrdinal)).toEqual([1, 2]);
			expect(impls.map((i) => i.relPath)).toEqual(["code-review.md", "code-review-2.md"]);
			expect(impls.every((i) => i.displayLabel.endsWith("(after fixes)"))).toBe(true);
		});
	});

	test("snapshotStepArtifacts copies spec.md from specs root at specify time", async () => {
		await withTempDir(async (dir) => {
			seedSpecs(dir, "feat", { "spec.md": "original" });
			const id = `wf-snap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			const wf = makeWorkflow({ id, worktreePath: dir, featureBranch: "feat" });
			snapshotStepArtifacts(wf, "specify");
			// Mutate the specs/ file — the snapshot must retain the original content.
			writeFileSync(join(dir, "specs", "feat", "spec.md"), "modified");
			const res = listArtifacts(wf);
			const spec = res.items.find((i) => i.step === "specify");
			expect(spec?.relPath).toBe("spec.md");
		});
	});

	test("empty list when no snapshots exist", () => {
		const id = `wf-5-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const wf = makeWorkflow({ id, featureBranch: "missing-branch" });
		const res = listArtifacts(wf);
		expect(res.items).toEqual([]);
		expect(res.branch).toBe("missing-branch");
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
