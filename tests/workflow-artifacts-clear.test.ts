import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

	test.skipIf(process.platform === "win32")(
		"unremovable file: surfaces the absolute path in failed[] without counting it in removed (T005 case 3)",
		async () => {
			// POSIX-only: remove write permission from the containing directory
			// so `unlinkSync` fails. This exercises the `try { unlinkSync }
			// catch { failed.push(abs) }` branch that feeds the partial-failure
			// message in workflow-engine. Skipped on Windows where the ACL
			// model can still allow unlink on a chmod'd-readonly dir.
			const subdir = join(root, "locked");
			mkdirSync(subdir, { recursive: true });
			const file = join(subdir, "stuck.md");
			writeFileSync(file, "cannot remove");
			try {
				// Read + execute only → cannot unlink children.
				chmodSync(subdir, 0o500);
				const result = await clearArtifacts(workflowId);
				expect(result.failed).toContain(file);
				expect(result.removed).toBe(0);
			} finally {
				// Restore writable so afterEach cleanup can remove the dir.
				chmodSync(subdir, 0o700);
			}
		},
	);

	test("artifact root lives under $HOME/.litus/artifacts/<id>", () => {
		expect(getArtifactsRoot(workflowId)).toBe(join(homedir(), ".litus", "artifacts", workflowId));
	});
});
