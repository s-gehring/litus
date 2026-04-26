import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import "../happydom";
import { ClientStateManager } from "../../src/client/client-state-manager";
import { createWorkflowDetailHandler } from "../../src/client/components/workflow-detail-handler";
import { Router } from "../../src/client/router";
import type { ClientMessage } from "../../src/types";
import { makeWorkflowState } from "../helpers";

const BASE_DOM = `
	<div id="app">
		<header></header>
		<div id="app-content">
			<div id="card-strip" class="card-strip"></div>
			<div id="welcome-area" class="welcome-area"></div>
			<div id="detail-area" class="workflow-window hidden">
				<div id="status-area">
					<span id="workflow-status" class="status-badge idle"></span>
					<span id="current-step-label" class="hidden"></span>
					<a id="pr-link" class="hidden"></a>
					<span id="workflow-summary"></span>
					<span id="workflow-step-summary"></span>
					<span id="workflow-flavor"></span>
				</div>
				<div id="branch-info" class="hidden"></div>
				<div id="user-input" class="user-input hidden"></div>
				<div id="workflow-feedback-section" class="hidden"></div>
				<details id="spec-details" class="hidden"><summary></summary><div id="spec-details-text"></div></details>
				<div id="detail-actions" class="hidden"></div>
				<div id="workflow-error-banner" class="hidden"></div>
				<div id="pipeline-steps" class="hidden"></div>
				<div id="active-model-panel"></div>
				<div id="output-area"><div id="output-log"></div></div>
				<div id="question-panel" class="question-panel hidden">
					<div class="question-header"><span id="question-confidence"></span></div>
					<p id="question-content"></p>
					<textarea id="answer-input"></textarea>
					<button id="btn-submit-answer"></button>
					<button id="btn-skip-question" class="hidden"></button>
				</div>
				<div id="feedback-panel" class="hidden">
					<div id="feedback-history"></div>
					<textarea id="feedback-input"></textarea>
					<button id="btn-submit-feedback"></button>
					<button id="btn-cancel-feedback"></button>
				</div>
			</div>
		</div>
	</div>
`;

class TestRouter extends Router {
	private _testPath = "/";
	setTestPath(p: string) {
		this._testPath = p;
	}
	protected getPathname(): string {
		return this._testPath;
	}
}

function actionLabels(): string[] {
	return Array.from(document.querySelectorAll("#detail-actions button")).map(
		(b) => (b as HTMLButtonElement).textContent?.trim() ?? "",
	);
}

function actionTestIds(): string[] {
	return Array.from(document.querySelectorAll("#detail-actions button")).map(
		(b) => (b as HTMLButtonElement).getAttribute("data-testid") ?? "",
	);
}

describe("workflow-detail-handler action buttons", () => {
	let router: TestRouter | null = null;
	let sendSpy: ReturnType<typeof mock>;
	let state: ClientStateManager;

	beforeEach(() => {
		document.body.innerHTML = BASE_DOM;
		sendSpy = mock(() => {});
		state = new ClientStateManager();
	});

	afterEach(() => {
		router?.destroy();
		router = null;
		document.body.innerHTML = "";
	});

	function mountForWorkflow(wfOverrides: Parameters<typeof makeWorkflowState>[0]): void {
		// Destroy any router from a prior call so its popstate listener does not
		// leak onto `window` and fire during a later test (the leaked listener's
		// handler expects DOM nodes this test has since wiped, which throws and
		// surfaces as an unrelated happy-dom dispatchError in router.test.ts).
		router?.destroy();
		router = null;
		const wf = makeWorkflowState(wfOverrides);
		state.handleMessage({ type: "workflow:list", workflows: [wf] });
		const container = document.getElementById("app-content") as HTMLElement;
		router = new TestRouter(container, "/");
		router.register("/", {
			mount: () => {},
			unmount: () => {},
			onMessage: () => {},
		});
		router.register(
			"/workflow/:id",
			createWorkflowDetailHandler({
				getState: () => state,
				getAutoMode: () => "normal",
				getArtifactContext: () => null,
				fetchArtifacts: () => {},
				send: sendSpy as unknown as (m: ClientMessage) => void,
				navigate: (p) => router?.navigate(p),
				openFeedbackPanel: () => {},
			}),
		);
		router.setTestPath(`/workflow/${wf.id}`);
		router.start();
	}

	test("errored workflow renders both per-step retry and the destructive workflow restart", () => {
		mountForWorkflow({ id: "wf-err", status: "error" });
		const labels = actionLabels();
		expect(labels).toContain("Retry step");
		expect(labels).toContain("Restart");
		// Generated testids must match what the e2e page-object expects;
		// keys (and thus testids) are stable even when labels are reworded.
		const testids = actionTestIds();
		expect(testids).toContain("action-retry-step");
		expect(testids).toContain("action-retry-workflow");
	});

	test("aborted workflow renders only the workflow-level reset (not the per-step retry)", () => {
		mountForWorkflow({ id: "wf-abort", status: "aborted" });
		const testids = actionTestIds();
		expect(testids).toContain("action-retry-workflow");
		expect(testids).not.toContain("action-retry-step");
	});

	test("idle workflow renders neither retry button", () => {
		mountForWorkflow({ id: "wf-idle", status: "idle" });
		const testids = actionTestIds();
		expect(testids).not.toContain("action-retry-step");
		expect(testids).not.toContain("action-retry-workflow");
	});

	test("workflow-level error message is rendered in the detail pane banner", () => {
		mountForWorkflow({
			id: "wf-reset-partial",
			status: "error",
			error: { message: "Reset failed: could not delete worktree /tmp/locked-worktree" },
		});
		const banner = document.getElementById("workflow-error-banner") as HTMLElement;
		expect(banner.classList.contains("hidden")).toBe(false);
		expect(banner.textContent).toContain("Reset failed");
		expect(banner.textContent).toContain("/tmp/locked-worktree");
	});

	test("workflow without error leaves the banner hidden", () => {
		mountForWorkflow({ id: "wf-no-error", status: "error" });
		const banner = document.getElementById("workflow-error-banner") as HTMLElement;
		expect(banner.classList.contains("hidden")).toBe(true);
		expect(banner.textContent ?? "").toBe("");
	});

	test("workflow summary falls back to specification when summarizer produced no summary", () => {
		// Pre-populate the slot with the previous detail's title to mimic the real
		// bug: navigating from one workflow to another whose summary is still empty
		// (e.g. summarizer agent errored) used to leave the prior title visible.
		const slot = document.getElementById("workflow-summary") as HTMLElement;
		slot.textContent = "Stale previous title";
		mountForWorkflow({
			id: "wf-no-summary",
			summary: "",
			specification: "Fix login button alignment on mobile",
		});
		expect(slot.textContent).toBe("Fix login button alignment on mobile");
	});

	test("workflow summary uses generated summary when present", () => {
		const slot = document.getElementById("workflow-summary") as HTMLElement;
		slot.textContent = "Stale previous title";
		mountForWorkflow({
			id: "wf-with-summary",
			summary: "Login button fix",
			specification: "Fix login button alignment on mobile",
		});
		expect(slot.textContent).toBe("Login button fix");
	});

	test("all action testids stay in sync with the e2e page-object contract", () => {
		// Covers every key this pane can emit. Test-ids are derived from
		// stable keys (not labels), so reword-only diffs don't break this.
		const cases: {
			status: NonNullable<Parameters<typeof makeWorkflowState>[0]>["status"];
			expected: string[];
		}[] = [
			{ status: "running", expected: ["action-pause", "action-archive"] },
			{ status: "paused", expected: ["action-resume", "action-abort", "action-archive"] },
			{
				status: "error",
				expected: ["action-retry-step", "action-abort", "action-retry-workflow", "action-archive"],
			},
			{ status: "aborted", expected: ["action-retry-workflow", "action-archive"] },
			{
				status: "waiting_for_dependencies",
				expected: ["action-force-start", "action-abort", "action-archive"],
			},
		];
		for (const { status, expected } of cases) {
			document.body.innerHTML = BASE_DOM;
			state = new ClientStateManager();
			mountForWorkflow({ id: `wf-${status}`, status });
			const testids = actionTestIds();
			for (const id of expected) expect(testids).toContain(id);
		}
	});

	test("archive button is disabled-with-tooltip while running, never just hidden", () => {
		mountForWorkflow({ id: "wf-running", status: "running" });
		const archive = document.querySelector<HTMLButtonElement>(
			'#detail-actions [data-testid="action-archive"]',
		);
		expect(archive).not.toBeNull();
		expect(archive?.disabled).toBe(true);
		expect(archive?.getAttribute("aria-disabled")).toBe("true");
		expect(archive?.title).toBe("Cannot archive while running");
		expect(archive?.classList.contains("btn-disabled")).toBe(true);
		// Label stays plain; the disabled state lives in the attribute, not
		// the visible text.
		expect(archive?.textContent).toBe("Archive");
	});

	test("archive button on completed (terminal) workflow skips the confirm modal", async () => {
		mountForWorkflow({ id: "wf-done", status: "completed" });
		const archive = document.querySelector<HTMLButtonElement>(
			'#detail-actions [data-testid="action-archive"]',
		);
		archive?.click();
		// No modal should appear for terminal workflows — confirmOverride: null.
		await Promise.resolve();
		expect(document.querySelector(".confirm-modal")).toBeNull();
		expect(sendSpy).toHaveBeenCalledWith({
			type: "workflow:archive",
			workflowId: "wf-done",
		});
	});

	test("archive button on non-terminal workflow opens modal confirm before sending", async () => {
		mountForWorkflow({ id: "wf-paused", status: "paused" });
		const archive = document.querySelector<HTMLButtonElement>(
			'#detail-actions [data-testid="action-archive"]',
		);
		archive?.click();
		await Promise.resolve();
		const modal = document.querySelector(".confirm-modal");
		expect(modal).not.toBeNull();
		// Cancel ⇒ no send.
		(modal?.querySelector(".btn-secondary") as HTMLButtonElement | null)?.click();
		await Promise.resolve();
		await Promise.resolve();
		expect(
			sendSpy.mock.calls.some(
				(c) => (c?.[0] as { type?: string } | undefined)?.type === "workflow:archive",
			),
		).toBe(false);
	});

	test("epic-child idle workflow shows Start (no Archive — child specs cannot be archived)", () => {
		mountForWorkflow({ id: "wf-child", status: "idle", epicId: "e-1" });
		const testids = actionTestIds();
		expect(testids).toContain("action-start");
		expect(testids).not.toContain("action-archive");
	});

	test("paused merge-pr step in normal mode does NOT expose Provide feedback", () => {
		// Approximate the pre-merge-PR pause: status=paused at the merge-pr step.
		// `mountForWorkflow` always wires getAutoMode → "normal", so feedback
		// should NOT show even on merge-pr — the button is gated on manual mode.
		mountForWorkflow({
			id: "wf-merge",
			status: "paused",
			steps: [
				{
					name: "merge-pr",
					displayName: "Merging PR",
					status: "paused",
					output: "",
					outputLog: [],
					error: null,
					startedAt: null,
					completedAt: null,
					history: [],
					outcome: null,
				},
			],
			currentStepIndex: 0,
		});
		const testids = actionTestIds();
		expect(testids).not.toContain("action-provide-feedback");
	});

	test("button order respects slot contract: primary → secondary → destructive → finalize", () => {
		mountForWorkflow({ id: "wf-err", status: "error" });
		const slots = Array.from(
			document.querySelectorAll<HTMLButtonElement>("#detail-actions button"),
		).map((b) => b.getAttribute("data-slot") ?? "");
		// primary first if any, then secondary (retry-step), then destructive
		// (abort + retry-workflow), then finalize (archive).
		const slotOrder = slots.join(",");
		expect(slotOrder).toBe("secondary,destructive,destructive,finalize");
	});
});
