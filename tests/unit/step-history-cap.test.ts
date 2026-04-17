import { describe, expect, test } from "bun:test";
import { enforceStepOutputCap } from "../../src/pipeline-orchestrator";
import type { PipelineStepRun } from "../../src/types";

function makeRun(output: string, runNumber: number): PipelineStepRun {
	return {
		runNumber,
		status: "completed",
		output,
		error: null,
		startedAt: "2026-04-18T12:00:00.000Z",
		completedAt: "2026-04-18T12:01:00.000Z",
	};
}

describe("enforceStepOutputCap", () => {
	test("no-op when combined size is within cap", () => {
		const step = {
			history: [makeRun("a".repeat(100), 1)],
			output: "b".repeat(100),
		};
		enforceStepOutputCap(step, 1000);
		expect(step.history).toHaveLength(1);
		expect(step.output.length).toBe(100);
	});

	test("drops oldest history entry wholesale when over cap", () => {
		const step = {
			history: [makeRun("aaaaa", 1), makeRun("bbbbb", 2)],
			output: "c".repeat(8),
		};
		enforceStepOutputCap(step, 15);
		// total was 5+5+8=18, over 15 → drop run 1 (len 5) → 5+8=13 ≤ 15
		expect(step.history).toHaveLength(1);
		expect(step.history[0].runNumber).toBe(2);
		expect(step.output.length).toBe(8);
	});

	test("drops successive oldest entries when still over cap", () => {
		const step = {
			history: [makeRun("aaaaa", 1), makeRun("bbbbb", 2), makeRun("ccccc", 3)],
			output: "d".repeat(10),
		};
		enforceStepOutputCap(step, 12);
		// 5+5+5+10=25 over 12 → drop 1 → 5+5+10=20 → drop 2 → 5+10=15 → drop 3 → 10 ≤ 12
		expect(step.history).toHaveLength(0);
		expect(step.output.length).toBe(10);
	});

	test("head-truncates step.output only when history is empty and still over cap", () => {
		const step = {
			history: [] as PipelineStepRun[],
			output: "abcdefghij", // 10 chars
		};
		enforceStepOutputCap(step, 4);
		expect(step.history).toHaveLength(0);
		// Head-truncated: keeps last 4 chars
		expect(step.output).toBe("ghij");
	});

	test("keeps current run untouched when dropping history brings size under cap", () => {
		const step = {
			history: [makeRun("x".repeat(100), 1)],
			output: "live".repeat(10), // 40 chars
		};
		enforceStepOutputCap(step, 50);
		expect(step.history).toHaveLength(0);
		expect(step.output.length).toBe(40);
	});
});
