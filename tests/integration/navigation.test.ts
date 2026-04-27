import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import "../happydom";
import { ClientStateManager } from "../../src/client/client-state-manager";
import { createConfigPageHandler } from "../../src/client/components/config-page";
import { createDashboardHandler } from "../../src/client/components/dashboard-handler";
import { createEpicDetailHandler } from "../../src/client/components/epic-detail-handler";
import { createWorkflowDetailHandler } from "../../src/client/components/workflow-detail-handler";
import { Router } from "../../src/client/router";
import type { PipelineStepName } from "../../src/pipeline-steps";
import type { ClientMessage } from "../../src/protocol";
import { makeWorkflowState } from "../helpers";

// Reproduces the #app-content children from public/index.html.
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
				<details id="spec-details" class="hidden">
					<summary></summary>
					<div id="spec-details-text"></div>
				</details>
				<div id="detail-actions" class="hidden"></div>
				<div id="pipeline-steps" class="hidden"></div>
				<div id="active-model-panel"></div>
				<div id="output-area">
					<div id="output-log"></div>
				</div>
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

function isVisible(id: string): boolean {
	const el = document.getElementById(id);
	if (!el) return false;
	return !el.classList.contains("hidden");
}

function makeRouter(send: (m: ClientMessage) => void): {
	router: TestRouter;
	container: HTMLElement;
} {
	const container = document.getElementById("app-content") as HTMLElement;
	const router = new TestRouter(container, "/");
	const stateManager = new ClientStateManager();
	router.register("/", createDashboardHandler());
	router.register(
		"/workflow/:id",
		createWorkflowDetailHandler({
			getState: () => stateManager,
			getAutoMode: () => "normal",
			getArtifactContext: () => null,
			fetchArtifacts: () => {},
			send,
			navigate: (p) => router.navigate(p),
			openFeedbackPanel: () => {},
		}),
	);
	router.register(
		"/epic/:id",
		createEpicDetailHandler({
			getState: () => stateManager,
			getConfig: () => null,
			send,
			navigate: (p) => router.navigate(p),
		}),
	);
	router.register(
		"/config",
		createConfigPageHandler(
			send,
			(p) => router.navigate(p),
			() => null,
		),
	);
	return { router, container };
}

describe("single-view navigation invariants", () => {
	let sendSpy: ReturnType<typeof mock>;
	let activeRouter: TestRouter | null = null;

	beforeEach(() => {
		document.body.innerHTML = BASE_DOM;
		sendSpy = mock(() => {});
	});

	afterEach(() => {
		activeRouter?.destroy();
		activeRouter = null;
		document.body.innerHTML = "";
	});

	function startRouter(path: string): TestRouter {
		const { router } = makeRouter(sendSpy);
		activeRouter = router;
		router.setTestPath(path);
		router.start();
		return router;
	}

	test("dashboard shows cards+welcome only; detail and config are hidden", () => {
		startRouter("/");

		expect(isVisible("card-strip")).toBe(true);
		expect(isVisible("welcome-area")).toBe(true);
		expect(isVisible("detail-area")).toBe(false);
		expect(document.querySelector(".config-page")).toBeNull();
	});

	test("navigating to /workflow/:id hides welcome, shows detail, keeps cards, no config", () => {
		const router = startRouter("/");

		router.navigate("/workflow/abc");

		expect(isVisible("card-strip")).toBe(true);
		expect(isVisible("welcome-area")).toBe(false);
		expect(isVisible("detail-area")).toBe(true);
		expect(document.querySelector(".config-page")).toBeNull();
	});

	test("navigating to /epic/:id hides welcome, shows detail, keeps cards, no config", () => {
		const router = startRouter("/");

		router.navigate("/epic/xyz");

		expect(isVisible("card-strip")).toBe(true);
		expect(isVisible("welcome-area")).toBe(false);
		expect(isVisible("detail-area")).toBe(true);
		expect(document.querySelector(".config-page")).toBeNull();
	});

	test("navigating to /config hides cards+welcome+detail and shows config page", () => {
		const router = startRouter("/");

		router.navigate("/config");

		expect(isVisible("card-strip")).toBe(false);
		expect(isVisible("welcome-area")).toBe(false);
		expect(isVisible("detail-area")).toBe(false);
		expect(document.querySelector(".config-page")).not.toBeNull();
	});

	test("navigating from config back to workflow detail removes config page", () => {
		const router = startRouter("/");

		router.navigate("/workflow/abc");
		router.navigate("/config");
		expect(document.querySelector(".config-page")).not.toBeNull();

		router.navigate("/workflow/abc");
		expect(document.querySelector(".config-page")).toBeNull();
		expect(isVisible("detail-area")).toBe(true);
		expect(isVisible("card-strip")).toBe(true);
	});

	test("deep-link /config mounts only the config page", () => {
		startRouter("/config");

		expect(document.querySelector(".config-page")).not.toBeNull();
		expect(isVisible("card-strip")).toBe(false);
		expect(isVisible("welcome-area")).toBe(false);
		expect(isVisible("detail-area")).toBe(false);
	});

	test("deep-link /workflow/:id mounts only the workflow detail view", () => {
		startRouter("/workflow/some-wf-id");

		expect(document.querySelector(".config-page")).toBeNull();
		expect(isVisible("card-strip")).toBe(true);
		expect(isVisible("welcome-area")).toBe(false);
		expect(isVisible("detail-area")).toBe(true);
	});

	test("deep-link /epic/:id mounts only the epic detail view", () => {
		startRouter("/epic/some-epic-id");

		expect(document.querySelector(".config-page")).toBeNull();
		expect(isVisible("card-strip")).toBe(true);
		expect(isVisible("welcome-area")).toBe(false);
		expect(isVisible("detail-area")).toBe(true);
	});

	test("popstate restores the single-view invariant", () => {
		const router = startRouter("/");

		router.navigate("/workflow/abc");
		router.navigate("/config");
		expect(document.querySelector(".config-page")).not.toBeNull();

		router.setTestPath("/workflow/abc");
		window.dispatchEvent(new PopStateEvent("popstate"));

		expect(document.querySelector(".config-page")).toBeNull();
		expect(isVisible("detail-area")).toBe(true);
		expect(isVisible("card-strip")).toBe(true);
	});
});

describe("workflow-detail step-selection persists across remount", () => {
	let sendSpy: ReturnType<typeof mock>;
	let activeRouter: TestRouter | null = null;

	beforeEach(() => {
		document.body.innerHTML = BASE_DOM;
		sendSpy = mock(() => {});
	});

	afterEach(() => {
		activeRouter?.destroy();
		activeRouter = null;
		document.body.innerHTML = "";
	});

	test("re-entering a workflow restores the previously selected step", () => {
		const container = document.getElementById("app-content") as HTMLElement;
		const router = new TestRouter(container, "/");
		activeRouter = router;

		const stateManager = new ClientStateManager();
		// Five-step running workflow with currentStepIndex=3. Steps 0..3 are
		// non-pending (so they are clickable by `renderPipelineSteps`), step 4
		// is pending.
		const steps = (
			[
				{ name: "setup", displayName: "Setup", status: "completed" },
				{ name: "specify", displayName: "Specifying", status: "completed" },
				{ name: "clarify", displayName: "Clarifying", status: "completed" },
				{ name: "plan", displayName: "Planning", status: "running" },
				{ name: "tasks", displayName: "Generating Tasks", status: "pending" },
			] satisfies ReadonlyArray<{
				name: PipelineStepName;
				displayName: string;
				status: "pending" | "running" | "completed" | "failed" | "skipped";
			}>
		).map((s) => ({
			...s,
			output: "",
			outputLog: [],
			error: null,
			startedAt: null,
			completedAt: null,
			history: [],
		}));
		stateManager.handleMessage({
			type: "workflow:list",
			workflows: [
				makeWorkflowState({
					id: "wf-restore",
					status: "running",
					currentStepIndex: 3,
					steps,
				}),
			],
		});

		router.register("/", createDashboardHandler());
		router.register(
			"/workflow/:id",
			createWorkflowDetailHandler({
				getState: () => stateManager,
				getAutoMode: () => "normal",
				getArtifactContext: () => null,
				fetchArtifacts: () => {},
				send: sendSpy,
				navigate: (p) => router.navigate(p),
				openFeedbackPanel: () => {},
			}),
		);
		router.register(
			"/config",
			createConfigPageHandler(
				sendSpy,
				(p) => router.navigate(p),
				() => null,
			),
		);

		router.setTestPath("/workflow/wf-restore");
		router.start();

		// Initial mount lands on the live step (currentStepIndex=3).
		expect(stateManager.getSelectedStepIndex()).toBe(3);
		const stepEls = () => container.querySelectorAll<HTMLElement>("#pipeline-steps .pipeline-step");
		expect(stepEls()[3].classList.contains("step-selected")).toBe(true);

		// Simulate a user click on step 1 (historic step, non-pending → clickable).
		stepEls()[1].click();
		expect(stateManager.getSelectedStepIndex()).toBe(1);
		expect(stepEls()[1].classList.contains("step-selected")).toBe(true);

		// Navigate away to /config, then back to the workflow. The restored
		// selection must survive the full mount → renderFull → autoSelectStep
		// path, not just the selectStepFor() write in mount().
		router.navigate("/config");
		router.navigate("/workflow/wf-restore");

		expect(stateManager.getSelectedStepIndex()).toBe(1);
		const after = container.querySelectorAll<HTMLElement>("#pipeline-steps .pipeline-step");
		expect(after[1].classList.contains("step-selected")).toBe(true);
		expect(after[3].classList.contains("step-selected")).toBe(false);
	});
});

describe("back-to-epic click navigates to /epic/:id", () => {
	let sendSpy: ReturnType<typeof mock>;
	let activeRouter: TestRouter | null = null;

	beforeEach(() => {
		document.body.innerHTML = BASE_DOM;
		sendSpy = mock(() => {});
	});

	afterEach(() => {
		activeRouter?.destroy();
		activeRouter = null;
		document.body.innerHTML = "";
	});

	test("clicking the back button navigates to /epic/<epicId>", () => {
		const container = document.getElementById("app-content") as HTMLElement;
		const router = new TestRouter(container, "/");
		activeRouter = router;

		const stateManager = new ClientStateManager();
		// Seed a child workflow belonging to an epic.
		stateManager.handleMessage({
			type: "workflow:list",
			workflows: [
				makeWorkflowState({
					id: "child-x",
					epicId: "epic-42",
					epicTitle: "Dark mode initiative",
					status: "paused",
				}),
			],
		});

		router.register("/", createDashboardHandler());
		router.register(
			"/workflow/:id",
			createWorkflowDetailHandler({
				getState: () => stateManager,
				getAutoMode: () => "normal",
				getArtifactContext: () => null,
				fetchArtifacts: () => {},
				send: sendSpy,
				navigate: (p) => router.navigate(p),
				openFeedbackPanel: () => {},
			}),
		);
		router.register(
			"/epic/:id",
			createEpicDetailHandler({
				getState: () => stateManager,
				getConfig: () => null,
				send: sendSpy,
				navigate: (p) => router.navigate(p),
			}),
		);

		router.setTestPath("/workflow/child-x");
		router.start();

		const btn = document.getElementById("epic-breadcrumb") as HTMLButtonElement;
		expect(btn).not.toBeNull();
		expect(btn.className).toBe("back-to-epic");
		expect(btn.textContent).toContain("\u2190 Back to ");
		expect(btn.textContent).toContain("Dark mode initiative");

		btn.click();

		expect(router.currentPath).toBe("/epic/epic-42");
		expect(isVisible("detail-area")).toBe(true);
		// After unmount, the workflow-detail's breadcrumb must be gone — proves
		// the previous handler actually unmounted.
		expect(document.getElementById("epic-breadcrumb")).toBeNull();
	});
});
