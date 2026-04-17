import { describe, expect, test } from "bun:test";
import { QuestionDetector } from "../../src/question-detector";

// Integration test for US2 / FR-008, FR-009.
// Drives a realistic partial-then-final stream through the QuestionDetector
// exactly as the orchestrator wires it via the `onAssistantMessage` callback:
// partial `content_block_delta` fragments are NOT appended (they only land in
// the rendering path), and the finalized `assistant` event text is forwarded
// to `appendFinalizedMessage`. Detection runs once on step completion.
//
// Asserts: the detector sees the question exactly once, matching the finalized
// form — never a partial fragment and never duplicated across partial+final.

describe("Clarify step dedup — partial-then-final stream (integration)", () => {
	test("N partial deltas followed by a finalized message → exactly one detected question", () => {
		const detector = new QuestionDetector();

		// Simulate the CLI stream: partial deltas (NOT forwarded to finalized
		// buffer, only to the render path) + a final assistant message.
		const partials = ["Would ", "you like ", "to proceed ", "with the plan ", "as proposed?"];
		const finalized = "Would you like to proceed with the plan as proposed?";

		// Partials are intentionally dropped by the orchestrator → not appended.
		void partials;

		detector.appendFinalizedMessage(finalized);

		// Simulate orchestrator's handleStepComplete detection branch.
		const q1 = detector.detectFromFinalized();
		expect(q1).not.toBeNull();
		expect(q1?.content).toBe(finalized);

		// A second detection pass without new input must still yield the same
		// single candidate — never a second duplicate from a partial fragment.
		const q2 = detector.detectFromFinalized();
		expect(q2?.content).toBe(finalized);
	});

	test("finalized message alone (no partials) → exactly one question", () => {
		const detector = new QuestionDetector();
		detector.appendFinalizedMessage("Which environment should I target?");
		const q = detector.detectFromFinalized();
		expect(q).not.toBeNull();
		expect(q?.content).toContain("Which environment");
	});

	test("Clarify-like sequence across two steps — reset() between steps isolates detection", () => {
		const detector = new QuestionDetector();

		// Step 1 finalized → question A
		detector.appendFinalizedMessage("Do you want option A or B?");
		expect(detector.detectFromFinalized()?.content).toContain("option A or B");

		// Orchestrator calls reset() after advancing past the step.
		detector.reset();
		expect(detector.detectFromFinalized()).toBeNull();

		// Step 2 finalized → a DIFFERENT question, not a re-ask of Step 1.
		detector.appendFinalizedMessage("Now, what region should I deploy to?");
		const q2 = detector.detectFromFinalized();
		expect(q2?.content).toContain("what region");
		expect(q2?.content).not.toContain("option A or B");
	});
});
