import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { clearArtifacts, getArtifactsRoot } from "../src/workflow-artifacts";

describe("clearArtifacts", () => {
	const workflowId = `wf-test-${Date.now()}`;
	const root = getArtifactsRoot(workflowId);

	beforeEach(() => {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	afterEach(() => {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	test("missing root returns { removed: 0, failed: [] }", async () => {
		const result = await clearArtifacts(workflowId);
		expect(result).toEqual({ removed: 0, failed: [] });
	});

	test("populated root removes all files and returns count", async () => {
		mkdirSync(join(root, "specify"), { recursive: true });
		mkdirSync(join(root, "plan"), { recursive: true });
		writeFileSync(join(root, "specify", "spec.md"), "spec");
		writeFileSync(join(root, "plan", "plan.md"), "plan");
		writeFileSync(join(root, "plan", "research.md"), "research");

		const result = await clearArtifacts(workflowId);
		expect(result.removed).toBe(3);
		expect(result.failed).toEqual([]);
	});

	test("artifact root lives under $HOME/.litus/artifacts/<id>", () => {
		expect(getArtifactsRoot(workflowId)).toBe(join(homedir(), ".litus", "artifacts", workflowId));
	});
});
