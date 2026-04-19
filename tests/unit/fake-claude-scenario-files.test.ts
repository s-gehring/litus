import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ScenarioScript } from "../e2e/harness/scenario-types";

/**
 * Covers the security-relevant validation branches in `tests/e2e/fakes/claude.ts`
 * that the peripheral-artifacts e2e scenario doesn't exercise directly:
 *
 *   - `..` path segments escaping CWD are rejected
 *   - absolute `files[].path` entries are rejected
 *   - invalid base64 content is rejected
 *   - unknown `encoding` values are rejected
 *
 * Each subtest spawns the fake with a minimal scenario targeting exactly
 * one rejection branch and asserts the fake exits non-zero with the
 * `[litus-e2e-fake:claude] …` stderr prefix. The happy-path `files[]`
 * branch is also exercised so the positive case is guarded (the e2e
 * scenario asserts rendered artifacts, but that only runs end-to-end).
 */

const FAKE_PATH = resolve(__dirname, "..", "e2e", "fakes", "claude.ts");

let workdir = "";

beforeEach(async () => {
	workdir = await mkdtemp(join(tmpdir(), "litus-fake-claude-"));
});

afterEach(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

interface RunResult {
	exitCode: number;
	stderr: string;
	stdout: string;
}

async function runFake(scenario: ScenarioScript, cwd: string): Promise<RunResult> {
	const scenarioPath = join(cwd, "scenario.json");
	const counterPath = join(cwd, "counter.json");
	await writeFile(scenarioPath, JSON.stringify(scenario), "utf8");
	return await new Promise<RunResult>((resolvePromise, rejectPromise) => {
		// The fake has a Bun shebang and imports via the Bun TypeScript loader.
		// Run it under the same Bun binary that ran this test (process.execPath
		// is `bun` under `bun test`).
		const proc = spawn(process.execPath, ["run", FAKE_PATH, "--output-format", "stream-json"], {
			cwd,
			env: {
				...process.env,
				LITUS_E2E_SCENARIO: scenarioPath,
				LITUS_E2E_COUNTER: counterPath,
			},
		});
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (b) => {
			stdout += String(b);
		});
		proc.stderr.on("data", (b) => {
			stderr += String(b);
		});
		proc.on("error", rejectPromise);
		proc.on("close", (exitCode) => resolvePromise({ exitCode: exitCode ?? -1, stderr, stdout }));
	});
}

function baseScenario(file: { path: string; encoding: string; content: string }): ScenarioScript {
	return {
		name: "unit-fake-files",
		claude: [
			{
				events: [{ type: "result", subtype: "success", session_id: "s" }],
				files: [file as never],
			},
		],
		gh: {},
	};
}

describe("fake claude: files[] validation", () => {
	test("rejects `..` path segment", async () => {
		const result = await runFake(
			baseScenario({ path: "../escape.txt", encoding: "utf8", content: "x" }),
			workdir,
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("[litus-e2e-fake:claude]");
		expect(result.stderr).toContain("refusing to write outside CWD");
	});

	test("rejects absolute path", async () => {
		const abs = process.platform === "win32" ? "C:\\absolute.txt" : "/absolute.txt";
		const result = await runFake(
			baseScenario({ path: abs, encoding: "utf8", content: "x" }),
			workdir,
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("refusing to write outside CWD");
	});

	test("rejects invalid base64 content", async () => {
		const result = await runFake(
			baseScenario({ path: "bad.bin", encoding: "base64", content: "!!!!" }),
			workdir,
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("[litus-e2e-fake:claude]");
		expect(result.stderr).toMatch(/base64/);
	});

	test("rejects unknown encoding", async () => {
		const result = await runFake(
			baseScenario({ path: "file.txt", encoding: "hex", content: "deadbeef" }),
			workdir,
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("unsupported encoding");
	});

	test("happy path writes utf8 file inside CWD", async () => {
		const scenario = baseScenario({
			path: "nested/hello.txt",
			encoding: "utf8",
			content: "hello world",
		});
		const result = await runFake(scenario, workdir);
		expect(result.exitCode).toBe(0);
		const written = await readFile(join(workdir, "nested/hello.txt"), "utf8");
		expect(written).toBe("hello world");
	});
});
