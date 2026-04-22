import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectArtifactsFromManifest,
	getArtifactsRoot,
	listArtifacts,
} from "../../src/workflow-artifacts";
import { makeWorkflow } from "../helpers";

const cleanupDirs: string[] = [];

afterEach(() => {
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {}
		}
	}
});

function fresh(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function seedOutputDir(base: string, files: Record<string, string>): string {
	mkdirSync(base, { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(base, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
	}
	return base;
}

describe("artifacts step — concurrent-workflow isolation (T036)", () => {
	test("two workflows producing artifacts with the same relPath do not overwrite each other", async () => {
		const idA = fresh("wf-conc-a");
		const idB = fresh("wf-conc-b");
		cleanupDirs.push(getArtifactsRoot(idA));
		cleanupDirs.push(getArtifactsRoot(idB));

		const base = join(tmpdir(), fresh("conc-base"));
		mkdirSync(base, { recursive: true });
		cleanupDirs.push(base);

		const outA = seedOutputDir(join(base, "a"), {
			"report.md": "workflow A report",
			"manifest.json": JSON.stringify({
				version: 1,
				artifacts: [{ path: "report.md", description: "A" }],
			}),
		});
		const outB = seedOutputDir(join(base, "b"), {
			"report.md": "workflow B report",
			"manifest.json": JSON.stringify({
				version: 1,
				artifacts: [{ path: "report.md", description: "B" }],
			}),
		});

		const caps = { perFileMaxBytes: 1_048_576, perStepMaxBytes: 10_485_760 };
		// Interleave collection via Promise.all to exercise the per-workflow
		// directory-namespacing guarantee under concurrent dispatch, not just
		// sequential writes.
		const [rA, rB] = await Promise.all([
			Promise.resolve().then(() => collectArtifactsFromManifest({ id: idA }, outA, caps)),
			Promise.resolve().then(() => collectArtifactsFromManifest({ id: idB }, outB, caps)),
		]);
		expect(rA.outcome).toBe("with-files");
		expect(rB.outcome).toBe("with-files");

		const wfA = makeWorkflow({ id: idA, featureBranch: "feat-a" });
		const wfB = makeWorkflow({ id: idB, featureBranch: "feat-b" });
		const itemsA = listArtifacts(wfA).items.filter((i) => i.step === "artifacts");
		const itemsB = listArtifacts(wfB).items.filter((i) => i.step === "artifacts");

		expect(itemsA.length).toBe(1);
		expect(itemsB.length).toBe(1);

		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		expect(readFileSync(join(getArtifactsRoot(idA), "artifacts", "_", "report.md"), "utf-8")).toBe(
			"workflow A report",
		);
		expect(readFileSync(join(getArtifactsRoot(idB), "artifacts", "_", "report.md"), "utf-8")).toBe(
			"workflow B report",
		);

		// Descriptions sidecars are isolated too.
		expect(itemsA[0].description).toBe("A");
		expect(itemsB[0].description).toBe("B");
	}, 30_000);
});
