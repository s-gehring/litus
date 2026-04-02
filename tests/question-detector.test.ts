import { beforeEach, describe, expect, mock, test } from "bun:test";
import { QuestionDetector } from "../src/question-detector";

// Mock the Anthropic SDK for classifyWithHaiku tests
const mockCreate = mock(() =>
	Promise.resolve({
		content: [{ type: "text" as const, text: "yes" }],
	}),
);

mock.module("@anthropic-ai/sdk", () => ({
	default: class MockAnthropic {
		messages = { create: mockCreate };
	},
}));

describe("QuestionDetector", () => {
	let detector: QuestionDetector;

	beforeEach(() => {
		detector = new QuestionDetector();
		mockCreate.mockClear();
	});

	describe("certain question detection", () => {
		test("detects 'Should I use X?' pattern", () => {
			const q = detector.detect("Should I use Tailwind CSS for this project?");
			expect(q).not.toBeNull();
			expect(q?.confidence).toBe("certain");
			expect(q?.content).toContain("Should I use");
		});

		test("detects 'Would we like X?' pattern", () => {
			const q = detector.detect("Would we like to add authentication here?");
			expect(q).not.toBeNull();
			expect(q?.confidence).toBe("certain");
		});

		test("detects 'please choose' pattern", () => {
			const q = detector.detect("Please choose between option A and option B");
			expect(q).not.toBeNull();
			expect(q?.confidence).toBe("certain");
		});

		test("detects 'please select' pattern", () => {
			const q = detector.detect("Please select your preferred approach");
			expect(q).not.toBeNull();
			expect(q?.confidence).toBe("certain");
		});

		test("detects 'Which do you prefer?' pattern", () => {
			const q = detector.detect("Which approach would you prefer?");
			expect(q).not.toBeNull();
			expect(q?.confidence).toBe("certain");
		});

		test("detects 'Could I use X?' pattern", () => {
			const q = detector.detect("Could I use a different database here?");
			expect(q).not.toBeNull();
			expect(q?.confidence).toBe("certain");
		});
	});

	describe("uncertain question detection", () => {
		test("detects text ending with question mark", () => {
			const q = detector.detect("Is this the right approach for handling errors?");
			expect(q).not.toBeNull();
			expect(q?.confidence).toBe("uncertain");
		});

		test("detects 'let me know' pattern", () => {
			const q = detector.detect("Let me know if you want me to proceed differently");
			expect(q).not.toBeNull();
			expect(q?.confidence).toBe("uncertain");
		});

		test("detects 'what do you think' pattern", () => {
			const q = detector.detect("I've structured it this way, what do you think about it");
			expect(q).not.toBeNull();
			expect(q?.confidence).toBe("uncertain");
		});

		test("detects 'any preference' pattern", () => {
			const q = detector.detect("Do you have any preference on naming conventions");
			expect(q).not.toBeNull();
			expect(q?.confidence).toBe("uncertain");
		});
	});

	describe("non-question exclusions", () => {
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
			expect(q?.confidence).toBe("certain");
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
		test("returns true when Haiku confirms a question", async () => {
			mockCreate.mockImplementationOnce(() =>
				Promise.resolve({ content: [{ type: "text" as const, text: "yes" }] }),
			);

			const result = await detector.classifyWithHaiku("Should I use Tailwind?");
			expect(result).toBe(true);

			expect(mockCreate).toHaveBeenCalledTimes(1);
			const callArgs = (mockCreate.mock.calls as any[][])[0][0];
			expect(callArgs.model).toBe("claude-haiku-4-5-20251001");
			expect(callArgs.max_tokens).toBe(10);
		});

		test("returns false when Haiku rejects a question", async () => {
			mockCreate.mockImplementationOnce(() =>
				Promise.resolve({ content: [{ type: "text" as const, text: "no" }] }),
			);

			const result = await detector.classifyWithHaiku("Looking at the code, this seems fine");
			expect(result).toBe(false);
		});

		test("returns false on API error", async () => {
			mockCreate.mockImplementationOnce(() => Promise.reject(new Error("API error")));

			const result = await detector.classifyWithHaiku("Should I use X?");
			expect(result).toBe(false);
		});

		test("prevents concurrent classifications", async () => {
			// Create a deferred promise to control when the first call resolves
			let resolveFirst!: (value: any) => void;
			mockCreate.mockImplementationOnce(
				() =>
					new Promise((r) => {
						resolveFirst = r;
					}),
			);

			const promise1 = detector.classifyWithHaiku("Question 1?");
			const promise2 = detector.classifyWithHaiku("Question 2?");

			// Second call should return false immediately because first is pending
			expect(await promise2).toBe(false);

			// Resolve the first call
			resolveFirst({ content: [{ type: "text", text: "yes" }] });
			expect(await promise1).toBe(true);

			// Only one API call was made
			expect(mockCreate).toHaveBeenCalledTimes(1);
		});
	});
});
