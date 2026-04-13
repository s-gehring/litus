import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { updateFeedbackHistorySection } from "../src/client/components/workflow-window";
import type { FeedbackEntry } from "../src/types";

const source = readFileSync(
	resolve(import.meta.dir, "../src/client/components/workflow-window.ts"),
	"utf-8",
);

describe("updateWorkflowStatus null handling", () => {
	test("hides #current-step-label when workflow is null", () => {
		// The function must have an else clause that hides the step label
		// when workflow is null (no steps to show)
		expect(source).toContain('stepLabel.classList.add("hidden")');
		// There should be an else branch after the step label conditional
		// that handles the null/no-steps case
		const stepLabelBlock = source.slice(
			source.indexOf("// Show current step name"),
			source.indexOf("// PR link"),
		);
		expect(stepLabelBlock).toContain("} else");
	});
});

describe("updateFeedbackHistorySection", () => {
	beforeEach(() => {
		document.body.innerHTML = `<div id="workflow-feedback-section" class="hidden"></div>`;
	});
	afterEach(() => {
		document.body.innerHTML = "";
	});

	test("hides the section when there are no feedback entries", () => {
		updateFeedbackHistorySection([]);
		const section = document.querySelector("#workflow-feedback-section");
		expect(section?.classList.contains("hidden")).toBe(true);
		expect(section?.children.length).toBe(0);
	});

	test("renders iteration, timestamp, outcome badge, and text preview for each entry", () => {
		const entries: FeedbackEntry[] = [
			{
				id: "fe-1",
				iteration: 1,
				text: "rename x to count",
				submittedAt: "2026-04-13T14:22:01.000Z",
				submittedAtStepName: "merge-pr",
				outcome: {
					value: "success",
					summary: "renamed",
					commitRefs: ["abc"],
					warnings: [],
				},
			},
			{
				id: "fe-2",
				iteration: 2,
				text: "second feedback",
				submittedAt: "2026-04-13T14:25:00.000Z",
				submittedAtStepName: "merge-pr",
				outcome: null,
			},
		];

		updateFeedbackHistorySection(entries);

		const section = document.querySelector("#workflow-feedback-section");
		expect(section?.classList.contains("hidden")).toBe(false);

		const rows = section?.querySelectorAll(".workflow-feedback-entry");
		expect(rows?.length).toBe(2);
		expect(section?.textContent).toContain("#1");
		expect(section?.textContent).toContain("#2");
		expect(section?.textContent).toContain("rename x to count");
		expect(section?.textContent).toContain("second feedback");
		expect(section?.textContent).toContain("success");
		expect(section?.textContent).toContain("pending");
	});

	test("renders warnings inline under the outcome badge (T046)", () => {
		const entries: FeedbackEntry[] = [
			{
				id: "fe-1",
				iteration: 1,
				text: "major change",
				submittedAt: "2026-04-13T00:00:00.000Z",
				submittedAtStepName: "merge-pr",
				outcome: {
					value: "success",
					summary: "landed",
					commitRefs: ["abc"],
					warnings: [
						{
							kind: "pr_description_update_failed",
							message: "gh: rate limited",
						},
					],
				},
			},
		];

		updateFeedbackHistorySection(entries);

		const warnings = document.querySelectorAll(".workflow-feedback-entry-warning");
		expect(warnings.length).toBe(1);
		expect(warnings[0].textContent).toContain("pr_description_update_failed");
		expect(warnings[0].textContent).toContain("gh: rate limited");
	});
});
