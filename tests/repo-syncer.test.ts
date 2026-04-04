import { describe, expect, mock, test } from "bun:test";
import { syncRepo } from "../src/repo-syncer";

function makeFakeEngine(removeWorktreeImpl?: () => Promise<void>) {
	return {
		removeWorktree: mock(removeWorktreeImpl ?? (async () => {})),
		getWorkflow: () => null,
		setWorkflow: () => {},
		createWorkflow: async () => null,
		transition: () => {},
		updateLastOutput: () => {},
		updateSummary: () => {},
		updateStepSummary: () => {},
		setQuestion: () => {},
		clearQuestion: () => {},
	};
}

function makeStream(content: string): ReadableStream {
	return new ReadableStream({
		start(c) {
			if (content) c.enqueue(new TextEncoder().encode(content));
			c.close();
		},
	});
}

describe("repo-syncer", () => {
	// T022: successful pull returns { pulled: true, worktreeRemoved: true }
	test("successful pull returns pulled: true and worktreeRemoved: true", async () => {
		const engine = makeFakeEngine();

		const result = await syncRepo(
			"/target/repo",
			"/tmp/worktree",
			// biome-ignore lint/suspicious/noExplicitAny: DI with compatible fake
			engine as any,
			"wf-1",
			() => {},
			{
				spawn: () => ({
					exited: Promise.resolve(0),
					stdout: makeStream(""),
					stderr: makeStream(""),
				}),
			},
		);

		expect(result.pulled).toBe(true);
		expect(result.skipped).toBe(false);
		expect(result.worktreeRemoved).toBe(true);
		expect(result.warning).toBeNull();
		expect(engine.removeWorktree).toHaveBeenCalledTimes(1);
	});

	// T023: uncommitted changes skip pull with warning, still removes worktree
	test("uncommitted changes skip pull with warning, still removes worktree", async () => {
		const engine = makeFakeEngine();
		let callCount = 0;

		const result = await syncRepo(
			"/target/repo",
			"/tmp/worktree",
			// biome-ignore lint/suspicious/noExplicitAny: DI with compatible fake
			engine as any,
			"wf-1",
			() => {},
			{
				spawn: () => {
					callCount++;
					if (callCount === 1) {
						// git status --porcelain returns uncommitted changes
						return {
							exited: Promise.resolve(0),
							stdout: makeStream("M src/main.ts\n"),
							stderr: makeStream(""),
						};
					}
					// Should not call git pull
					return {
						exited: Promise.resolve(0),
						stdout: makeStream(""),
						stderr: makeStream(""),
					};
				},
			},
		);

		expect(result.pulled).toBe(false);
		expect(result.skipped).toBe(true);
		expect(result.worktreeRemoved).toBe(true);
		expect(result.warning).toContain("Uncommitted changes");
		expect(callCount).toBe(1); // Only git status was called, not git pull
	});

	// T024: pull failure warns but still completes workflow and removes worktree
	test("pull failure warns but still removes worktree", async () => {
		const engine = makeFakeEngine();
		let callCount = 0;

		const result = await syncRepo(
			"/target/repo",
			"/tmp/worktree",
			// biome-ignore lint/suspicious/noExplicitAny: DI with compatible fake
			engine as any,
			"wf-1",
			() => {},
			{
				spawn: () => {
					callCount++;
					if (callCount === 1) {
						// git status clean
						return {
							exited: Promise.resolve(0),
							stdout: makeStream(""),
							stderr: makeStream(""),
						};
					}
					// git pull fails
					return {
						exited: Promise.resolve(1),
						stdout: makeStream(""),
						stderr: makeStream("fatal: Not possible to fast-forward"),
					};
				},
			},
		);

		expect(result.pulled).toBe(false);
		expect(result.worktreeRemoved).toBe(true);
		expect(result.warning).toContain("Pull failed");
	});

	// T025: worktree removal failure warns but workflow still completes
	test("worktree removal failure warns but returns worktreeRemoved: false", async () => {
		const engine = makeFakeEngine(async () => {
			throw new Error("worktree locked by another process");
		});

		const result = await syncRepo(
			"/target/repo",
			"/tmp/worktree",
			// biome-ignore lint/suspicious/noExplicitAny: DI with compatible fake
			engine as any,
			"wf-1",
			() => {},
			{
				spawn: () => ({
					exited: Promise.resolve(0),
					stdout: makeStream(""),
					stderr: makeStream(""),
				}),
			},
		);

		expect(result.pulled).toBe(true);
		expect(result.worktreeRemoved).toBe(false);
		expect(result.warning).toContain("Worktree removal failed");
	});

	test("null worktreePath skips worktree removal", async () => {
		const engine = makeFakeEngine();

		const result = await syncRepo(
			"/target/repo",
			null,
			// biome-ignore lint/suspicious/noExplicitAny: DI with compatible fake
			engine as any,
			"wf-1",
			() => {},
			{
				spawn: () => ({
					exited: Promise.resolve(0),
					stdout: makeStream(""),
					stderr: makeStream(""),
				}),
			},
		);

		expect(result.pulled).toBe(true);
		expect(result.worktreeRemoved).toBe(false);
		expect(engine.removeWorktree).not.toHaveBeenCalled();
	});
});
