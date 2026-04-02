import { afterEach, describe, expect, mock, test } from "bun:test";
import { ReviewClassifier } from "../src/review-classifier";

// Mock the Anthropic SDK
const mockCreate = mock(() =>
	Promise.resolve({
		content: [{ type: "text" as const, text: "minor" }],
	}),
);

mock.module("@anthropic-ai/sdk", () => ({
	default: class MockAnthropic {
		messages = { create: mockCreate };
	},
}));

describe("ReviewClassifier", () => {
	let classifier: ReviewClassifier;

	afterEach(() => {
		mockCreate.mockClear();
	});

	test("classifies review output as minor", async () => {
		mockCreate.mockResolvedValueOnce({
			content: [{ type: "text" as const, text: "minor" }],
		});
		classifier = new ReviewClassifier();
		const result = await classifier.classify("Some minor style issues found.");
		expect(result).toBe("minor");
	});

	test("classifies review output as critical", async () => {
		mockCreate.mockResolvedValueOnce({
			content: [{ type: "text" as const, text: "critical" }],
		});
		classifier = new ReviewClassifier();
		const result = await classifier.classify("Security vulnerability: SQL injection in login.");
		expect(result).toBe("critical");
	});

	test("classifies review output as major", async () => {
		mockCreate.mockResolvedValueOnce({
			content: [{ type: "text" as const, text: "major" }],
		});
		classifier = new ReviewClassifier();
		const result = await classifier.classify("Missing error handling in critical path.");
		expect(result).toBe("major");
	});

	test("classifies review output as trivial", async () => {
		mockCreate.mockResolvedValueOnce({
			content: [{ type: "text" as const, text: "trivial" }],
		});
		classifier = new ReviewClassifier();
		const result = await classifier.classify("Whitespace inconsistency.");
		expect(result).toBe("trivial");
	});

	test("classifies review output as nit", async () => {
		mockCreate.mockResolvedValueOnce({
			content: [{ type: "text" as const, text: "nit" }],
		});
		classifier = new ReviewClassifier();
		const result = await classifier.classify("Consider renaming variable for clarity.");
		expect(result).toBe("nit");
	});

	test("handles unexpected response by defaulting to minor", async () => {
		mockCreate.mockResolvedValueOnce({
			content: [{ type: "text" as const, text: "unknown-severity" }],
		});
		classifier = new ReviewClassifier();
		const result = await classifier.classify("Some review output.");
		expect(result).toBe("minor");
	});

	test("sends review output to Haiku model", async () => {
		mockCreate.mockResolvedValueOnce({
			content: [{ type: "text" as const, text: "minor" }],
		});
		classifier = new ReviewClassifier();
		await classifier.classify("Test review output");

		expect(mockCreate).toHaveBeenCalledTimes(1);
		const callArgs = mockCreate.mock.calls[0][0] as {
			model: string;
			max_tokens: number;
			messages: Array<{ role: string; content: string }>;
		};
		expect(callArgs.model).toBe("claude-haiku-4-5-20251001");
		expect(callArgs.messages[0].content).toContain("Test review output");
	});
});
