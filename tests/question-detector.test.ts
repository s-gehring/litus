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

	// T003: Positive-case pre-filter tests
	describe("pre-filter: passes text with question indicators", () => {
		test("passes text with question mark", () => {
			const q = detector.detect("Should I use Tailwind CSS for this project?");
			expect(q).not.toBeNull();
			expect(q?.content).toContain("Should I use");
		});

		test("passes text with option table (pipe characters)", () => {
			const q = detector.detect(
				"| Option | Description |\n|--------|-------------|\n| A | Use existing logic |\n| B | Clamp to zero |",
			);
			expect(q).not.toBeNull();
		});

		test("passes text with 'reply with' phrase", () => {
			const q = detector.detect(
				'You can reply with the option letter (e.g., "A"), accept the recommendation by saying "yes".',
			);
			expect(q).not.toBeNull();
		});

		test("passes text with 'choose' phrase", () => {
			const q = detector.detect(
				"Please choose one of the following approaches for the implementation",
			);
			expect(q).not.toBeNull();
		});

		test("passes text with 'select' phrase", () => {
			const q = detector.detect("Select the database engine you want to use for this project");
			expect(q).not.toBeNull();
		});

		test("passes text with 'which option' phrase", () => {
			const q = detector.detect("Which option would you prefer for the deployment strategy");
			expect(q).not.toBeNull();
		});

		test("passes text with 'let me know' phrase", () => {
			const q = detector.detect("Let me know if you want me to proceed differently");
			expect(q).not.toBeNull();
		});

		test("passes text with 'please provide' phrase", () => {
			const q = detector.detect("Please provide the API key for the external service integration");
			expect(q).not.toBeNull();
		});
	});

	// T004: Heading/rule-boundary extraction tests
	describe("heading/rule-boundary extraction", () => {
		test("extracts text after heading boundary", () => {
			const buffer =
				"I analyzed the codebase structure.\n\n" +
				"# Question\n" +
				"Which approach do you prefer for the API design?";

			const q = detector.detect(buffer);
			expect(q).not.toBeNull();
			expect(q?.content).toContain("Which approach do you prefer");
		});

		test("extracts text after horizontal rule (---)", () => {
			const buffer =
				"Here is my analysis of the options.\n\n" +
				"---\n" +
				"Which database would you prefer: PostgreSQL or MongoDB?";

			const q = detector.detect(buffer);
			expect(q).not.toBeNull();
			expect(q?.content).toContain("Which database");
		});

		test("extracts text after horizontal rule (***)", () => {
			const buffer = "Summary of findings.\n\n" + "***\n" + "Should I proceed with this approach?";

			const q = detector.detect(buffer);
			expect(q).not.toBeNull();
			expect(q?.content).toContain("Should I proceed");
		});

		test("extracts text after horizontal rule (___)", () => {
			const buffer =
				"Some analysis text.\n\n" + "___\n" + "Do you want me to continue with option A?";

			const q = detector.detect(buffer);
			expect(q).not.toBeNull();
			expect(q?.content).toContain("option A");
		});

		test("captures multi-paragraph question with option table in full", () => {
			const buffer =
				"I've analyzed the requirements.\n\n" +
				"---\n" +
				"Here are the options:\n\n" +
				"| Option | Description |\n" +
				"|--------|-------------|\n" +
				"| A | Use REST API |\n" +
				"| B | Use GraphQL |\n\n" +
				'Reply with the option letter (e.g., "A").';

			const q = detector.detect(buffer);
			expect(q).not.toBeNull();
			expect(q?.content).toContain("| Option |");
			expect(q?.content).toContain("Reply with");
		});
	});

	// T005: Informational text rejection tests
	describe("pre-filter: rejects purely informational text", () => {
		test("rejects agent narration without question indicators", () => {
			const q = detector.detect("I'll create the component next and set up the routing");
			expect(q).toBeNull();
		});

		test("rejects summary text without question indicators", () => {
			const q = detector.detect(
				"The implementation uses a factory pattern for creating handlers and a strategy pattern for routing",
			);
			expect(q).toBeNull();
		});

		test("rejects action descriptions without question indicators", () => {
			const q = detector.detect("Creating src/components/Button.tsx with the new styling approach");
			expect(q).toBeNull();
		});

		test("rejects empty or very short text", () => {
			expect(detector.detect("")).toBeNull();
			expect(detector.detect("   ")).toBeNull();
			expect(detector.detect("ok")).toBeNull();
		});
	});

	// T008: Cross-step detection tests
	describe("detection works across all LLM-based steps", () => {
		test("detects question from specify step output", () => {
			const specifyOutput =
				"I've drafted the specification.\n\n" +
				"---\n" +
				"Should I include error handling requirements in the spec?";

			const q = detector.detect(specifyOutput);
			expect(q).not.toBeNull();
			expect(q?.content).toContain("error handling requirements");
		});

		test("detects question from plan step output", () => {
			const planOutput =
				"The architecture looks solid.\n\n" +
				"---\n" +
				"Which testing framework do you want to use: Jest or Vitest?";

			const q = detector.detect(planOutput);
			expect(q).not.toBeNull();
			expect(q?.content).toContain("testing framework");
		});

		test("detects question from implement step output", () => {
			const implementOutput =
				"I found a conflict in the dependencies.\n\n" +
				"---\n" +
				"| Option | Description |\n" +
				"|--------|-------------|\n" +
				"| A | Upgrade to v5 |\n" +
				"| B | Stay on v4 |\n\n" +
				"Which option do you prefer?";

			const q = detector.detect(implementOutput);
			expect(q).not.toBeNull();
		});
	});

	// T009: Non-question output from any step does not trigger false detection
	describe("non-question output does not trigger false detection", () => {
		test("informational specify output is not detected", () => {
			const q = detector.detect(
				"I have completed the specification with all required sections and acceptance criteria",
			);
			expect(q).toBeNull();
		});

		test("informational plan output is not detected", () => {
			const q = detector.detect(
				"The implementation plan has been generated with five phases and twelve tasks total",
			);
			expect(q).toBeNull();
		});
	});

	// T010: Buffer reset after answerQuestion
	describe("buffer reset behavior", () => {
		test("reset clears detector state", () => {
			const q1 = detector.detect("Should I use CSS modules?");
			expect(q1).not.toBeNull();

			detector.reset();

			const q2 = detector.detect("Should I also add dark mode?");
			expect(q2).not.toBeNull();
		});
	});

	// T011: Second question detected after first is answered (no cooldown blocking)
	describe("multi-question detection (no cooldown)", () => {
		test("detects second question immediately after first", () => {
			const q1 = detector.detect("Should I use CSS modules?");
			expect(q1).not.toBeNull();

			// Without cooldown, second question should also be detected
			const q2 = detector.detect("Should I also add dark mode?");
			expect(q2).not.toBeNull();
		});

		test("detects follow-up question after reset", () => {
			const q1 = detector.detect("Which database do you prefer?");
			expect(q1).not.toBeNull();

			detector.reset();

			const q2 = detector.detect("What about the caching layer?");
			expect(q2).not.toBeNull();
		});
	});

	describe("last-block extraction for long buffers", () => {
		test("detect processes only the last section of a long assistant buffer", () => {
			const longNarration =
				"I'll start by reading the project structure.\n\n" +
				"Here's the file layout I found:\n- src/\n- tests/\n\n" +
				"---\n" +
				"Should I proceed with React or Vue for the frontend?";

			const q = detector.detect(longNarration);
			expect(q).not.toBeNull();
			expect(q?.content).toContain("Should I proceed with React or Vue");
		});

		test("question after heading is extracted correctly from long buffer", () => {
			const buffer =
				"I analyzed the dependencies and everything looks good.\n\n" +
				"# Decision Needed\n" +
				"Which database would you prefer: PostgreSQL or MongoDB?";

			const q = detector.detect(buffer);
			expect(q).not.toBeNull();
			expect(q?.content).toContain("Which database");
		});

		test("returns null when last section has no question indicators", () => {
			const buffer =
				"Should I use TypeScript for this?\n\n" +
				"---\n" +
				"I completed the implementation and all tests are passing now";

			const q = detector.detect(buffer);
			expect(q).toBeNull();
		});
	});

	describe("question structure", () => {
		test("returns a question with all required fields", () => {
			const q = detector.detect("Should I use TypeScript for this?");
			expect(q).not.toBeNull();
			expect(q?.id).toBeTruthy();
			expect(q?.content).toBeTruthy();
			expect(q?.detectedAt).toBeTruthy();
			const detectedAt = q?.detectedAt ?? "";
			expect(new Date(detectedAt).toISOString()).toBe(detectedAt);
		});

		test("each detection produces a unique ID", () => {
			const q1 = detector.detect("Should I use X?");
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
