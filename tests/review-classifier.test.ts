import { afterEach, describe, expect, mock, test } from "bun:test";
import { ReviewClassifier } from "../src/review-classifier";

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

describe("ReviewClassifier", () => {
	let classifier: ReviewClassifier;
	let spawnMock: ReturnType<typeof mock>;

	afterEach(() => {
		Bun.spawn = originalSpawn;
	});

	test("classifies review output as minor", async () => {
		spawnMock = mock(() => mockSpawnResponse("minor"));
		Bun.spawn = spawnMock as typeof Bun.spawn;
		classifier = new ReviewClassifier();
		const result = await classifier.classify("Some minor style issues found.");
		expect(result).toBe("minor");
	});

	test("classifies review output as critical", async () => {
		spawnMock = mock(() => mockSpawnResponse("critical"));
		Bun.spawn = spawnMock as typeof Bun.spawn;
		classifier = new ReviewClassifier();
		const result = await classifier.classify("Security vulnerability: SQL injection in login.");
		expect(result).toBe("critical");
	});

	test("classifies review output as major", async () => {
		spawnMock = mock(() => mockSpawnResponse("major"));
		Bun.spawn = spawnMock as typeof Bun.spawn;
		classifier = new ReviewClassifier();
		const result = await classifier.classify("Missing error handling in critical path.");
		expect(result).toBe("major");
	});

	test("classifies review output as trivial", async () => {
		spawnMock = mock(() => mockSpawnResponse("trivial"));
		Bun.spawn = spawnMock as typeof Bun.spawn;
		classifier = new ReviewClassifier();
		const result = await classifier.classify("Whitespace inconsistency.");
		expect(result).toBe("trivial");
	});

	test("classifies review output as nit", async () => {
		spawnMock = mock(() => mockSpawnResponse("nit"));
		Bun.spawn = spawnMock as typeof Bun.spawn;
		classifier = new ReviewClassifier();
		const result = await classifier.classify("Consider renaming variable for clarity.");
		expect(result).toBe("nit");
	});

	test("handles unexpected response by defaulting to minor", async () => {
		spawnMock = mock(() => mockSpawnResponse("unknown-severity"));
		Bun.spawn = spawnMock as typeof Bun.spawn;
		classifier = new ReviewClassifier();
		const result = await classifier.classify("Some review output.");
		expect(result).toBe("minor");
	});

	test("defaults to minor on non-zero exit code", async () => {
		spawnMock = mock(() => mockSpawnResponse("", 1));
		Bun.spawn = spawnMock as typeof Bun.spawn;
		classifier = new ReviewClassifier();
		const result = await classifier.classify("Some review output.");
		expect(result).toBe("minor");
	});

	test("passes review output to claude CLI with haiku model", async () => {
		spawnMock = mock(() => mockSpawnResponse("minor"));
		Bun.spawn = spawnMock as typeof Bun.spawn;
		classifier = new ReviewClassifier();
		await classifier.classify("Test review output");

		expect(spawnMock).toHaveBeenCalledTimes(1);
		const args = (spawnMock.mock.calls as unknown[][])[0][0] as string[];
		expect(args).toContain("claude");
		expect(args).toContain("--model");
		expect(args).toContain("claude-haiku-4-5-20251001");
		expect(args[2]).toContain("Test review output");
	});
});
