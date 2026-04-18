// Note: relies on Bun's built-in happy-dom shim so we can exercise the
// DOM-facing thinking-indicator helpers directly.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	appendOutput,
	appendToolIcons,
	clearOutput,
	removeThinkingIndicator,
	syncThinkingIndicator,
} from "../../src/client/components/workflow-window";

function mountOutputLog(): HTMLElement {
	document.body.innerHTML = '<div id="output-log"></div>';
	return document.getElementById("output-log") as HTMLElement;
}

describe("thinking indicator (state-driven)", () => {
	let log: HTMLElement;

	beforeEach(() => {
		log = mountOutputLog();
	});

	afterEach(() => {
		document.body.innerHTML = "";
	});

	test("syncThinkingIndicator(true) creates a visible indicator with three dots", () => {
		syncThinkingIndicator(true);
		const el = log.querySelector(".thinking-indicator");
		expect(el).not.toBeNull();
		expect(el?.classList.contains("visible")).toBe(true);
		expect(el?.querySelectorAll(".thinking-dot").length).toBe(3);
	});

	test("syncThinkingIndicator(true) is idempotent — no duplicate indicators", () => {
		syncThinkingIndicator(true);
		syncThinkingIndicator(true);
		syncThinkingIndicator(true);
		expect(log.querySelectorAll(".thinking-indicator").length).toBe(1);
	});

	test("syncThinkingIndicator(false) removes the indicator", () => {
		syncThinkingIndicator(true);
		syncThinkingIndicator(false);
		expect(log.querySelector(".thinking-indicator")).toBeNull();
	});

	test("appendOutput keeps the indicator pinned at the tail", () => {
		syncThinkingIndicator(true);
		appendOutput("first line");
		appendOutput("second line");
		expect(log.lastElementChild?.classList.contains("thinking-indicator")).toBe(true);
	});

	test("appendToolIcons keeps the indicator pinned at the tail", () => {
		appendOutput("first line");
		syncThinkingIndicator(true);
		appendToolIcons([{ name: "Bash", input: { command: "echo hi" } }]);
		expect(log.lastElementChild?.classList.contains("thinking-indicator")).toBe(true);
	});

	test("indicator shows during silent thinking — no output required", () => {
		// Regression guard for the "dots never appear while the LLM is working"
		// bug: the indicator must be visible purely from the syncThinkingIndicator
		// call, without any preceding appendOutput/appendToolIcons.
		syncThinkingIndicator(true);
		const el = log.querySelector(".thinking-indicator");
		expect(el?.classList.contains("visible")).toBe(true);
	});

	test("removeThinkingIndicator clears a visible indicator", () => {
		syncThinkingIndicator(true);
		removeThinkingIndicator();
		expect(log.querySelector(".thinking-indicator")).toBeNull();
	});

	test("clearOutput wipes the indicator along with output lines", () => {
		syncThinkingIndicator(true);
		appendOutput("line");
		clearOutput();
		expect(log.querySelector(".thinking-indicator")).toBeNull();
		expect(log.querySelector(".output-line")).toBeNull();
	});
});
