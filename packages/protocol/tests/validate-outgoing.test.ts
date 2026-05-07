// `validateOutgoingInDev` env-toggle gating (FR-009, SC-006, R-7).
//
// `validate.ts` caches `process.env.NODE_ENV !== "production"` at
// module load, so a single-process test cannot exercise both branches.
// We spawn child Bun processes with the env var pinned to verify each.

import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import "./frontend-agnostic-guard";

const helperUrl = new URL("../src/validate.ts", import.meta.url);
const helperPath = fileURLToPath(helperUrl).replace(/\\/g, "/");

function runWithEnv(nodeEnv: string, script: string): { exitCode: number; stderr: string } {
	const proc = Bun.spawnSync({
		cmd: [process.execPath, "-e", script],
		env: { ...process.env, NODE_ENV: nodeEnv },
		stderr: "pipe",
		stdout: "pipe",
	});
	return {
		exitCode: proc.exitCode ?? -1,
		stderr: proc.stderr.toString(),
	};
}

describe("validateOutgoingInDev env gating", () => {
	test("NODE_ENV=production: malformed frame is a no-op", () => {
		const { exitCode, stderr } = runWithEnv(
			"production",
			`import { validateOutgoingInDev } from ${JSON.stringify(helperPath)};
			validateOutgoingInDev({ type: "not-a-real-variant" });
			console.log("ok");`,
		);
		expect(exitCode).toBe(0);
		expect(stderr).not.toContain("ZodError");
	});

	test("NODE_ENV=test: malformed frame throws synchronously", () => {
		const { stderr } = runWithEnv(
			"test",
			`import { validateOutgoingInDev } from ${JSON.stringify(helperPath)}; validateOutgoingInDev({ type: "not-a-real-variant" });`,
		);
		// `parse()` on a discriminated-union mismatch surfaces a ZodError
		// with `invalid_union_discriminator`. Asserting on the stderr text
		// rather than the spawn exit code keeps the test robust across
		// platforms (Windows reports the bun -e crash as a non-standard
		// exit code that varies between runs).
		expect(stderr).toContain("ZodError");
		expect(stderr).toContain("invalid_union_discriminator");
	});

	test("NODE_ENV=test: throw is synchronous (not a logged-and-swallowed safeParse)", () => {
		// Locks in `parse` (throwing) over `safeParse` + `console.error`. A
		// regression to safeParse would still surface "ZodError" in stderr,
		// so this catches the malformed frame inside the subprocess and
		// asserts the THROW marker reached stderr — proving control flow
		// took the throw path, not a logged-and-swallowed path.
		const { stderr } = runWithEnv(
			"test",
			`import { validateOutgoingInDev } from ${JSON.stringify(helperPath)};
			try { validateOutgoingInDev({ type: "not-a-real-variant" }); console.error("DID_NOT_THROW"); }
			catch (e) { console.error("THREW:", (e as Error).constructor.name); }`,
		);
		expect(stderr).toContain("THREW:");
		expect(stderr).toContain("ZodError");
		expect(stderr).not.toContain("DID_NOT_THROW");
	});

	test("NODE_ENV=development: well-formed frame does not throw", () => {
		const { exitCode } = runWithEnv(
			"development",
			`import { validateOutgoingInDev } from ${JSON.stringify(helperPath)};
			validateOutgoingInDev({ type: "console:output", text: "x" });`,
		);
		expect(exitCode).toBe(0);
	});
});
