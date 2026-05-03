import { describe, expect, mock, test } from "bun:test";
import { aggregateStepStatus } from "../../src/aspect-researcher";
import { AspectRunner } from "../../src/aspect-runner";
import type { CLICallbacks } from "../../src/cli-runner";
import { configStore, DEFAULT_CONFIG } from "../../src/config-store";
import type { AspectState, Workflow } from "../../src/types";

// These tests cover the parallel-research-aspect concurrency surface area
// without constructing a full PipelineOrchestrator. The orchestrator wires
// many heavy collaborators (audit logger, worktree manager, store, summarizer,
// etc.); the contracts under test here live in small, isolated code blocks
// that we can exercise directly:
//
//   - retry-wipe: pipeline-orchestrator.ts:640-654 (errored→pending field reset)
//   - handleAspectError startedAt-stamp: pipeline-orchestrator.ts:1605
//   - partial-failure step status: aggregateStepStatus from aspect-researcher
//   - mid-step cap re-read: configStore.get() consulted on every promotion
//
// The retry-wipe and handleAspectError helpers are private on the orchestrator,
// so we replicate the exact field mutations here. If the production source is
// changed, these tests will not catch behavioural drift — but they DO lock in
// the contract from data-model.md §2 + contracts/aspect-state-shape.md §2.

function aspect(overrides: Partial<AspectState> = {}): AspectState {
	return {
		id: overrides.id ?? "a",
		fileName: overrides.fileName ?? `${overrides.id ?? "a"}.md`,
		status: overrides.status ?? "pending",
		sessionId: overrides.sessionId ?? null,
		startedAt: overrides.startedAt ?? null,
		completedAt: overrides.completedAt ?? null,
		errorMessage: overrides.errorMessage ?? null,
		output: overrides.output ?? "",
		outputLog: overrides.outputLog ?? [],
	};
}

// Mirrors the retry-wipe block in pipeline-orchestrator.ts:640-654 — applied
// when STEP.RESEARCH_ASPECT runs and any aspect is errored.
function applyRetryWipe(aspects: AspectState[]): void {
	for (const a of aspects) {
		if (a.status === "errored") {
			a.status = "pending";
			a.errorMessage = null;
			a.startedAt = null;
			a.completedAt = null;
			a.sessionId = null;
			a.output = "";
			a.outputLog = [];
		}
	}
}

describe("retry-wipe (errored → pending reset)", () => {
	test("wipes output, outputLog, errorMessage, timestamps, sessionId on errored aspects", () => {
		const aspects = [
			aspect({
				id: "a",
				status: "errored",
				errorMessage: "boom",
				startedAt: "2026-05-03T00:00:00Z",
				completedAt: "2026-05-03T00:01:00Z",
				sessionId: "sess-a",
				output: "partial output",
				outputLog: [{ kind: "text", text: "partial output" }],
			}),
			aspect({
				id: "b",
				status: "completed",
				output: "done",
				outputLog: [{ kind: "text", text: "done" }],
				startedAt: "2026-05-03T00:00:00Z",
				completedAt: "2026-05-03T00:01:00Z",
				sessionId: "sess-b",
			}),
		];

		applyRetryWipe(aspects);

		expect(aspects[0].status).toBe("pending");
		expect(aspects[0].errorMessage).toBeNull();
		expect(aspects[0].startedAt).toBeNull();
		expect(aspects[0].completedAt).toBeNull();
		expect(aspects[0].sessionId).toBeNull();
		expect(aspects[0].output).toBe("");
		expect(aspects[0].outputLog).toEqual([]);

		// Completed aspect untouched — FR-008 keeps its panel content.
		expect(aspects[1].status).toBe("completed");
		expect(aspects[1].output).toBe("done");
		expect(aspects[1].outputLog.length).toBe(1);
		expect(aspects[1].sessionId).toBe("sess-b");
	});

	test("no errored aspects → no mutations", () => {
		const aspects = [
			aspect({ id: "a", status: "completed", output: "x" }),
			aspect({ id: "b", status: "pending" }),
		];
		const snap = JSON.stringify(aspects);
		applyRetryWipe(aspects);
		expect(JSON.stringify(aspects)).toBe(snap);
	});
});

describe("partial-failure step aggregation (aggregateStepStatus)", () => {
	test("3 aspects: 1 errored + 2 completed → 'error'", () => {
		const aspects = [
			aspect({ id: "a", status: "completed" }),
			aspect({ id: "b", status: "completed" }),
			aspect({ id: "c", status: "errored", errorMessage: "x" }),
		];
		expect(aggregateStepStatus(aspects)).toBe("error");
	});

	test("3 aspects: 1 errored + 1 in_progress + 1 pending → 'running' (still working)", () => {
		const aspects = [
			aspect({ id: "a", status: "errored", errorMessage: "x" }),
			aspect({ id: "b", status: "in_progress" }),
			aspect({ id: "c", status: "pending" }),
		];
		expect(aggregateStepStatus(aspects)).toBe("running");
	});
});

// Mirrors the handleAspectError startedAt-stamp in pipeline-orchestrator.ts:1605
// — early-error paths (e.g. missing manifest entry) fire onAspectError without
// a paired onAspectStart, so the contract requires defensive stamping.
function applyHandleAspectError(target: AspectState, message: string, now: string): void {
	target.status = "errored";
	if (!target.startedAt) target.startedAt = now;
	target.completedAt = now;
	target.errorMessage = message;
}

describe("handleAspectError defensive startedAt stamp", () => {
	test("stamps startedAt when missing on early-error path", () => {
		const a = aspect({ id: "a", status: "pending", startedAt: null });
		const now = "2026-05-03T01:00:00Z";
		applyHandleAspectError(a, "missing manifest entry", now);
		expect(a.status).toBe("errored");
		expect(a.startedAt).toBe(now);
		expect(a.completedAt).toBe(now);
		expect(a.errorMessage).toBe("missing manifest entry");
	});

	test("preserves existing startedAt", () => {
		const earlier = "2026-05-03T00:30:00Z";
		const a = aspect({ id: "a", status: "in_progress", startedAt: earlier });
		const now = "2026-05-03T01:00:00Z";
		applyHandleAspectError(a, "boom", now);
		expect(a.startedAt).toBe(earlier);
		expect(a.completedAt).toBe(now);
	});
});

// Cap-read semantics: the orchestrator re-reads
// `configStore.get().limits.askQuestionConcurrentAspects` on every slot
// promotion (pipeline-orchestrator.ts:1626). Drive that path through
// AspectRunner.promoteNext with a cap derived live from configStore between
// promotions and assert that lowering mid-step honors the new cap on the next
// opening.
describe("cap-read semantics — configStore changes mid-step take effect on next promotion", () => {
	function makeWorkflow(aspectIds: string[]): Workflow {
		return {
			id: "wf-cap",
			aspectManifest: {
				version: 1,
				aspects: aspectIds.map((id) => ({
					id,
					title: id,
					researchPrompt: "p",
					fileName: `${id}.md`,
				})),
			},
			aspects: aspectIds.map((id) => aspect({ id, fileName: `${id}.md` })),
			specification: "Q",
			worktreePath: "/tmp/wt",
		} as unknown as Workflow;
	}

	function fakeRunner() {
		return {
			start: mock(
				(
					_workflow: Workflow,
					_callbacks: CLICallbacks,
					_extraEnv?: Record<string, string>,
					_model?: string,
					_effort?: string,
					_opts?: { processKey?: string; aspectId?: string },
				) => {},
			),
			killAllForWorkflow: mock(() => {}),
		};
	}

	test("higher cap → multiple promotions; lowering between calls blocks further promotion", () => {
		// Reset to a known baseline.
		configStore.save({
			limits: { ...DEFAULT_CONFIG.limits, askQuestionConcurrentAspects: 3 },
		});

		const cli = fakeRunner();
		// biome-ignore lint/suspicious/noExplicitAny: fake CLIRunner shape
		const runner = new AspectRunner(cli as any);
		const wf = makeWorkflow(["a", "b", "c", "d"]);
		const aspects = wf.aspects ?? [];
		const env = {
			cwd: "/tmp/wt",
			promptTemplate: "T:${aspectTitle}",
			model: undefined,
			effort: undefined,
		};
		const callbacks = {
			onAspectStart: mock(() => {}),
			onAspectOutput: mock(() => {}),
			onAspectTools: mock(() => {}),
			onAspectSessionId: mock(() => {}),
			onAspectComplete: mock(() => {}),
			onAspectError: mock(() => {}),
		};

		// First promotion — read cap live from configStore (cap=3).
		const cap1 = Math.max(
			1,
			Math.min(configStore.get().limits.askQuestionConcurrentAspects, aspects.length),
		);
		expect(cap1).toBe(3);
		const r1 = runner.promoteNext(wf, aspects, cap1, env, callbacks);
		expect(r1).toBe("a");
		const r2 = runner.promoteNext(wf, aspects, cap1, env, callbacks);
		expect(r2).toBe("b");
		expect(runner.inFlightCount(wf.id)).toBe(2);

		// User lowers the cap mid-step.
		configStore.save({
			limits: { ...DEFAULT_CONFIG.limits, askQuestionConcurrentAspects: 2 },
		});

		// Next slot opening: cap is re-read from configStore. With 2 in-flight
		// already, the new cap of 2 should block the next promotion.
		const cap2 = Math.max(
			1,
			Math.min(configStore.get().limits.askQuestionConcurrentAspects, aspects.length),
		);
		expect(cap2).toBe(2);
		const r3 = runner.promoteNext(wf, aspects, cap2, env, callbacks);
		expect(r3).toBeNull();
		expect(runner.inFlightCount(wf.id)).toBe(2);

		// Restore default for other tests.
		configStore.save({
			limits: { ...DEFAULT_CONFIG.limits, askQuestionConcurrentAspects: 10 },
		});
	});
});
