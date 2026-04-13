import { describe, expect, test } from "bun:test";
import { buildFeedbackContext } from "../src/feedback-injector";
import type { FeedbackEntry } from "../src/types";
import { makeWorkflow } from "./helpers";

function entry(overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
	return {
		id: overrides.id ?? "fe-1",
		iteration: overrides.iteration ?? 1,
		text: overrides.text ?? "rename x to count",
		submittedAt: overrides.submittedAt ?? "2026-04-13T14:22:01.000Z",
		submittedAtStepName: overrides.submittedAtStepName ?? "merge-pr",
		outcome: overrides.outcome === undefined ? null : overrides.outcome,
	};
}

describe("buildFeedbackContext", () => {
	test("returns empty string when no feedback has been submitted", () => {
		const wf = makeWorkflow();
		expect(buildFeedbackContext(wf)).toBe("");
	});

	test("emits authoritative-override label block for a single success entry", () => {
		const wf = makeWorkflow();
		wf.feedbackEntries = [
			entry({
				iteration: 1,
				text: "rename x to count",
				submittedAt: "2026-04-13T14:22:01.000Z",
				outcome: {
					value: "success",
					summary: "renamed x to count",
					commitRefs: ["abc1234"],
					warnings: [],
				},
			}),
		];

		const out = buildFeedbackContext(wf);

		expect(out).toContain("USER FEEDBACK");
		expect(out).toContain("authoritative");
		expect(out).toMatch(/overrides? spec\/plan/i);
		expect(out).toContain("Iteration 1");
		expect(out).toContain("2026-04-13T14:22:01.000Z");
		expect(out).toContain("merge-pr");
		expect(out).toContain("success");
		expect(out).toContain("rename x to count");
	});

	test("preserves submission order across multiple entries", () => {
		const wf = makeWorkflow();
		wf.feedbackEntries = [
			entry({
				id: "fe-1",
				iteration: 1,
				text: "first feedback",
				outcome: {
					value: "success",
					summary: "s1",
					commitRefs: ["abc"],
					warnings: [],
				},
			}),
			entry({
				id: "fe-2",
				iteration: 2,
				text: "second feedback",
				outcome: {
					value: "no changes",
					summary: "nothing to do",
					commitRefs: [],
					warnings: [],
				},
			}),
		];

		const out = buildFeedbackContext(wf);
		const idxFirst = out.indexOf("first feedback");
		const idxSecond = out.indexOf("second feedback");

		expect(idxFirst).toBeGreaterThanOrEqual(0);
		expect(idxSecond).toBeGreaterThan(idxFirst);
		expect(out).toContain("Iteration 2");
	});

	test("labels non-success outcomes with their outcome value", () => {
		const wf = makeWorkflow();
		wf.feedbackEntries = [
			entry({
				iteration: 1,
				text: "no-op",
				outcome: {
					value: "no changes",
					summary: "nothing needed",
					commitRefs: [],
					warnings: [],
				},
			}),
			entry({
				id: "fe-2",
				iteration: 2,
				text: "impossible",
				outcome: {
					value: "failed",
					summary: "contradictory",
					commitRefs: [],
					warnings: [],
				},
			}),
			entry({
				id: "fe-3",
				iteration: 3,
				text: "aborted",
				outcome: {
					value: "cancelled",
					summary: "user abort",
					commitRefs: [],
					warnings: [],
				},
			}),
		];

		const out = buildFeedbackContext(wf);

		expect(out).toContain("no changes");
		expect(out).toContain("failed");
		expect(out).toContain("cancelled");
	});

	test("emits a placeholder label for in-flight entries (null outcome)", () => {
		const wf = makeWorkflow();
		wf.feedbackEntries = [entry({ iteration: 1, text: "running now", outcome: null })];
		const out = buildFeedbackContext(wf);
		expect(out).toContain("Iteration 1");
		expect(out).toContain("running now");
	});

	test("label explicitly positions feedback as overriding spec/plan (FR-011, SC-007)", () => {
		const wf = makeWorkflow();
		wf.feedbackEntries = [
			entry({
				iteration: 1,
				text: "use XMLHttpRequest instead of fetch",
				outcome: {
					value: "success",
					summary: "switched",
					commitRefs: ["abc"],
					warnings: [],
				},
			}),
		];

		const out = buildFeedbackContext(wf);
		// The label must literally assert authority over spec/plan content
		expect(out.toLowerCase()).toContain("authoritative");
		expect(out).toMatch(/overrides? spec\/plan/i);
	});
});
