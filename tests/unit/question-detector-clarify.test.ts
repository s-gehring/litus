import { describe, expect, test } from "bun:test";
import { QuestionDetector } from "../../src/question-detector";

describe("QuestionDetector finalized-only mode (FR-008, FR-009)", () => {
	test("partial-only messages (never appended as finalized) yield no detection", () => {
		const detector = new QuestionDetector();
		// Simulate the orchestrator NOT forwarding partial deltas into the
		// finalized buffer — only an `assistant` event would do so.
		expect(detector.detectFromFinalized()).toBeNull();
	});

	test("finalized question message yields exactly one detected candidate", () => {
		const detector = new QuestionDetector();
		detector.appendFinalizedMessage("Which option would you like to choose?");

		const q = detector.detectFromFinalized();
		expect(q).not.toBeNull();
		expect(q?.content).toContain("Which option");
	});

	test("partial-then-final sequence still yields exactly one, matching the finalized form", () => {
		const detector = new QuestionDetector();
		// Partials are intentionally NOT appended (mirrors orchestrator wiring
		// that only forwards `assistant` events). The final message alone
		// drives detection, so the text seen by the classifier is exactly the
		// finalized form — never a partial fragment and never duplicated.
		detector.appendFinalizedMessage("Do you want to proceed?");

		const q = detector.detectFromFinalized();
		expect(q).not.toBeNull();
		expect(q?.content).toBe("Do you want to proceed?");
	});

	test("reset() clears the finalized buffer so a new step starts fresh", () => {
		const detector = new QuestionDetector();
		detector.appendFinalizedMessage("Which option do you prefer?");
		expect(detector.detectFromFinalized()).not.toBeNull();

		detector.reset();
		expect(detector.detectFromFinalized()).toBeNull();
	});

	test("finalized buffer survives multi-message accumulation and uses the last block", () => {
		const detector = new QuestionDetector();
		detector.appendFinalizedMessage("Running some setup steps.");
		detector.appendFinalizedMessage("---");
		detector.appendFinalizedMessage("Which environment should I deploy to?");

		const q = detector.detectFromFinalized();
		expect(q).not.toBeNull();
		expect(q?.content).toContain("Which environment");
	});
});
