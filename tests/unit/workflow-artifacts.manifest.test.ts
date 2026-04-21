import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArtifactsManifest } from "../../src/artifacts-manifest";
import {
	type ArtifactsCollectionCaps,
	collectArtifactsFromManifest,
	getArtifactsRoot,
	listArtifacts,
} from "../../src/workflow-artifacts";
import { makeWorkflow } from "../helpers";
import { withTempDir } from "../test-infra";

const DEFAULT_CAPS: ArtifactsCollectionCaps = {
	perFileMaxBytes: 100 * 1024 * 1024,
	perStepMaxBytes: 1024 * 1024 * 1024,
};

const seededRoots: string[] = [];

function registerForCleanup(workflowId: string): void {
	seededRoots.push(getArtifactsRoot(workflowId));
}

afterEach(() => {
	while (seededRoots.length > 0) {
		const dir = seededRoots.pop();
		if (dir) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup only.
			}
		}
	}
});

function freshWorkflowId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function seedFile(dir: string, relPath: string, content: string | Buffer): void {
	const abs = join(dir, relPath);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content);
}

describe("parseArtifactsManifest", () => {
	test("accepts a valid manifest", () => {
		const text = JSON.stringify({
			version: 1,
			artifacts: [
				{ path: "report.md", description: "Final report" },
				{ path: "chart.png", description: "Coverage chart", contentType: "image/png" },
			],
		});
		const r = parseArtifactsManifest(text);
		expect(r.ok).toBe(true);
		expect(r.manifest?.artifacts.length).toBe(2);
		expect(r.manifest?.artifacts[1].contentType).toBe("image/png");
	});

	test("rejects malformed JSON", () => {
		const r = parseArtifactsManifest("{ not json");
		expect(r.ok).toBe(false);
		expect(r.error?.kind).toBe("invalid-json");
	});

	test("rejects wrong version", () => {
		const r = parseArtifactsManifest(JSON.stringify({ version: 2, artifacts: [] }));
		expect(r.ok).toBe(false);
		expect(r.error?.kind).toBe("schema-violation");
	});

	test("rejects missing description", () => {
		const r = parseArtifactsManifest(JSON.stringify({ version: 1, artifacts: [{ path: "a" }] }));
		expect(r.ok).toBe(false);
	});

	test("rejects description over 500 chars", () => {
		const r = parseArtifactsManifest(
			JSON.stringify({
				version: 1,
				artifacts: [{ path: "a", description: "x".repeat(501) }],
			}),
		);
		expect(r.ok).toBe(false);
		expect(r.error?.kind).toBe("schema-violation");
	});

	test("rejects unknown root key", () => {
		const r = parseArtifactsManifest(JSON.stringify({ version: 1, artifacts: [], extra: 1 }));
		expect(r.ok).toBe(false);
	});

	test("rejects unknown entry key", () => {
		const r = parseArtifactsManifest(
			JSON.stringify({
				version: 1,
				artifacts: [{ path: "a", description: "d", weird: true }],
			}),
		);
		expect(r.ok).toBe(false);
	});
});

describe("collectArtifactsFromManifest", () => {
	test("missing manifest → error-outcome (manifest-missing)", async () => {
		await withTempDir(async (dir) => {
			const id = freshWorkflowId("wf-mm");
			registerForCleanup(id);
			const wf = makeWorkflow({ id });
			const r = collectArtifactsFromManifest(wf, dir, DEFAULT_CAPS);
			expect(r.outcome).toBe("error");
			expect(r.errorKind).toBe("manifest-missing");
			expect(r.accepted.length).toBe(0);
		});
	});

	test("invalid manifest → error-outcome (manifest-invalid) and no files copied", async () => {
		await withTempDir(async (dir) => {
			const id = freshWorkflowId("wf-mi");
			registerForCleanup(id);
			seedFile(dir, "manifest.json", "{ this is not json");
			seedFile(dir, "report.md", "# a report");
			const wf = makeWorkflow({ id });
			const r = collectArtifactsFromManifest(wf, dir, DEFAULT_CAPS);
			expect(r.outcome).toBe("error");
			expect(r.errorKind).toBe("manifest-invalid");
			// listArtifacts MUST show no artifacts-step entries.
			expect(listArtifacts(wf).items.some((i) => i.step === "artifacts")).toBe(false);
		});
	});

	test("manifest references nonexistent file → error-outcome atomically", async () => {
		await withTempDir(async (dir) => {
			const id = freshWorkflowId("wf-mfm");
			registerForCleanup(id);
			seedFile(dir, "present.md", "present");
			seedFile(
				dir,
				"manifest.json",
				JSON.stringify({
					version: 1,
					artifacts: [
						{ path: "present.md", description: "present" },
						{ path: "missing.md", description: "missing" },
					],
				}),
			);
			const wf = makeWorkflow({ id });
			const r = collectArtifactsFromManifest(wf, dir, DEFAULT_CAPS);
			expect(r.outcome).toBe("error");
			expect(r.errorKind).toBe("manifest-file-missing");
			// Atomic: even the present file must NOT be persisted.
			expect(listArtifacts(wf).items.some((i) => i.step === "artifacts")).toBe(false);
		});
	});

	test("traversal guard rejects manifest entries with ..", async () => {
		await withTempDir(async (dir) => {
			const id = freshWorkflowId("wf-trav");
			registerForCleanup(id);
			seedFile(
				dir,
				"manifest.json",
				JSON.stringify({
					version: 1,
					artifacts: [{ path: "../outside.md", description: "bad" }],
				}),
			);
			const wf = makeWorkflow({ id });
			const r = collectArtifactsFromManifest(wf, dir, DEFAULT_CAPS);
			expect(r.outcome).toBe("error");
			expect(r.errorKind).toBe("manifest-invalid");
		});
	});

	test("per-file cap → rejects just that file, other files still kept", async () => {
		await withTempDir(async (dir) => {
			const id = freshWorkflowId("wf-fcap");
			registerForCleanup(id);
			seedFile(dir, "small.md", "x");
			seedFile(dir, "big.md", "y".repeat(2000));
			seedFile(
				dir,
				"manifest.json",
				JSON.stringify({
					version: 1,
					artifacts: [
						{ path: "small.md", description: "fits" },
						{ path: "big.md", description: "too big" },
					],
				}),
			);
			const wf = makeWorkflow({ id });
			const r = collectArtifactsFromManifest(wf, dir, {
				perFileMaxBytes: 1000,
				perStepMaxBytes: 1024 * 1024,
			});
			expect(r.outcome).toBe("with-files");
			expect(r.accepted.length).toBe(1);
			expect(r.accepted[0].relPath).toBe("small.md");
			expect(r.rejections.length).toBe(1);
			expect(r.rejections[0].reason).toBe("file-cap-exceeded");
			expect(r.rejections[0].relPath).toBe("big.md");
		});
	});

	test("per-step cap → stops accepting but keeps files that were already under the cap", async () => {
		await withTempDir(async (dir) => {
			const id = freshWorkflowId("wf-scap");
			registerForCleanup(id);
			seedFile(dir, "a.md", "x".repeat(600));
			seedFile(dir, "b.md", "y".repeat(600));
			seedFile(dir, "c.md", "z".repeat(600));
			seedFile(
				dir,
				"manifest.json",
				JSON.stringify({
					version: 1,
					artifacts: [
						{ path: "a.md", description: "first" },
						{ path: "b.md", description: "second" },
						{ path: "c.md", description: "third (should be rejected)" },
					],
				}),
			);
			const wf = makeWorkflow({ id });
			const r = collectArtifactsFromManifest(wf, dir, {
				perFileMaxBytes: 10_000,
				perStepMaxBytes: 1500,
			});
			expect(r.outcome).toBe("with-files");
			expect(r.accepted.map((a) => a.relPath).sort()).toEqual(["a.md", "b.md"]);
			expect(r.rejections.length).toBe(1);
			expect(r.rejections[0].reason).toBe("step-cap-exceeded");
			expect(r.rejections[0].relPath).toBe("c.md");
		});
	});

	test("empty manifest → outcome=empty, no files listed", async () => {
		await withTempDir(async (dir) => {
			const id = freshWorkflowId("wf-empty");
			registerForCleanup(id);
			seedFile(dir, "manifest.json", JSON.stringify({ version: 1, artifacts: [] }));
			const wf = makeWorkflow({ id });
			const r = collectArtifactsFromManifest(wf, dir, DEFAULT_CAPS);
			expect(r.outcome).toBe("empty");
			expect(r.accepted.length).toBe(0);
			expect(r.rejections.length).toBe(0);
			expect(listArtifacts(wf).items.some((i) => i.step === "artifacts")).toBe(false);
		});
	});

	test("accepted files appear in listArtifacts with description and any extension", async () => {
		await withTempDir(async (dir) => {
			const id = freshWorkflowId("wf-list");
			registerForCleanup(id);
			seedFile(dir, "coverage.json", JSON.stringify({ passed: 42 }));
			seedFile(dir, "screenshot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
			seedFile(
				dir,
				"manifest.json",
				JSON.stringify({
					version: 1,
					artifacts: [
						{ path: "coverage.json", description: "Coverage report" },
						{
							path: "screenshot.png",
							description: "Playwright smoke-test screenshot",
							contentType: "image/png",
						},
					],
				}),
			);
			const wf = makeWorkflow({ id });
			const r = collectArtifactsFromManifest(wf, dir, DEFAULT_CAPS);
			expect(r.outcome).toBe("with-files");

			const items = listArtifacts(wf).items.filter((i) => i.step === "artifacts");
			const byPath = new Map(items.map((i) => [i.relPath, i]));
			expect(byPath.get("coverage.json")?.description).toBe("Coverage report");
			expect(byPath.get("screenshot.png")?.description).toBe("Playwright smoke-test screenshot");
			expect(byPath.get("screenshot.png")?.contentType).toBe("image/png");
			// Descriptions sidecar is NOT surfaced as a user artifact.
			expect(byPath.has("descriptions.json")).toBe(false);
		});
	});
});
