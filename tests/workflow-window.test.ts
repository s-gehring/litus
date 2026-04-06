import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
