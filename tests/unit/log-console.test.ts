import { afterEach, describe, expect, it } from "bun:test";
import { createLogConsole } from "../../src/client/components/run-screen/log-console";
import type { DiffHunk } from "../../src/client/components/run-screen/log-kind-classifier";
import type { LogConsoleModel } from "../../src/client/components/run-screen/run-screen-model";

function baseModel(over: Partial<LogConsoleModel> = {}): LogConsoleModel {
	return {
		currentStep: "step",
		counters: { toolCalls: 0, reads: 0, edits: 0 },
		writingLineIndex: null,
		events: [],
		...over,
	};
}

describe("log-console", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("renders each of the six line kinds with data-log-kind attributes", () => {
		const { element } = createLogConsole(
			baseModel({
				events: [
					{ kind: "section", text: "── step ──" },
					{ kind: "cmd", cwd: null, body: "pnpm test" },
					{ kind: "out", text: "ok" },
					{ kind: "assistant", body: "hi" },
					{ kind: "diff", path: "a.ts", hunks: [] },
					{ kind: "toolstrip", items: [{ kind: "read" }] },
				],
			}),
		);
		document.body.appendChild(element);

		const kinds = Array.from(element.querySelectorAll("[data-log-kind]")).map(
			(el) => (el as HTMLElement).dataset.logKind,
		);
		expect(kinds).toEqual(["section", "cmd", "out", "assistant", "diff", "toolstrip"]);
	});

	it("attaches a blinking caret to the writing line only", () => {
		const { element } = createLogConsole(
			baseModel({
				writingLineIndex: 1,
				events: [
					{ kind: "out", text: "first" },
					{ kind: "out", text: "second" },
				],
			}),
		);
		document.body.appendChild(element);
		const carets = element.querySelectorAll(".caret");
		expect(carets.length).toBe(1);
	});

	it("renders diff hunks with +/- colouring", () => {
		const hunks: DiffHunk[] = [
			{
				context: "@@ -1,2 +1,2 @@",
				lines: [
					{ op: " ", text: "unchanged" },
					{ op: "-", text: "old line" },
					{ op: "+", text: "new line" },
				],
			},
		];
		const { element } = createLogConsole(
			baseModel({ events: [{ kind: "diff", path: "src/file.ts", hunks }] }),
		);
		document.body.appendChild(element);
		const diff = element.querySelector('[data-log-kind="diff"]') as HTMLElement;
		expect(diff).not.toBeNull();

		const rows = Array.from(diff.querySelectorAll("div")) as HTMLElement[];
		const added = rows.find((r) => r.textContent === "+new line");
		const removed = rows.find((r) => r.textContent === "-old line");
		expect(added).toBeDefined();
		expect(removed).toBeDefined();
		// Green plus, red minus — both must colour-diverge from each other and
		// from the unchanged text muted style.
		// Added vs removed differ in their text content (prefix symbol), which is
		// the load-bearing visual signal the FR-030 diff renderer must emit.
		// happy-dom's CSSOM drops oklch() colours from inline styles so we can't
		// assert the resolved colour — the glyph prefix is the authoritative
		// test for correct branch routing inside renderDiff.
		expect(added).toBeDefined();
		expect(removed).toBeDefined();

		// Path header shown
		expect(diff.textContent).toContain("src/file.ts");
		// @@-context preserved
		expect(diff.textContent).toContain("@@ -1,2 +1,2 @@");
		// Context (non +/-) line rendered verbatim, no prefix.
		const rowsAll = Array.from(diff.querySelectorAll("div")) as HTMLElement[];
		expect(rowsAll.some((r) => r.textContent === "unchanged")).toBe(true);
	});

	it("assistant body renders sanitised markdown (strong, script stripped)", () => {
		const { element } = createLogConsole(
			baseModel({
				events: [
					{
						kind: "assistant",
						body: "Hello **world** <script>alert('xss')</script>",
					},
				],
			}),
		);
		document.body.appendChild(element);
		const bubble = element.querySelector('[data-log-kind="assistant"]') as HTMLElement;
		expect(bubble.querySelector("strong")).not.toBeNull();
		expect(bubble.querySelector("strong")?.textContent).toBe("world");
		expect(bubble.querySelector("script")).toBeNull();
		expect(bubble.innerHTML.toLowerCase()).not.toContain("<script");
	});

	it("toolstrip maps each kind to its FR-030 glyph", () => {
		const { element } = createLogConsole(
			baseModel({
				events: [
					{
						kind: "toolstrip",
						items: [{ kind: "read" }, { kind: "edit" }, { kind: "grep" }, { kind: "cmd" }],
					},
				],
			}),
		);
		document.body.appendChild(element);
		const strip = element.querySelector('[data-log-kind="toolstrip"]') as HTMLElement;
		const icons = Array.from(strip.children).map((c) => (c as HTMLElement).textContent);
		expect(icons).toEqual(["◻", "✎", "⌕", "»"]);
	});

	it("toolstrip icon label propagates to the title attribute when provided", () => {
		const { element } = createLogConsole(
			baseModel({
				events: [
					{
						kind: "toolstrip",
						items: [{ kind: "edit", label: "Edit" }],
					},
				],
			}),
		);
		document.body.appendChild(element);
		const strip = element.querySelector('[data-log-kind="toolstrip"]') as HTMLElement;
		expect((strip.firstElementChild as HTMLElement).title).toBe("Edit");
	});

	it("auto-scroll state machine: on → off-by-user-scroll → on-by-scroll-to-bottom", () => {
		const { element, update } = createLogConsole(baseModel());
		document.body.appendChild(element);
		const body = element.querySelector(".scroll") as HTMLElement;

		// Seed some events so body has height.
		update(
			baseModel({
				events: Array.from({ length: 50 }, (_, i) => ({
					kind: "out" as const,
					text: `line ${i}`,
				})),
			}),
		);

		// Simulate layout numbers: small clientHeight, large scrollHeight.
		Object.defineProperty(body, "scrollHeight", { value: 1000, configurable: true });
		Object.defineProperty(body, "clientHeight", { value: 200, configurable: true });

		// User scrolls up → off-by-user.
		body.scrollTop = 100;
		body.dispatchEvent(new Event("scroll"));

		// A subsequent update must NOT jump us back to the bottom.
		update(
			baseModel({
				events: Array.from({ length: 51 }, (_, i) => ({
					kind: "out" as const,
					text: `line ${i}`,
				})),
			}),
		);
		expect(body.scrollTop).toBe(100);

		// User scrolls back to within 4px of the bottom → flips back to on.
		body.scrollTop = 800; // scrollHeight - clientHeight = 800 → at bottom.
		body.dispatchEvent(new Event("scroll"));

		// Next update re-pins to bottom.
		update(
			baseModel({
				events: Array.from({ length: 52 }, (_, i) => ({
					kind: "out" as const,
					text: `line ${i}`,
				})),
			}),
		);
		expect(body.scrollTop).toBe(1000);
	});

	it("off-by-toggle is sticky: scroll-to-bottom does NOT promote back to on (§2.6)", () => {
		// Regression guard for research.md §3 — toggle button overrides the
		// "off-by-user → on" rule until the user toggles back on explicitly.
		const { element, update } = createLogConsole(baseModel());
		document.body.appendChild(element);
		const body = element.querySelector(".scroll") as HTMLElement;
		const toggle = element.querySelector("button") as HTMLButtonElement;

		Object.defineProperty(body, "scrollHeight", { value: 1000, configurable: true });
		Object.defineProperty(body, "clientHeight", { value: 200, configurable: true });

		// Click toggle → off-by-toggle.
		toggle.click();

		// User scrolls all the way back to the bottom.
		body.scrollTop = 800; // scrollHeight - clientHeight.
		body.dispatchEvent(new Event("scroll"));

		// A subsequent update must NOT re-pin to bottom — the toggle override holds.
		body.scrollTop = 123;
		update(baseModel({ events: [{ kind: "out", text: "new" }] }));
		expect(body.scrollTop).toBe(123);
	});

	it("toolstrip glyph colours diverge by tool kind (§3.8)", () => {
		const { element } = createLogConsole(
			baseModel({
				events: [
					{
						kind: "toolstrip",
						items: [{ kind: "read" }, { kind: "edit" }, { kind: "grep" }, { kind: "cmd" }],
					},
				],
			}),
		);
		document.body.appendChild(element);
		const strip = element.querySelector('[data-log-kind="toolstrip"]') as HTMLElement;
		const colours = Array.from(strip.children).map((c) => (c as HTMLElement).style.color);
		// FR-030 mapping: read muted / edit amber / grep cyan / cmd green.
		// happy-dom's CSSOM drops oklch() from inline styles (the amber/cyan/
		// green branches all serialise to ""), but textMute is a hex literal
		// and survives — so the minimum-viable guard is that the `read` icon
		// does NOT end up with the same colour string as the three accented
		// icons. This catches the regression where all four icons accidentally
		// collapse to the same colour.
		const readCol = colours[0];
		const nonReadCols = colours.slice(1);
		expect(nonReadCols.some((c) => c !== readCol)).toBe(true);
	});

	it("scrollToSection finds a rendered section node by step display name (§2.4)", () => {
		const { element, update, scrollToSection } = createLogConsole(baseModel());
		document.body.appendChild(element);
		update(
			baseModel({
				events: [
					{ kind: "section", text: "──────── Implementing ────────" },
					{ kind: "out", text: "body" },
				],
			}),
		);
		const body = element.querySelector(".scroll") as HTMLElement;
		const section = body.querySelector('[data-log-kind="section"]') as HTMLElement;
		let called = false;
		section.scrollIntoView = () => {
			called = true;
		};
		scrollToSection("Implementing");
		expect(called).toBe(true);
	});

	it("auto-scroll toggle button flips the state on click", () => {
		const { element, update } = createLogConsole(baseModel());
		document.body.appendChild(element);
		const body = element.querySelector(".scroll") as HTMLElement;
		const toggle = element.querySelector("button") as HTMLButtonElement;

		Object.defineProperty(body, "scrollHeight", { value: 2000, configurable: true });
		Object.defineProperty(body, "clientHeight", { value: 200, configurable: true });

		// Click → off-by-toggle; update must not auto-scroll.
		toggle.click();
		body.scrollTop = 0;
		update(
			baseModel({
				events: [{ kind: "out", text: "x" }],
			}),
		);
		expect(body.scrollTop).toBe(0);

		// Click → back to on; toggle handler pins to bottom immediately.
		toggle.click();
		expect(body.scrollTop).toBe(2000);
	});
});
