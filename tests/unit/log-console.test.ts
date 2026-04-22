import { afterEach, describe, expect, it } from "bun:test";
import { createLogConsole } from "../../src/client/components/run-screen/log-console";

describe("log-console", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("renders each of the six line kinds with data-log-kind attributes", () => {
		const { element } = createLogConsole({
			currentStep: "step",
			counters: { toolCalls: 0, reads: 0, edits: 0 },
			writingLineIndex: null,
			events: [
				{ kind: "section", text: "── step ──" },
				{ kind: "cmd", cwd: null, body: "pnpm test" },
				{ kind: "out", text: "ok" },
				{ kind: "assistant", body: "hi" },
				{ kind: "diff", path: "a.ts", hunks: [] },
				{ kind: "toolstrip", items: [{ kind: "read" }] },
			],
		});
		document.body.appendChild(element);

		const kinds = Array.from(element.querySelectorAll("[data-log-kind]")).map(
			(el) => (el as HTMLElement).dataset.logKind,
		);
		expect(kinds).toEqual(["section", "cmd", "out", "assistant", "diff", "toolstrip"]);
	});

	it("attaches a blinking caret to the writing line only", () => {
		const { element } = createLogConsole({
			currentStep: "step",
			counters: { toolCalls: 0, reads: 0, edits: 0 },
			writingLineIndex: 1,
			events: [
				{ kind: "out", text: "first" },
				{ kind: "out", text: "second" },
			],
		});
		document.body.appendChild(element);
		const carets = element.querySelectorAll(".caret");
		expect(carets.length).toBe(1);
	});
});
