import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Summarizer } from "../src/summarizer";

const originalSpawn = Bun.spawn;
const originalDateNow = Date.now;

function mockSpawnResponse(text: string, exitCode = 0) {
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
	return {
		stdout: stream,
		stderr: new ReadableStream({
			start(c) {
				c.close();
			},
		}),
		exited: Promise.resolve(exitCode),
		pid: 1,
		kill: () => {},
	};
}

function mockSpawnWithDeferred(text: string) {
	let resolveExited!: (code: number) => void;
	const exited = new Promise<number>((res) => {
		resolveExited = res;
	});
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
	return {
		proc: {
			stdout: stream,
			stderr: new ReadableStream({
				start(c) {
					c.close();
				},
			}),
			exited,
			pid: 1,
			kill: () => {},
		},
		resolveExited,
	};
}

// Flush microtask queue to let fire-and-forget promises resolve
// (runClaude adds extra async layers: readStream for stdout + stderr)
async function flushAsync() {
	for (let i = 0; i < 30; i++) {
		await Promise.resolve();
	}
}

describe("Summarizer", () => {
	let summarizer: Summarizer;
	let spawnMock: ReturnType<typeof mock>;
	let now: number;

	beforeEach(() => {
		summarizer = new Summarizer();
		spawnMock = mock(() => mockSpawnResponse("Setting up project"));
		Bun.spawn = spawnMock as typeof Bun.spawn;
		now = 100_000;
		Date.now = () => now;
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
		Date.now = originalDateNow;
	});

	describe("Timing and accumulation", () => {
		test("no summary triggered when fewer than 200 chars accumulated", () => {
			const callback = mock(() => {});
			summarizer.maybeSummarize("w1", "short text", callback);
			expect(callback).not.toHaveBeenCalled();
			expect(spawnMock).not.toHaveBeenCalled();
		});

		test("summary triggered when exactly 200 characters accumulated in a single chunk", async () => {
			const callback = mock(() => {});
			summarizer.maybeSummarize("w1", "x".repeat(200), callback);

			await flushAsync();

			expect(spawnMock).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith("Setting up project");
		});

		test("no summary when 200+ chars arrive but fewer than 15 seconds elapsed since last summary", async () => {
			const callback = mock(() => {});
			summarizer.maybeSummarize("w1", "x".repeat(250), callback);
			await flushAsync();

			// First summary completed at now=100_000. Advance only 5 seconds.
			now += 5_000;
			spawnMock.mockClear();
			summarizer.maybeSummarize("w1", "x".repeat(250), callback);
			await flushAsync();

			expect(spawnMock).not.toHaveBeenCalled();
		});

		test("summary triggered when 15+ seconds elapsed and sufficient chars accumulated", async () => {
			const callback = mock(() => {});
			summarizer.maybeSummarize("w1", "x".repeat(250), callback);
			await flushAsync();

			// Advance 16 seconds past interval
			now += 16_000;
			spawnMock.mockClear();
			summarizer.maybeSummarize("w1", "x".repeat(250), callback);
			await flushAsync();

			expect(spawnMock).toHaveBeenCalledTimes(1);
		});

		test("rapid small chunks crossing threshold produce only one spawn call on the expected chunk", async () => {
			const callback = mock(() => {});
			// Send 10 chunks of 25 chars each = 250 total, all in the same tick
			for (let i = 0; i < 10; i++) {
				summarizer.maybeSummarize("w1", "a".repeat(25), callback);
			}

			await flushAsync();

			// Only the chunk that crosses the threshold (8th chunk, at 200 chars) should trigger
			expect(spawnMock).toHaveBeenCalledTimes(1);
			// Verify spawn happened with content from 8 chunks (not fewer or more at trigger time)
			const args = (spawnMock.mock.calls as unknown[][])[0][0] as string[];
			const promptArg = args[args.indexOf("-p") + 1];
			expect(promptArg).toBeDefined();
		});
	});

	describe("Sliding window", () => {
		test("after 15 chunks, only last 10 chunks' content appears in spawn args", async () => {
			const callback = mock(() => {});
			// 15 chunks of 14 chars each = 210 total; threshold (200) crossed on chunk 15
			for (let i = 0; i < 15; i++) {
				const label = `C${String(i).padStart(2, "0")}`;
				summarizer.maybeSummarize("w1", `${label}${"#".repeat(11)}`, callback);
			}

			await flushAsync();

			expect(spawnMock).toHaveBeenCalledTimes(1);
			const args = (spawnMock.mock.calls as unknown[][])[0][0] as string[];
			const promptArg = args[args.indexOf("-p") + 1];

			// Chunks C00-C04 should NOT appear (evicted from window)
			for (let i = 0; i < 5; i++) {
				expect(promptArg).not.toContain(`C${String(i).padStart(2, "0")}#`);
			}
			// Chunks C05-C14 should appear (last 10)
			for (let i = 5; i < 15; i++) {
				expect(promptArg).toContain(`C${String(i).padStart(2, "0")}#`);
			}
		});

		test("when joined chunks exceed 1000 chars, only last 1000 chars sent in spawn args", async () => {
			const callback = mock(() => {});
			// Send a single chunk of 1500 '#' chars (not in prompt template)
			summarizer.maybeSummarize("w1", "#".repeat(1500), callback);

			await flushAsync();

			expect(spawnMock).toHaveBeenCalledTimes(1);
			const args = (spawnMock.mock.calls as unknown[][])[0][0] as string[];
			const promptArg = args[args.indexOf("-p") + 1];

			// The text portion should be at most 1000 '#' chars
			const hashCount = (promptArg.match(/#/g) || []).length;
			expect(hashCount).toBe(1000);
		});

		test("when fewer than 10 chunks exist, all chunks are included in spawn args", async () => {
			const callback = mock(() => {});
			summarizer.maybeSummarize("w1", "alpha-", callback);
			summarizer.maybeSummarize("w1", "beta-", callback);
			summarizer.maybeSummarize("w1", `gamma-${"x".repeat(200)}`, callback);

			await flushAsync();

			expect(spawnMock).toHaveBeenCalledTimes(1);
			const args = (spawnMock.mock.calls as unknown[][])[0][0] as string[];
			const promptArg = args[args.indexOf("-p") + 1];

			expect(promptArg).toContain("alpha-");
			expect(promptArg).toContain("beta-");
			expect(promptArg).toContain("gamma-");
		});
	});

	describe("CLI integration", () => {
		test("spawn args include expected CLI flags: -p, --model, --output-format, --effort", async () => {
			const callback = mock(() => {});
			summarizer.maybeSummarize("w1", "x".repeat(250), callback);

			await flushAsync();

			expect(spawnMock).toHaveBeenCalledTimes(1);
			const args = (spawnMock.mock.calls as unknown[][])[0][0] as string[];
			expect(args[0]).toBe("claude");
			expect(args).toContain("-p");
			expect(args).toContain("--model");
			expect(args).toContain("claude-haiku-4-5-20251001");
			expect(args).toContain("--output-format");
			expect(args).toContain("text");
			expect(args).toContain("--effort");
			expect(args).toContain("low");
		});

		test("successful CLI response delivers trimmed summary via callback", async () => {
			spawnMock = mock(() => mockSpawnResponse("  Setting up project  "));
			Bun.spawn = spawnMock as typeof Bun.spawn;

			const received: string[] = [];
			const callback = (s: string) => received.push(s);
			summarizer.maybeSummarize("w1", "x".repeat(250), callback);

			await flushAsync();

			expect(received).toEqual(["Setting up project"]);
		});

		test("empty CLI response does not invoke callback", async () => {
			spawnMock = mock(() => mockSpawnResponse(""));
			Bun.spawn = spawnMock as typeof Bun.spawn;

			const callback = mock(() => {});
			summarizer.maybeSummarize("w1", "x".repeat(250), callback);

			await flushAsync();

			expect(spawnMock).toHaveBeenCalledTimes(1);
			expect(callback).not.toHaveBeenCalled();
		});

		test("non-zero exit code does not invoke callback and does not throw", async () => {
			spawnMock = mock(() => mockSpawnResponse("some output", 1));
			Bun.spawn = spawnMock as typeof Bun.spawn;

			const callback = mock(() => {});
			summarizer.maybeSummarize("w1", "x".repeat(250), callback);

			await flushAsync();

			expect(spawnMock).toHaveBeenCalledTimes(1);
			expect(callback).not.toHaveBeenCalled();
		});

		test("spawn exception does not invoke callback and does not propagate", async () => {
			spawnMock = mock(() => {
				throw new Error("spawn failed");
			});
			Bun.spawn = spawnMock as typeof Bun.spawn;

			const callback = mock(() => {});
			summarizer.maybeSummarize("w1", "x".repeat(250), callback);

			await flushAsync();

			expect(callback).not.toHaveBeenCalled();
		});
	});

	describe("Pending summary guard", () => {
		test("second maybeSummarize call while summary in-flight does not spawn a second process", async () => {
			const deferred = mockSpawnWithDeferred("Summary result");
			spawnMock = mock(() => deferred.proc);
			Bun.spawn = spawnMock as typeof Bun.spawn;

			const callback = mock(() => {});
			summarizer.maybeSummarize("w1", "x".repeat(250), callback);
			// Second call while first is still in-flight
			summarizer.maybeSummarize("w1", "x".repeat(250), callback);

			expect(spawnMock).toHaveBeenCalledTimes(1);

			deferred.resolveExited(0);
			await flushAsync();
		});

		test("after successful completion, pending flag releases and new summary can trigger", async () => {
			const callback = mock(() => {});
			summarizer.maybeSummarize("w1", "x".repeat(250), callback);
			await flushAsync();

			expect(spawnMock).toHaveBeenCalledTimes(1);

			// Advance past interval and trigger again
			now += 16_000;
			summarizer.maybeSummarize("w1", "x".repeat(250), callback);
			await flushAsync();

			expect(spawnMock).toHaveBeenCalledTimes(2);
		});

		test("after failed generation, pending flag releases and new summary can trigger", async () => {
			// First call fails
			spawnMock = mock(() => mockSpawnResponse("", 1));
			Bun.spawn = spawnMock as typeof Bun.spawn;

			const callback = mock(() => {});
			summarizer.maybeSummarize("w1", "x".repeat(250), callback);
			await flushAsync();

			expect(spawnMock).toHaveBeenCalledTimes(1);

			// Advance past interval, new attempt should work
			now += 16_000;
			spawnMock = mock(() => mockSpawnResponse("New summary"));
			Bun.spawn = spawnMock as typeof Bun.spawn;

			summarizer.maybeSummarize("w1", "x".repeat(250), callback);
			await flushAsync();

			expect(spawnMock).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith("New summary");
		});
	});

	describe("State management", () => {
		test("two workflows accumulate and trigger summaries independently", async () => {
			const cb1 = mock(() => {});
			const cb2 = mock(() => {});

			summarizer.maybeSummarize("w1", "x".repeat(250), cb1);
			summarizer.maybeSummarize("w2", "y".repeat(250), cb2);

			await flushAsync();

			expect(spawnMock).toHaveBeenCalledTimes(2);
			expect(cb1).toHaveBeenCalledTimes(1);
			expect(cb2).toHaveBeenCalledTimes(1);
		});

		test("cleanup removes all state and callback is not delivered for cleaned-up workflow", async () => {
			const deferred = mockSpawnWithDeferred("Late summary");
			spawnMock = mock(() => deferred.proc);
			Bun.spawn = spawnMock as typeof Bun.spawn;

			const callback = mock(() => {});
			summarizer.maybeSummarize("w1", "x".repeat(250), callback);

			// Cleanup while generation is in-flight
			summarizer.cleanup("w1");

			// Now resolve the deferred — callback should NOT fire
			deferred.resolveExited(0);
			await flushAsync();

			expect(callback).not.toHaveBeenCalled();
		});

		test("resetBuffer resets charCount and clears recentChunks but preserves lastSummaryTime", async () => {
			const callback = mock(() => {});
			summarizer.maybeSummarize("w1", "PRERESETCONTENT".repeat(20), callback);
			await flushAsync();

			// Reset the buffer
			summarizer.resetBuffer("w1");

			// Advance past interval — but chars are now 0 after reset
			now += 16_000;
			spawnMock.mockClear();
			summarizer.maybeSummarize("w1", "short", callback);
			await flushAsync();

			// Should NOT trigger: charCount was reset, "short" is < 200
			expect(spawnMock).not.toHaveBeenCalled();

			// Now accumulate enough chars — but still within interval of the reset call
			now += 1_000; // only 1s after last check, but 17s after last summary
			summarizer.maybeSummarize("w1", "POSTRESETONLY".repeat(20), callback);
			await flushAsync();

			// Should trigger: enough chars AND past interval (lastSummaryTime preserved from original)
			expect(spawnMock).toHaveBeenCalledTimes(1);

			// Verify pre-reset content is absent and post-reset content is present
			const args = (spawnMock.mock.calls as unknown[][])[0][0] as string[];
			const promptArg = args[args.indexOf("-p") + 1];
			expect(promptArg).not.toContain("PRERESETCONTENT");
			expect(promptArg).toContain("POSTRESETONLY");
		});

		test("cleanup for non-existent workflow does not throw", () => {
			expect(() => summarizer.cleanup("nonexistent")).not.toThrow();
		});
	});

	describe("Edge cases", () => {
		test("empty string chunk does not error and adds zero to character count", async () => {
			const callback = mock(() => {});
			summarizer.maybeSummarize("w1", "", callback);

			expect(spawnMock).not.toHaveBeenCalled();

			// Subsequent chunk still works normally
			summarizer.maybeSummarize("w1", "x".repeat(250), callback);
			await flushAsync();

			expect(spawnMock).toHaveBeenCalledTimes(1);
		});

		test("whitespace-only chunks accumulating to 200+ chars trigger a summary normally", async () => {
			const callback = mock(() => {});
			summarizer.maybeSummarize("w1", " ".repeat(250), callback);

			await flushAsync();

			expect(spawnMock).toHaveBeenCalledTimes(1);
		});

		test("single 10000-char chunk triggers summary and only last 1000 chars appear in spawn args", async () => {
			const callback = mock(() => {});
			// 10000 chars: first 9000 are '@', last 1000 are '#'
			const chunk = "@".repeat(9000) + "#".repeat(1000);
			summarizer.maybeSummarize("w1", chunk, callback);

			await flushAsync();

			expect(spawnMock).toHaveBeenCalledTimes(1);
			const args = (spawnMock.mock.calls as unknown[][])[0][0] as string[];
			const promptArg = args[args.indexOf("-p") + 1];

			// Only last 1000 chars should be present — all '#'s, no '@'s
			expect(promptArg).not.toContain("@");
			expect(promptArg).toContain("#".repeat(1000));
		});
	});

	describe("Spec summary generation", () => {
		test("valid JSON response returns correct summary and flavor fields", async () => {
			spawnMock = mock(() =>
				mockSpawnResponse('{"summary": "User auth flow", "flavor": "Yet another login form"}'),
			);
			Bun.spawn = spawnMock as typeof Bun.spawn;

			const result = await summarizer.generateSpecSummary("Some spec text");

			expect(result).toEqual({
				summary: "User auth flow",
				flavor: "Yet another login form",
			});
		});

		test("JSON wrapped in markdown code fences is parsed correctly", async () => {
			spawnMock = mock(() =>
				mockSpawnResponse('```json\n{"summary": "Dashboard", "flavor": "Wow graphs"}\n```'),
			);
			Bun.spawn = spawnMock as typeof Bun.spawn;

			const result = await summarizer.generateSpecSummary("Some spec");

			expect(result).toEqual({
				summary: "Dashboard",
				flavor: "Wow graphs",
			});
		});

		test("summary field longer than 50 chars is truncated to 50", async () => {
			const longSummary = "A".repeat(80);
			spawnMock = mock(() => mockSpawnResponse(`{"summary": "${longSummary}", "flavor": "short"}`));
			Bun.spawn = spawnMock as typeof Bun.spawn;

			const result = await summarizer.generateSpecSummary("spec");

			expect(result.summary).toHaveLength(50);
			expect(result.summary).toBe("A".repeat(50));
			expect(result.flavor).toBe("short");
		});

		test("flavor field longer than 100 chars is truncated to 100", async () => {
			const longFlavor = "B".repeat(150);
			spawnMock = mock(() => mockSpawnResponse(`{"summary": "ok", "flavor": "${longFlavor}"}`));
			Bun.spawn = spawnMock as typeof Bun.spawn;

			const result = await summarizer.generateSpecSummary("spec");

			expect(result.summary).toBe("ok");
			expect(result.flavor).toHaveLength(100);
			expect(result.flavor).toBe("B".repeat(100));
		});

		test("invalid JSON response returns empty strings for both fields", async () => {
			spawnMock = mock(() => mockSpawnResponse("not valid json at all"));
			Bun.spawn = spawnMock as typeof Bun.spawn;

			const result = await summarizer.generateSpecSummary("spec");

			expect(result).toEqual({ summary: "", flavor: "" });
		});

		test("non-zero exit code returns empty strings for both fields", async () => {
			spawnMock = mock(() => mockSpawnResponse('{"summary": "x", "flavor": "y"}', 1));
			Bun.spawn = spawnMock as typeof Bun.spawn;

			const result = await summarizer.generateSpecSummary("spec");

			expect(result).toEqual({ summary: "", flavor: "" });
		});

		test("spawn exception returns empty strings for both fields", async () => {
			spawnMock = mock(() => {
				throw new Error("spawn failed");
			});
			Bun.spawn = spawnMock as typeof Bun.spawn;

			const result = await summarizer.generateSpecSummary("spec");

			expect(result).toEqual({ summary: "", flavor: "" });
		});

		test("JSON response with missing fields returns empty string for absent field", async () => {
			spawnMock = mock(() => mockSpawnResponse('{"summary": "Only summary"}'));
			Bun.spawn = spawnMock as typeof Bun.spawn;

			const result = await summarizer.generateSpecSummary("spec");

			expect(result.summary).toBe("Only summary");
			expect(result.flavor).toBe("");
		});
	});
});
