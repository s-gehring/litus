import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QuestionDetector } from "../src/question-detector";

const originalSpawn = Bun.spawn;

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

describe("QuestionDetector", () => {
	let detector: QuestionDetector;
	let spawnMock: ReturnType<typeof mock>;

	beforeEach(() => {
		detector = new QuestionDetector();
		spawnMock = mock(() => mockSpawnResponse("yes"));
		Bun.spawn = spawnMock as typeof Bun.spawn;
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
	});

	describe("pre-filter: passes plausible question candidates", () => {
		test("passes direct question", () => {
			const q = detector.detect("Should I use Tailwind CSS for this project?");
			expect(q).not.toBeNull();
			expect(q?.content).toContain("Should I use");
		});

		test("passes multi-choice prompt without question mark", () => {
			const q = detector.detect(
				'You can reply with the option letter (e.g., "A"), accept the recommendation by saying "yes" or "recommended", or provide your own short answer.',
			);
			expect(q).not.toBeNull();
		});

		test("passes markdown table with options", () => {
			const q = detector.detect(
				"| Option | Description |\n|--------|-------------|\n| A | Use existing logic |\n| B | Clamp to zero |",
			);
			expect(q).not.toBeNull();
		});

		test("passes text ending with question mark", () => {
			const q = detector.detect("Is this the right approach for handling errors?");
			expect(q).not.toBeNull();
		});

		test("passes 'let me know' pattern", () => {
			const q = detector.detect("Let me know if you want me to proceed differently");
			expect(q).not.toBeNull();
		});

		test("passes normal text for Haiku to decide", () => {
			const q = detector.detect("The implementation uses a factory pattern for creating handlers");
			expect(q).not.toBeNull();
		});
	});

	describe("pre-filter: excludes obvious non-questions", () => {
		test("excludes agent narration starting with 'Here's'", () => {
			const q = detector.detect("Here's what I've implemented so far");
			expect(q).toBeNull();
		});

		test("excludes agent narration starting with 'I'll'", () => {
			const q = detector.detect("I'll create the component next");
			expect(q).toBeNull();
		});

		test("excludes agent narration starting with 'Let me'", () => {
			const q = detector.detect("Let me read the file first");
			expect(q).toBeNull();
		});

		test("excludes tool use output", () => {
			const q = detector.detect("[Tool: read_file] reading src/app.ts");
			expect(q).toBeNull();
		});

		test("excludes action descriptions", () => {
			const q = detector.detect("Creating src/components/Button.tsx...");
			expect(q).toBeNull();
		});

		test("excludes empty or very short text", () => {
			expect(detector.detect("")).toBeNull();
			expect(detector.detect("   ")).toBeNull();
			expect(detector.detect("ok")).toBeNull();
		});
	});

	describe("cooldown behavior", () => {
		test("respects cooldown period between detections", () => {
			const q1 = detector.detect("Should I use CSS modules?");
			expect(q1).not.toBeNull();

			// Immediately after, should be on cooldown
			const q2 = detector.detect("Should I also add dark mode?");
			expect(q2).toBeNull();
		});

		test("reset clears cooldown", () => {
			const q1 = detector.detect("Should I use CSS modules?");
			expect(q1).not.toBeNull();

			detector.reset();

			const q2 = detector.detect("Should I also add dark mode?");
			expect(q2).not.toBeNull();
		});
	});

	describe("question structure", () => {
		test("returns a question with all required fields", () => {
			const q = detector.detect("Should I use TypeScript for this?");
			expect(q).not.toBeNull();
			expect(q?.id).toBeTruthy();
			expect(q?.content).toBeTruthy();
			expect(q?.detectedAt).toBeTruthy();
			// Verify detectedAt is a valid ISO date string
			const detectedAt = q?.detectedAt ?? "";
			expect(new Date(detectedAt).toISOString()).toBe(detectedAt);
		});

		test("each detection produces a unique ID", () => {
			const q1 = detector.detect("Should I use X?");
			detector.reset();
			const q2 = detector.detect("Should I use Y?");
			expect(q1?.id).not.toBe(q2?.id);
		});
	});

	describe("classifyWithHaiku", () => {
		test("returns true when CLI confirms a question", async () => {
			spawnMock = mock(() => mockSpawnResponse("yes"));
			Bun.spawn = spawnMock as typeof Bun.spawn;

			const result = await detector.classifyWithHaiku("Should I use Tailwind?");
			expect(result).toBe(true);

			expect(spawnMock).toHaveBeenCalledTimes(1);
			const args = (spawnMock.mock.calls as unknown[][])[0][0] as string[];
			expect(args).toContain("--model");
			expect(args).toContain("claude-haiku-4-5-20251001");
		});

		test("returns false when CLI rejects a question", async () => {
			spawnMock = mock(() => mockSpawnResponse("no"));
			Bun.spawn = spawnMock as typeof Bun.spawn;

			const result = await detector.classifyWithHaiku("Looking at the code, this seems fine");
			expect(result).toBe(false);
		});

		test("returns false on non-zero exit code", async () => {
			spawnMock = mock(() => mockSpawnResponse("", 1));
			Bun.spawn = spawnMock as typeof Bun.spawn;

			const result = await detector.classifyWithHaiku("Should I use X?");
			expect(result).toBe(false);
		});

		test("prevents concurrent classifications", async () => {
			let resolveFirst!: (value: number) => void;
			const firstStream = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("yes"));
					controller.close();
				},
			});
			spawnMock = mock(() => ({
				stdout: firstStream,
				stderr: new ReadableStream({
					start(c) {
						c.close();
					},
				}),
				exited: new Promise<number>((r) => {
					resolveFirst = r;
				}),
				pid: 1,
				kill: () => {},
			}));
			Bun.spawn = spawnMock as typeof Bun.spawn;

			const promise1 = detector.classifyWithHaiku("Question 1?");
			const promise2 = detector.classifyWithHaiku("Question 2?");

			// Second call should return false immediately because first is pending
			expect(await promise2).toBe(false);

			// Resolve the first call
			resolveFirst(0);
			expect(await promise1).toBe(true);

			// Only one spawn call was made
			expect(spawnMock).toHaveBeenCalledTimes(1);
		});
	});
});
