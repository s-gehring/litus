import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ScenarioScript } from "../e2e/harness/scenario-types";

/**
 * Covers the fake claude's short-circuit invocation paths — `--version`,
 * `--help`, the model-detection probe, and the review-classifier
 * side-channel. Each path emits canned output without consuming a FIFO
 * counter slot, so a regression that strips any of them would silently
 * advance the counter on every probe call and shift every scenario by one,
 * which manifests across the e2e suite as "wrong response at index N"
 * failures that are hard to attribute back to the probe-shortcut regression.
 *
 * These unit tests give a direct signal: spawn the fake with each argv,
 * assert exit 0, expected stdout, and the counter file is unchanged.
 */

const FAKE_PATH = resolve(__dirname, "..", "e2e", "fakes", "claude.ts");

let workdir = "";
let scenarioPath = "";
let counterPath = "";

beforeEach(async () => {
	workdir = await mkdtemp(join(tmpdir(), "litus-fake-shortcircuit-"));
	scenarioPath = join(workdir, "scenario.json");
	counterPath = join(workdir, "counter.json");
	const scenario: ScenarioScript = {
		name: "unit-shortcircuit",
		// Intentionally one entry only — if the short-circuit accidentally
		// consumed a FIFO slot, a second invocation would die with "no
		// scripted response", which we do not want masking the assertion.
		claude: [{ events: [{ type: "result", subtype: "success", session_id: "s" }] }],
		gh: {},
	};
	await writeFile(scenarioPath, JSON.stringify(scenario), "utf8");
});

afterEach(async () => {
	if (workdir) await rm(workdir, { recursive: true, force: true });
});

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function runFake(args: string[]): Promise<RunResult> {
	return await new Promise<RunResult>((resolvePromise, rejectPromise) => {
		const proc = spawn(process.execPath, ["run", FAKE_PATH, ...args], {
			cwd: workdir,
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
		proc.on("close", (exitCode) => resolvePromise({ exitCode: exitCode ?? -1, stdout, stderr }));
	});
}

function counterUnchanged(): void {
	// File never written ⇒ the FIFO slot was not consumed; that is the
	// invariant the short-circuit paths exist to preserve.
	if (existsSync(counterPath)) {
		const raw = readFileSync(counterPath, "utf8");
		const parsed = JSON.parse(raw);
		expect(parsed.claude ?? 0).toBe(0);
	}
}

describe("fake claude: short-circuit invocations", () => {
	test("--version exits 0 with version stdout and does not advance counter", async () => {
		const result = await runFake(["--version"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("litus-e2e-fake");
		counterUnchanged();
	});

	test("--help exits 0 and does not advance counter", async () => {
		const result = await runFake(["--help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("litus-e2e-fake");
		counterUnchanged();
	});

	test("model-detection probe exits 0 with JSON and does not advance counter", async () => {
		const result = await runFake([
			"-p",
			"Respond with ONLY a single JSON object describing the model.",
			"--output-format",
			"text",
		]);
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout.trim());
		expect(parsed.modelId).toBeTruthy();
		expect(parsed.displayName).toBeTruthy();
		counterUnchanged();
	});

	test("review-classifier prompt routes to scenario.classifier without advancing counter", async () => {
		const scenario: ScenarioScript = {
			name: "unit-classifier",
			classifier: "minor\n",
			claude: [{ events: [{ type: "result", subtype: "success", session_id: "s" }] }],
			gh: {},
		};
		await writeFile(scenarioPath, JSON.stringify(scenario), "utf8");
		const result = await runFake([
			"-p",
			"Classify the highest severity of issues found in this code review.",
			"--output-format",
			"text",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("minor\n");
		counterUnchanged();
	});

	test("review-classifier defaults to 'nit\\n' when scenario.classifier is omitted", async () => {
		const result = await runFake([
			"-p",
			"Classify the highest severity of issues found in this code review.",
			"--output-format",
			"text",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("nit\n");
		counterUnchanged();
	});
});
