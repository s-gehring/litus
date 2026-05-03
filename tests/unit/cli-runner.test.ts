import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aspectProcessKey, type CLICallbacks, CLIRunner } from "../../src/cli-runner";
import type { Workflow } from "../../src/types";
import { makeWorkflow } from "../helpers";

// Per-process tracking: each fake spawn returns a record we can inspect later.
interface FakeProc {
	pid: number;
	killed: boolean;
	kill: () => void;
	exitedResolve: (code: number) => void;
	exited: Promise<number>;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
}

const originalSpawn = Bun.spawn;
let pidCounter = 1;
const spawned: FakeProc[] = [];

function makeFakeProc(): FakeProc {
	let resolveExit: (code: number) => void = () => {};
	const exited = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	// Stdout never closes on its own — keep streamOutput's parser blocked so
	// the entry stays registered in the runner's Map until we call kill().
	const stdout = new ReadableStream<Uint8Array>({
		start() {
			// no-op: pending forever until controller is GC'd
		},
	});
	const stderr = new ReadableStream<Uint8Array>({
		start(c) {
			c.close();
		},
	});
	const proc: FakeProc = {
		pid: pidCounter++,
		killed: false,
		kill: () => {
			proc.killed = true;
			resolveExit(0);
		},
		exitedResolve: resolveExit,
		exited,
		stdout,
		stderr,
	};
	return proc;
}

function setupFakeSpawn() {
	(Bun as unknown as { spawn: unknown }).spawn = mock(() => {
		const p = makeFakeProc();
		spawned.push(p);
		return p as unknown as ReturnType<typeof Bun.spawn>;
	});
}

function noopCallbacks(): CLICallbacks {
	return {
		onOutput: () => {},
		onTools: () => {},
		onComplete: () => {},
		onError: () => {},
		onSessionId: () => {},
		onPid: () => {},
		onAssistantMessage: () => {},
	};
}

describe("CLIRunner — composite process key keying", () => {
	let runner: CLIRunner;
	let tmpCwd: string;
	let wfA: Workflow;
	let wfB: Workflow;

	beforeEach(() => {
		spawned.length = 0;
		pidCounter = 1;
		setupFakeSpawn();
		tmpCwd = mkdtempSync(join(tmpdir(), "cli-runner-test-"));
		runner = new CLIRunner();
		wfA = makeWorkflow({ id: "wfA", worktreePath: tmpCwd });
		wfB = makeWorkflow({ id: "wfB", worktreePath: tmpCwd });
	});

	afterEach(() => {
		runner.killAll();
		(Bun as unknown as { spawn: typeof originalSpawn }).spawn = originalSpawn;
		try {
			rmSync(tmpCwd, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	test("two concurrent start() calls with different processKeys coexist", () => {
		const key1 = aspectProcessKey("wfA", "a1");
		const key2 = aspectProcessKey("wfA", "a2");

		runner.start(wfA, noopCallbacks(), undefined, undefined, undefined, {
			processKey: key1,
			aspectId: "a1",
		});
		runner.start(wfA, noopCallbacks(), undefined, undefined, undefined, {
			processKey: key2,
			aspectId: "a2",
		});

		expect(spawned.length).toBe(2);
		expect(spawned[0].killed).toBe(false);
		expect(spawned[1].killed).toBe(false);
	});

	test("start() with an existing processKey kills the prior process", () => {
		const key = aspectProcessKey("wfA", "a1");
		runner.start(wfA, noopCallbacks(), undefined, undefined, undefined, {
			processKey: key,
			aspectId: "a1",
		});
		const first = spawned[0];
		expect(first.killed).toBe(false);

		runner.start(wfA, noopCallbacks(), undefined, undefined, undefined, {
			processKey: key,
			aspectId: "a1",
		});

		expect(spawned.length).toBe(2);
		expect(first.killed).toBe(true);
		expect(spawned[1].killed).toBe(false);
	});

	test("legacy single-arg call defaults to workflowId key (no opts)", () => {
		runner.start(wfA, noopCallbacks());
		expect(spawned.length).toBe(1);

		// A second call without opts — same workflow id — kills the prior one
		// (preserves master's single-process invariant).
		runner.start(wfA, noopCallbacks());
		expect(spawned.length).toBe(2);
		expect(spawned[0].killed).toBe(true);
		expect(spawned[1].killed).toBe(false);
	});

	test("killAllForWorkflow only removes entries owned by that workflow", () => {
		runner.start(wfA, noopCallbacks(), undefined, undefined, undefined, {
			processKey: aspectProcessKey("wfA", "x"),
			aspectId: "x",
		});
		runner.start(wfA, noopCallbacks(), undefined, undefined, undefined, {
			processKey: aspectProcessKey("wfA", "y"),
			aspectId: "y",
		});
		runner.start(wfB, noopCallbacks(), undefined, undefined, undefined, {
			processKey: aspectProcessKey("wfB", "z"),
			aspectId: "z",
		});

		expect(spawned.length).toBe(3);
		const [pA1, pA2, pB] = spawned;

		runner.killAllForWorkflow("wfA");

		expect(pA1.killed).toBe(true);
		expect(pA2.killed).toBe(true);
		expect(pB.killed).toBe(false);

		// Re-starting wfB's key should kill the lone surviving entry, proving it
		// remained registered after killAllForWorkflow("wfA").
		runner.start(wfB, noopCallbacks(), undefined, undefined, undefined, {
			processKey: aspectProcessKey("wfB", "z"),
			aspectId: "z",
		});
		expect(pB.killed).toBe(true);
	});
});
