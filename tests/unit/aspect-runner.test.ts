import { describe, expect, mock, test } from "bun:test";
import { AspectRunner } from "../../src/aspect-runner";
import type { CLICallbacks } from "../../src/cli-runner";
import type { AspectState, Workflow } from "../../src/types";

interface FakeProcess {
	processKey: string;
	aspectId: string | null;
	callbacks: CLICallbacks;
}

function fakeRunner() {
	const processes: FakeProcess[] = [];
	return {
		start: mock(
			(
				_workflow: Workflow,
				callbacks: CLICallbacks,
				_extraEnv?: Record<string, string>,
				_model?: string,
				_effort?: string,
				opts?: { processKey?: string; aspectId?: string },
			) => {
				processes.push({
					processKey: opts?.processKey ?? "default",
					aspectId: opts?.aspectId ?? null,
					callbacks,
				});
			},
		),
		killAllForWorkflow: mock(() => {}),
		processes,
	};
}

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

function makeWorkflow(aspectIds: string[]): Workflow {
	return {
		id: "wf1",
		aspectManifest: {
			version: 1,
			aspects: aspectIds.map((id) => ({
				id,
				title: `Title ${id}`,
				researchPrompt: `Prompt ${id}`,
				fileName: `${id}.md`,
			})),
		},
		aspects: aspectIds.map((id) => aspect({ id, fileName: `${id}.md` })),
		// Minimum of fields the AspectRunner reads — synthesise a realistic copy:
		specification: "Q",
		worktreePath: "/tmp/wt",
	} as unknown as Workflow;
}

const env = {
	cwd: "/tmp/wt",
	promptTemplate: "T:${aspectTitle}",
	model: undefined,
	effort: undefined,
};

function makeCallbacks() {
	return {
		onAspectStart: mock(() => {}),
		onAspectOutput: mock(() => {}),
		onAspectTools: mock(() => {}),
		onAspectSessionId: mock(() => {}),
		onAspectComplete: mock(() => {}),
		onAspectError: mock(() => {}),
	};
}

describe("AspectRunner.dispatch", () => {
	test("starts up to cap aspects in manifest order", () => {
		const cli = fakeRunner();
		const runner = new AspectRunner(
			cli as unknown as ConstructorParameters<typeof AspectRunner>[0],
		);
		const wf = makeWorkflow(["a", "b", "c", "d"]);
		const cb = makeCallbacks();
		const started = runner.dispatch(wf, wf.aspects ?? [], 2, env, cb);
		expect(started).toEqual(["a", "b"]);
		expect(cli.start).toHaveBeenCalledTimes(2);
		expect(cli.processes.map((p) => p.processKey)).toEqual([
			"wf1::aspect::a",
			"wf1::aspect::b",
		]);
		expect(cb.onAspectStart).toHaveBeenCalledTimes(2);
		expect(runner.inFlightCount("wf1")).toBe(2);
	});

	test("dispatch with cap=1 starts exactly one even given five candidates", () => {
		const cli = fakeRunner();
		const runner = new AspectRunner(
			cli as unknown as ConstructorParameters<typeof AspectRunner>[0],
		);
		const wf = makeWorkflow(["a", "b", "c", "d", "e"]);
		const cb = makeCallbacks();
		const started = runner.dispatch(wf, wf.aspects ?? [], 1, env, cb);
		expect(started).toEqual(["a"]);
		expect(runner.inFlightCount("wf1")).toBe(1);
	});

	test("dispatch with single aspect runs through the same path (FR-013 parity)", () => {
		const cli = fakeRunner();
		const runner = new AspectRunner(
			cli as unknown as ConstructorParameters<typeof AspectRunner>[0],
		);
		const wf = makeWorkflow(["solo"]);
		const cb = makeCallbacks();
		const started = runner.dispatch(wf, wf.aspects ?? [], 1, env, cb);
		expect(started).toEqual(["solo"]);
		expect(cli.processes[0].aspectId).toBe("solo");
		expect(cli.processes[0].processKey).toBe("wf1::aspect::solo");
	});
});

describe("AspectRunner.promoteNext", () => {
	test("promotes the next pending aspect when slot frees up", () => {
		const cli = fakeRunner();
		const runner = new AspectRunner(
			cli as unknown as ConstructorParameters<typeof AspectRunner>[0],
		);
		const wf = makeWorkflow(["a", "b", "c"]);
		const cb = makeCallbacks();
		runner.dispatch(wf, wf.aspects ?? [], 2, env, cb);
		expect(runner.inFlightCount("wf1")).toBe(2);

		// Simulate aspect "a" completing
		cli.processes[0].callbacks.onComplete();
		expect(runner.inFlightCount("wf1")).toBe(1);

		// Promote next: "b" is in-flight, "c" is the next pending
		const next = runner.promoteNext(wf, [wf.aspects?.[2] as AspectState], 2, env, cb);
		expect(next).toBe("c");
		expect(runner.inFlightCount("wf1")).toBe(2);
	});

	test("returns null when cap is full", () => {
		const cli = fakeRunner();
		const runner = new AspectRunner(
			cli as unknown as ConstructorParameters<typeof AspectRunner>[0],
		);
		const wf = makeWorkflow(["a", "b"]);
		const cb = makeCallbacks();
		runner.dispatch(wf, wf.aspects ?? [], 2, env, cb);
		const next = runner.promoteNext(wf, [], 2, env, cb);
		expect(next).toBeNull();
	});
});

describe("AspectRunner cap invariant", () => {
	test("cap=2 over 5 aspects: in-flight count never exceeds 2", () => {
		const cli = fakeRunner();
		const runner = new AspectRunner(
			cli as unknown as ConstructorParameters<typeof AspectRunner>[0],
		);
		const wf = makeWorkflow(["a", "b", "c", "d", "e"]);
		const cb = makeCallbacks();

		runner.dispatch(wf, wf.aspects ?? [], 2, env, cb);
		expect(runner.inFlightCount("wf1")).toBeLessThanOrEqual(2);

		// Complete each in-flight aspect one at a time, promoting next pending.
		while (runner.inFlightCount("wf1") > 0) {
			const proc = cli.processes.find((p) => runner.inFlightIds("wf1").includes(p.aspectId ?? ""));
			expect(proc).toBeDefined();
			proc?.callbacks.onComplete();
			expect(runner.inFlightCount("wf1")).toBeLessThanOrEqual(2);
			// Promote next pending — caller resolves which aspects are still pending
			const stillPending = (wf.aspects ?? []).filter(
				(a) => !runner.inFlightIds("wf1").includes(a.id) && a.status === "pending",
			);
			runner.promoteNext(wf, stillPending, 2, env, cb);
			expect(runner.inFlightCount("wf1")).toBeLessThanOrEqual(2);
			// Drop the just-completed aspect from "pending" to break the loop
			const doneIdx = (wf.aspects ?? []).findIndex((a) => a.id === proc?.aspectId);
			if (doneIdx >= 0 && wf.aspects) wf.aspects[doneIdx].status = "completed";
		}
	});
});
