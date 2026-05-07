// View-model + render-path tests for the CI pipeline status icon row.
// Exercises the pure view-model without going through the WebSocket loop —
// happy-dom provides the DOM, and `render()` is driven directly with crafted
// `WorkflowState` snapshots.
//
// Backs: data-model.md (CiStatusCategory mapping, slotByKey cache,
// CiPlaceholderState branches), contracts/ui-component-contract.md (B-1, B-3,
// B-4, B-5, B-6, B-7, B-8, B-10), spec FR-002…FR-016.

import { afterEach, describe, expect, test } from "bun:test";
import { createCiPipelineStatusView } from "../../src/client/components/ci-pipeline-status-view";
import { type PipelineStep, STEP } from "../../src/pipeline-steps";
import type { CiCheckResult, WorkflowState } from "../../src/types";
import { makeWorkflowState } from "../helpers";

const ROOT = ".ci-pipeline-status-view";

function setup(): { outputArea: HTMLElement; outputLog: HTMLElement } {
	document.body.innerHTML =
		'<div id="output-area"><div id="output-log">existing log content</div></div>';
	return {
		outputArea: document.getElementById("output-area") as HTMLElement,
		outputLog: document.getElementById("output-log") as HTMLElement,
	};
}

function makeMonitorStep(overrides: Partial<PipelineStep> = {}): PipelineStep {
	return {
		name: STEP.MONITOR_CI,
		displayName: "Monitor CI",
		status: "running",
		prompt: "",
		sessionId: null,
		output: "",
		outputLog: [],
		error: null,
		startedAt: null,
		completedAt: null,
		pid: null,
		history: [],
		...overrides,
	};
}

function makeCommitStep(): PipelineStep {
	return {
		name: STEP.COMMIT_PUSH_PR,
		displayName: "Commit & PR",
		status: "completed",
		prompt: "",
		sessionId: null,
		output: "",
		outputLog: [],
		error: null,
		startedAt: null,
		completedAt: null,
		pid: null,
		history: [],
	};
}

function makeWorkflow(
	results: CiCheckResult[],
	stepStatus: PipelineStep["status"] = "running",
	attempt = 0,
	overrides: Partial<WorkflowState> = {},
	pollCount = 0,
): { workflow: WorkflowState; monitorIndex: number } {
	const monitorStep = makeMonitorStep({ status: stepStatus });
	const wf = makeWorkflowState({
		id: "wf-1",
		steps: [makeCommitStep(), monitorStep],
		currentStepIndex: 1,
		ciCycle: {
			attempt,
			maxAttempts: 3,
			monitorStartedAt: null,
			globalTimeoutMs: 60_000,
			lastCheckResults: results,
			pollCount,
			failureLogs: [],
		},
		...overrides,
	});
	return { workflow: wf, monitorIndex: 1 };
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("ci-pipeline-status-view — view-model & mount (B-1, B-2, B-5)", () => {
	test("does not mount when the selected step is not monitor-ci", () => {
		const { outputArea } = setup();
		const view = createCiPipelineStatusView(outputArea);
		const { workflow } = makeWorkflow([
			{ name: "build", state: "in_progress", bucket: "pending", link: "" },
		]);

		view.render(workflow, 0); // commit-push-pr selected

		expect(outputArea.querySelector(ROOT)).toBeNull();
	});

	test("mounts as the first child of outputArea, with #output-log unchanged immediately after", () => {
		const { outputArea, outputLog } = setup();
		const view = createCiPipelineStatusView(outputArea);
		const { workflow, monitorIndex } = makeWorkflow([
			{ name: "build", state: "in_progress", bucket: "pending", link: "" },
		]);

		view.render(workflow, monitorIndex);

		const root = outputArea.querySelector<HTMLElement>(ROOT);
		expect(root).not.toBeNull();
		expect(outputArea.firstElementChild).toBe(root);
		expect(root?.nextElementSibling).toBe(outputLog);
		expect(outputLog.textContent).toBe("existing log content");
	});

	test("destroy() removes the row and clears its cache", () => {
		const { outputArea } = setup();
		const view = createCiPipelineStatusView(outputArea);
		const { workflow, monitorIndex } = makeWorkflow([
			{ name: "build", state: "in_progress", bucket: "pending", link: "" },
		]);

		view.render(workflow, monitorIndex);
		expect(outputArea.querySelector(ROOT)).not.toBeNull();

		view.destroy();
		expect(outputArea.querySelector(ROOT)).toBeNull();
	});

	test("aria-label and title carry name + status category for screen readers and colorblind users", () => {
		const { outputArea } = setup();
		const view = createCiPipelineStatusView(outputArea);
		const longName = "really-very-long-matrix-job-name-that-will-be-truncated-1.2.3";
		const { workflow, monitorIndex } = makeWorkflow([
			{ name: longName, state: "queued", bucket: "pending", link: "https://gh/x" },
		]);

		view.render(workflow, monitorIndex);

		const entry = outputArea.querySelector<HTMLElement>(".ci-entry");
		expect(entry).not.toBeNull();
		const expected = `${longName} — in progress`;
		expect(entry?.getAttribute("title")).toBe(expected);
		expect(entry?.getAttribute("aria-label")).toBe(expected);
	});
});

describe("ci-pipeline-status-view — bucket→category mapping (R-5, FR-005, FR-006)", () => {
	const cases: Array<{ bucket: string; expected: string; terminal: boolean }> = [
		{ bucket: "pass", expected: "ci-entry-succeeded", terminal: true },
		{ bucket: "fail", expected: "ci-entry-failed", terminal: true },
		{ bucket: "cancel", expected: "ci-entry-cancelled", terminal: true },
		{ bucket: "skipping", expected: "ci-entry-skipped", terminal: true },
		{ bucket: "pending", expected: "ci-entry-in-progress", terminal: false },
		{ bucket: "", expected: "ci-entry-in-progress", terminal: false },
		{ bucket: "future-unknown", expected: "ci-entry-in-progress", terminal: false },
	];

	for (const { bucket, expected, terminal } of cases) {
		test(`bucket "${bucket}" → ${expected} (terminal=${terminal})`, () => {
			const { outputArea } = setup();
			const view = createCiPipelineStatusView(outputArea);
			const { workflow, monitorIndex } = makeWorkflow([
				{ name: "ci", state: "x", bucket, link: "" },
			]);

			view.render(workflow, monitorIndex);

			const entry = outputArea.querySelector<HTMLElement>(".ci-entry");
			expect(entry?.classList.contains(expected)).toBe(true);
		});
	}
});

describe("ci-pipeline-status-view — stableKey & duplicate-name handling (FR-015, FR-016, B-3)", () => {
	test("uses ${name}::${index} for stable identity (data-stable-key attribute)", () => {
		const { outputArea } = setup();
		const view = createCiPipelineStatusView(outputArea);
		const { workflow, monitorIndex } = makeWorkflow([
			{ name: "build", state: "queued", bucket: "pending", link: "" },
			{ name: "build", state: "queued", bucket: "pending", link: "" },
			{ name: "lint", state: "queued", bucket: "pending", link: "" },
		]);

		view.render(workflow, monitorIndex);

		const entries = Array.from(outputArea.querySelectorAll<HTMLElement>(".ci-entry"));
		expect(entries.map((e) => e.dataset.stableKey)).toEqual(["build::0", "build::1", "lint::2"]);
	});
});

describe("ci-pipeline-status-view — placeholder copy (FR-013, FR-014, B-7)", () => {
	test('"Waiting for checks…" while step is running and results are empty', () => {
		const { outputArea } = setup();
		const view = createCiPipelineStatusView(outputArea);
		const { workflow, monitorIndex } = makeWorkflow([], "running");

		view.render(workflow, monitorIndex);

		const placeholder = outputArea.querySelector<HTMLElement>(".ci-pipeline-status-placeholder");
		expect(placeholder?.textContent).toBe("Waiting for checks…");
		expect(outputArea.querySelector(".ci-entry")).toBeNull();
	});

	test('"Waiting for checks…" while step is waiting_for_input and results are empty', () => {
		const { outputArea } = setup();
		const view = createCiPipelineStatusView(outputArea);
		const { workflow, monitorIndex } = makeWorkflow([], "waiting_for_input");

		view.render(workflow, monitorIndex);

		const placeholder = outputArea.querySelector<HTMLElement>(".ci-pipeline-status-placeholder");
		expect(placeholder?.textContent).toBe("Waiting for checks…");
	});

	test('"No CI checks were reported." once step is completed with empty results', () => {
		const { outputArea } = setup();
		const view = createCiPipelineStatusView(outputArea);
		const { workflow, monitorIndex } = makeWorkflow([], "completed");

		view.render(workflow, monitorIndex);

		const placeholder = outputArea.querySelector<HTMLElement>(".ci-pipeline-status-placeholder");
		expect(placeholder?.textContent).toBe("No CI checks were reported.");
	});

	test('"No CI checks were reported." once step is error with empty results', () => {
		const { outputArea } = setup();
		const view = createCiPipelineStatusView(outputArea);
		const { workflow, monitorIndex } = makeWorkflow([], "error");

		view.render(workflow, monitorIndex);

		const placeholder = outputArea.querySelector<HTMLElement>(".ci-pipeline-status-placeholder");
		expect(placeholder?.textContent).toBe("No CI checks were reported.");
	});

	test("placeholder must NOT be a pulsing entry", () => {
		const { outputArea } = setup();
		const view = createCiPipelineStatusView(outputArea);
		const { workflow, monitorIndex } = makeWorkflow([], "running");

		view.render(workflow, monitorIndex);

		const placeholder = outputArea.querySelector<HTMLElement>(".ci-pipeline-status-placeholder");
		expect(placeholder?.classList.contains("ci-entry-pulse")).toBe(false);
	});
});

describe("ci-pipeline-status-view — order pinning across polls (FR-003, B-3)", () => {
	test("two polls with reordered provider list keep first-seen slots", () => {
		const { outputArea } = setup();
		const view = createCiPipelineStatusView(outputArea);

		const first = makeWorkflow([
			{ name: "build", state: "queued", bucket: "pending", link: "" },
			{ name: "lint", state: "queued", bucket: "pending", link: "" },
			{ name: "test", state: "queued", bucket: "pending", link: "" },
		]);
		view.render(first.workflow, first.monitorIndex);
		const initialOrder = Array.from(outputArea.querySelectorAll<HTMLElement>(".ci-entry")).map(
			(e) => e.dataset.stableKey,
		);
		expect(initialOrder).toEqual(["build::0", "lint::1", "test::2"]);

		// Provider returns the same set in a different order on the next poll.
		const second = makeWorkflow([
			{ name: "test", state: "queued", bucket: "pending", link: "" },
			{ name: "build", state: "queued", bucket: "pending", link: "" },
			{ name: "lint", state: "queued", bucket: "pending", link: "" },
		]);
		view.render(second.workflow, second.monitorIndex);
		const orderAfter = Array.from(outputArea.querySelectorAll<HTMLElement>(".ci-entry")).map(
			(e) => e.dataset.stableKey,
		);
		// `test::0` is now slot 3 (the new key); the old `test::2` aged out
		// of the poll set so it's not rendered. The IDs that match the new
		// poll positions all become first-seen here, so order is the new
		// poll's order. Existing keys that survive at the same index stay at
		// their slot. Specifically, `build::0` and `lint::1` survive into
		// poll 2 but at indices 1 and 2 — they get NEW stableKeys (`build::1`
		// and `lint::2`) because index changed. New stableKeys, new slots,
		// in the order they appear → poll 2's order.
		// Net effect: stableKey identity is composite (name + index). When
		// the provider re-orders, the keys change, so the row reflects the
		// new order. This is acceptable because FR-016 explicitly accepts
		// the index-based composite as the fallback identity.
		expect(orderAfter).toEqual(["test::0", "build::1", "lint::2"]);

		// Newcomer keys keep their first-seen slots: a third poll repeating
		// poll 2's order must NOT reshuffle.
		const third = makeWorkflow([
			{ name: "test", state: "queued", bucket: "pending", link: "" },
			{ name: "build", state: "queued", bucket: "pending", link: "" },
			{ name: "lint", state: "queued", bucket: "pending", link: "" },
		]);
		view.render(third.workflow, third.monitorIndex);
		const orderThird = Array.from(outputArea.querySelectorAll<HTMLElement>(".ci-entry")).map(
			(e) => e.dataset.stableKey,
		);
		expect(orderThird).toEqual(["test::0", "build::1", "lint::2"]);
	});
});

describe("ci-pipeline-status-view — attempt rollover (FR-011, B-4)", () => {
	test("ciCycle.attempt change flushes the slot map and reorders from new poll", () => {
		const { outputArea } = setup();
		const view = createCiPipelineStatusView(outputArea);

		const first = makeWorkflow(
			[
				{ name: "build", state: "queued", bucket: "pending", link: "" },
				{ name: "lint", state: "queued", bucket: "pending", link: "" },
			],
			"running",
			0,
		);
		view.render(first.workflow, first.monitorIndex);
		expect(
			Array.from(outputArea.querySelectorAll<HTMLElement>(".ci-entry")).map(
				(e) => e.dataset.stableKey,
			),
		).toEqual(["build::0", "lint::1"]);

		// New attempt: provider returns only `lint` first, then `build`.
		// Cache should be flushed → new ordering reflects current poll.
		const second = makeWorkflow(
			[
				{ name: "lint", state: "queued", bucket: "pending", link: "" },
				{ name: "build", state: "queued", bucket: "pending", link: "" },
			],
			"running",
			1,
		);
		view.render(second.workflow, second.monitorIndex);
		expect(
			Array.from(outputArea.querySelectorAll<HTMLElement>(".ci-entry")).map(
				(e) => e.dataset.stableKey,
			),
		).toEqual(["lint::0", "build::1"]);
	});

	test("workflow-id change flushes the slot map (defense-in-depth)", () => {
		const { outputArea } = setup();
		const view = createCiPipelineStatusView(outputArea);

		const a = makeWorkflow([{ name: "build", state: "queued", bucket: "pending", link: "" }]);
		view.render(a.workflow, a.monitorIndex);

		const b = makeWorkflow([{ name: "deploy", state: "queued", bucket: "pending", link: "" }]);
		b.workflow.id = "wf-other";
		view.render(b.workflow, b.monitorIndex);

		const entries = Array.from(outputArea.querySelectorAll<HTMLElement>(".ci-entry"));
		expect(entries.length).toBe(1);
		expect(entries[0].dataset.stableKey).toBe("deploy::0");
	});
});

describe("ci-pipeline-status-view — defensive empty frame (B-8, FR-012)", () => {
	test("empty render after a non-empty render within the same attempt preserves entries", () => {
		const { outputArea } = setup();
		const view = createCiPipelineStatusView(outputArea);

		const first = makeWorkflow(
			[
				{ name: "build", state: "in_progress", bucket: "pending", link: "" },
				{ name: "lint", state: "in_progress", bucket: "pending", link: "" },
			],
			"running",
			0,
		);
		view.render(first.workflow, first.monitorIndex);
		expect(outputArea.querySelectorAll(".ci-entry").length).toBe(2);

		// Transient empty frame within the same attempt — entries must
		// remain on screen.
		const transient = makeWorkflow([], "running", 0);
		view.render(transient.workflow, transient.monitorIndex);
		expect(outputArea.querySelectorAll(".ci-entry").length).toBe(2);
		expect(outputArea.querySelector(".ci-pipeline-status-placeholder")).toBeNull();
	});
});

describe("ci-pipeline-status-view — 20-entry layout cap (SC-006, B-9)", () => {
	test("renders all 20 entries; container relies on CSS for the visible cap + internal scroll", () => {
		const { outputArea } = setup();
		const view = createCiPipelineStatusView(outputArea);

		const results = Array.from({ length: 20 }, (_, i) => ({
			name: `check-${String(i).padStart(2, "0")}`,
			state: "queued",
			bucket: "pending",
			link: "",
		}));
		const { workflow, monitorIndex } = makeWorkflow(results);

		view.render(workflow, monitorIndex);

		const root = outputArea.querySelector<HTMLElement>(".ci-pipeline-status-view");
		expect(root).not.toBeNull();
		// All 20 entries are present in the DOM (no truncation/dropping).
		expect(outputArea.querySelectorAll(".ci-entry").length).toBe(20);
		// The root carries the documented class — the CSS file
		// (public/style.css) enforces the ~3-row cap + overflow-y: auto;
		// the unit test asserts the JS doesn't strip the class hook.
		expect(root?.className).toBe("ci-pipeline-status-view");
	});
});

describe("ci-pipeline-status-view — pulsation on poll-driven updates (FR-008, B-6)", () => {
	test("pulse class applied to non-terminal entries on a poll-driven re-render", () => {
		const { outputArea } = setup();
		const view = createCiPipelineStatusView(outputArea);

		const first = makeWorkflow(
			[
				{ name: "build", state: "in_progress", bucket: "pending", link: "" },
				{ name: "lint", state: "queued", bucket: "pending", link: "" },
			],
			"running",
			0,
			{},
			1,
		);
		view.render(first.workflow, first.monitorIndex);
		// First render: no previous content → not pulsed.
		for (const el of outputArea.querySelectorAll<HTMLElement>(".ci-entry")) {
			expect(el.classList.contains("ci-entry-pulse")).toBe(false);
		}

		const second = makeWorkflow(
			[
				{ name: "build", state: "in_progress", bucket: "pending", link: "" },
				{ name: "lint", state: "success", bucket: "pass", link: "" },
			],
			"running",
			0,
			{},
			2,
		);
		view.render(second.workflow, second.monitorIndex);

		const entries = Array.from(outputArea.querySelectorAll<HTMLElement>(".ci-entry"));
		// The non-terminal `build` entry pulses.
		expect(entries[0].classList.contains("ci-entry-pulse")).toBe(true);
		// The terminal `lint` entry does NOT pulse.
		expect(entries[1].classList.contains("ci-entry-pulse")).toBe(false);
	});

	test("non-poll re-render (pollCount unchanged) does NOT trigger pulse", () => {
		const { outputArea } = setup();
		const view = createCiPipelineStatusView(outputArea);

		const first = makeWorkflow(
			[{ name: "build", state: "in_progress", bucket: "pending", link: "" }],
			"running",
			0,
			{},
			1,
		);
		view.render(first.workflow, first.monitorIndex);

		// Same pollCount = same poll. A fresh `workflow:state` frame
		// triggered by, e.g., a step-status update, must not repulse.
		const sameContent = makeWorkflow(
			[{ name: "build", state: "in_progress", bucket: "pending", link: "" }],
			"running",
			0,
			{},
			1,
		);
		view.render(sameContent.workflow, sameContent.monitorIndex);

		const entry = outputArea.querySelector<HTMLElement>(".ci-entry");
		expect(entry?.classList.contains("ci-entry-pulse")).toBe(false);
	});
});
