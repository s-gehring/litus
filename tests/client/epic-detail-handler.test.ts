import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import "../happydom";
import { ClientStateManager } from "../../src/client/client-state-manager";
import { createEpicDetailHandler } from "../../src/client/components/epic-detail-handler";
import { Router } from "../../src/client/router";
import type { ClientMessage, ServerMessage } from "../../src/protocol";
import { makeWorkflowState } from "../helpers";
import { makePersistedEpic } from "../test-infra/factories";

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

function actionButtons(): HTMLButtonElement[] {
	return Array.from(document.querySelectorAll<HTMLButtonElement>("#detail-actions button"));
}

function actionLabels(): string[] {
	return actionButtons().map((b) => b.textContent?.trim() ?? "");
}

interface MountOptions {
	epicId: string;
	children: Parameters<typeof makeWorkflowState>[0][];
	archived?: boolean;
	skipEpicList?: boolean;
}

describe("epic-detail-handler — Start N specs button", () => {
	let router: TestRouter | null = null;
	let sendSpy: ReturnType<typeof mock>;
	let confirmSpy: ReturnType<typeof mock>;
	let state: ClientStateManager;
	let routeHandler: ReturnType<typeof createEpicDetailHandler>;

	beforeEach(() => {
		document.body.innerHTML = BASE_DOM;
		sendSpy = mock(() => {});
		confirmSpy = mock(() => true);
		// Patch global confirm to detect any unexpected modal usage.
		(globalThis as { confirm?: typeof confirm }).confirm = confirmSpy as unknown as typeof confirm;
		state = new ClientStateManager();
	});

	afterEach(() => {
		router?.destroy();
		router = null;
		document.body.innerHTML = "";
	});

	function mount(opts: MountOptions): void {
		const epic = makePersistedEpic({
			epicId: opts.epicId,
			title: "Test Epic",
			workflowIds: opts.children.map((c, i) => c?.id ?? `wf-${i}`),
			archived: opts.archived ?? false,
		});
		const wfs = opts.children.map((c, i) =>
			makeWorkflowState({
				epicId: opts.epicId,
				epicTitle: "Test Epic",
				id: c?.id ?? `wf-${i}`,
				...c,
			}),
		);
		if (!opts.skipEpicList) {
			state.handleMessage({ type: "epic:list", epics: [epic] });
		}
		state.handleMessage({ type: "workflow:list", workflows: wfs });

		const container = document.getElementById("app-content") as HTMLElement;
		router = new TestRouter(container, "/");
		router.register("/", { mount: () => {}, unmount: () => {}, onMessage: () => {} });
		routeHandler = createEpicDetailHandler({
			getState: () => state,
			getConfig: () => null,
			send: sendSpy as unknown as (m: ClientMessage) => void,
			navigate: (p) => router?.navigate(p),
		});
		router.register("/epic/:id", routeHandler);
		router.setTestPath(`/epic/${opts.epicId}`);
		router.start();
	}

	function dispatch(msg: ServerMessage): void {
		routeHandler.onMessage?.(msg);
	}

	test("renders 'Start N specs' label when N idle first-level specs exist", () => {
		mount({
			epicId: "e-1",
			children: [
				{ id: "wf-1", status: "idle", epicDependencies: [] },
				{ id: "wf-2", status: "idle", epicDependencies: [] },
				{ id: "wf-3", status: "idle", epicDependencies: ["wf-1"] },
			],
		});
		expect(actionLabels()).toContain("Start 2 specs");
	});

	test("button is hidden when no idle first-level specs exist", () => {
		mount({
			epicId: "e-1",
			children: [{ id: "wf-1", status: "running", epicDependencies: [] }],
		});
		expect(actionLabels().some((l) => l.startsWith("Start "))).toBe(false);
	});

	test("button is hidden when epic has no workflows", () => {
		mount({ epicId: "e-empty", children: [] });
		expect(actionLabels().some((l) => l.startsWith("Start "))).toBe(false);
	});

	test("button is hidden when every first-level spec is non-idle", () => {
		mount({
			epicId: "e-1",
			children: [
				{ id: "wf-1", status: "completed", epicDependencies: [] },
				{ id: "wf-2", status: "running", epicDependencies: [] },
				{ id: "wf-3", status: "idle", epicDependencies: ["wf-1"] },
			],
		});
		expect(actionLabels().some((l) => l.startsWith("Start "))).toBe(false);
	});

	test("clicking sends epic:start-first-level with the epicId", () => {
		mount({
			epicId: "e-1",
			children: [{ id: "wf-1", status: "idle", epicDependencies: [] }],
		});

		const btn = actionButtons().find((b) => b.textContent?.startsWith("Start "));
		expect(btn).toBeDefined();
		btn?.click();

		expect(sendSpy).toHaveBeenCalledTimes(1);
		expect(sendSpy.mock.calls[0]?.[0]).toEqual({
			type: "epic:start-first-level",
			epicId: "e-1",
		});
	});

	test("button shows disabled+loading state while in flight", () => {
		mount({
			epicId: "e-1",
			children: [{ id: "wf-1", status: "idle", epicDependencies: [] }],
		});

		const btn = actionButtons().find((b) => b.textContent?.startsWith("Start "));
		btn?.click();

		const after = actionButtons().find(
			(b) => b.className.includes("btn-loading") || b.textContent?.includes("Starting"),
		);
		expect(after).toBeDefined();
		expect(after?.className).toContain("btn-disabled");
		expect(after?.className).toContain("btn-loading");
	});

	test("in-flight flag clears on epic:start-first-level:result", () => {
		mount({
			epicId: "e-1",
			children: [{ id: "wf-1", status: "idle", epicDependencies: [] }],
		});

		const btn = actionButtons().find((b) => b.textContent?.startsWith("Start "));
		btn?.click();
		expect(actionButtons().some((b) => b.className.includes("btn-loading"))).toBe(true);

		dispatch({
			type: "epic:start-first-level:result",
			epicId: "e-1",
			started: ["wf-1"],
			skipped: [],
			failed: [],
		});

		expect(actionButtons().some((b) => b.className.includes("btn-loading"))).toBe(false);
	});

	test("renders singular 'Start 1 spec' label when exactly one idle first-level spec exists", () => {
		mount({
			epicId: "e-1",
			children: [
				{ id: "wf-1", status: "idle", epicDependencies: [] },
				{ id: "wf-2", status: "idle", epicDependencies: ["wf-1"] },
			],
		});
		expect(actionLabels()).toContain("Start 1 spec");
	});

	test("in-flight flag is NOT cleared by an unrelated error message — only :result clears it", () => {
		// Generic `error` envelopes have no request-id correlation, so a stray
		// error from another feature must not flip the bulk-start spinner off.
		// The :result envelope is the canonical clear.
		mount({
			epicId: "e-1",
			children: [{ id: "wf-1", status: "idle", epicDependencies: [] }],
		});

		const btn = actionButtons().find((b) => b.textContent?.startsWith("Start "));
		btn?.click();
		expect(actionButtons().some((b) => b.className.includes("btn-loading"))).toBe(true);

		dispatch({ type: "error", message: "something else went wrong" });

		expect(actionButtons().some((b) => b.className.includes("btn-loading"))).toBe(true);
	});

	test("button is visible when only workflows are loaded (epic:list not yet received)", () => {
		// Repro for the "Start Epic button not visible on already existing epics"
		// bug: workflow:list arrives before epic:list (or epic data is missing
		// entirely for an orphan epic). The aggregate exists, but `state.getEpics()`
		// has no entry. The Start button only needs the epicId and children, so
		// it must still render.
		mount({
			epicId: "e-1",
			skipEpicList: true,
			children: [
				{ id: "wf-1", status: "idle", epicDependencies: [] },
				{ id: "wf-2", status: "idle", epicDependencies: [] },
			],
		});
		expect(actionLabels()).toContain("Start 2 specs");
	});

	test("does not invoke confirm() modal", () => {
		mount({
			epicId: "e-1",
			children: [{ id: "wf-1", status: "idle", epicDependencies: [] }],
		});

		const btn = actionButtons().find((b) => b.textContent?.startsWith("Start "));
		btn?.click();
		expect(confirmSpy).not.toHaveBeenCalled();
	});

	test("Start button uses stable testid 'action-start-children' regardless of count", () => {
		mount({
			epicId: "e-1",
			children: [
				{ id: "wf-1", status: "idle", epicDependencies: [] },
				{ id: "wf-2", status: "idle", epicDependencies: [] },
				{ id: "wf-3", status: "idle", epicDependencies: [] },
			],
		});
		const ids = actionButtons().map((b) => b.getAttribute("data-testid") ?? "");
		expect(ids).toContain("action-start-children");
		// Label has the count, but the selector is key-derived, not label-derived.
		const startBtn = actionButtons().find(
			(b) => b.getAttribute("data-testid") === "action-start-children",
		);
		expect(startBtn?.textContent).toBe("Start 3 specs");
	});
});

describe("epic-detail-handler — batch run-controls", () => {
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

	function mount(opts: MountOptions): void {
		const epic = makePersistedEpic({
			epicId: opts.epicId,
			title: "Test Epic",
			workflowIds: opts.children.map((c, i) => c?.id ?? `wf-${i}`),
			archived: opts.archived ?? false,
		});
		const wfs = opts.children.map((c, i) =>
			makeWorkflowState({
				epicId: opts.epicId,
				epicTitle: "Test Epic",
				id: c?.id ?? `wf-${i}`,
				...c,
			}),
		);
		state.handleMessage({ type: "epic:list", epics: [epic] });
		state.handleMessage({ type: "workflow:list", workflows: wfs });
		const container = document.getElementById("app-content") as HTMLElement;
		router = new TestRouter(container, "/");
		router.register("/", { mount: () => {}, unmount: () => {}, onMessage: () => {} });
		router.register(
			"/epic/:id",
			createEpicDetailHandler({
				getState: () => state,
				getConfig: () => null,
				send: sendSpy as unknown as (m: ClientMessage) => void,
				navigate: (p) => router?.navigate(p),
			}),
		);
		router.setTestPath(`/epic/${opts.epicId}`);
		router.start();
	}

	test("Pause all is shown only when at least one child is running", () => {
		mount({
			epicId: "e-1",
			children: [
				{ id: "wf-1", status: "running", epicDependencies: [] },
				{ id: "wf-2", status: "completed", epicDependencies: [] },
			],
		});
		const ids = actionButtons().map((b) => b.getAttribute("data-testid") ?? "");
		expect(ids).toContain("action-pause-all");
	});

	test("Pause all is hidden when no child is running", () => {
		mount({
			epicId: "e-1",
			children: [
				{ id: "wf-1", status: "paused", epicDependencies: [] },
				{ id: "wf-2", status: "completed", epicDependencies: [] },
			],
		});
		const ids = actionButtons().map((b) => b.getAttribute("data-testid") ?? "");
		expect(ids).not.toContain("action-pause-all");
	});

	test("Resume all is shown only when at least one child is paused", () => {
		mount({
			epicId: "e-1",
			children: [
				{ id: "wf-1", status: "paused", epicDependencies: [] },
				{ id: "wf-2", status: "running", epicDependencies: [] },
			],
		});
		const ids = actionButtons().map((b) => b.getAttribute("data-testid") ?? "");
		expect(ids).toContain("action-resume-all");
	});

	test("Abort all is shown when at least one child is in an abortable state", () => {
		mount({
			epicId: "e-1",
			children: [
				{ id: "wf-1", status: "paused", epicDependencies: [] },
				{ id: "wf-2", status: "completed", epicDependencies: [] },
			],
		});
		const ids = actionButtons().map((b) => b.getAttribute("data-testid") ?? "");
		expect(ids).toContain("action-abort-all");
	});

	test("Abort all is hidden when every child is terminal or only running", () => {
		mount({
			epicId: "e-1",
			children: [
				{ id: "wf-1", status: "running", epicDependencies: [] },
				{ id: "wf-2", status: "completed", epicDependencies: [] },
				{ id: "wf-3", status: "aborted", epicDependencies: [] },
			],
		});
		const ids = actionButtons().map((b) => b.getAttribute("data-testid") ?? "");
		expect(ids).not.toContain("action-abort-all");
	});

	test("Pause-all click sends epic:pause-all without a confirm", () => {
		mount({
			epicId: "e-1",
			children: [{ id: "wf-1", status: "running", epicDependencies: [] }],
		});
		const btn = actionButtons().find((b) => b.getAttribute("data-testid") === "action-pause-all");
		btn?.click();
		expect(sendSpy).toHaveBeenCalledWith({ type: "epic:pause-all", epicId: "e-1" });
	});

	test("Abort-all click opens a modal confirm and only sends on confirm", async () => {
		mount({
			epicId: "e-1",
			children: [{ id: "wf-1", status: "paused", epicDependencies: [] }],
		});
		const btn = actionButtons().find((b) => b.getAttribute("data-testid") === "action-abort-all");
		btn?.click();
		await Promise.resolve();
		expect(document.querySelector(".confirm-modal")).not.toBeNull();
		// Cancel ⇒ no send.
		(document.querySelector(".confirm-modal .btn-secondary") as HTMLButtonElement | null)?.click();
		await Promise.resolve();
		await Promise.resolve();
		expect(
			sendSpy.mock.calls.some((c) => (c?.[0] as { type?: string })?.type === "epic:abort-all"),
		).toBe(false);
	});

	test("Archive button on a running epic is disabled with reason tooltip", () => {
		mount({
			epicId: "e-1",
			children: [{ id: "wf-1", status: "running", epicDependencies: [] }],
		});
		const archive = actionButtons().find((b) => b.getAttribute("data-testid") === "action-archive");
		expect(archive).toBeDefined();
		expect(archive?.disabled).toBe(true);
		expect(archive?.title).toBe("Cannot archive while children are running");
	});

	test("button order respects slot contract (primary, secondary, destructive, finalize)", () => {
		mount({
			epicId: "e-1",
			children: [
				{ id: "wf-1", status: "paused", epicDependencies: [], hasEverStarted: true },
				{ id: "wf-2", status: "running", epicDependencies: [], hasEverStarted: true },
			],
		});
		const slots = actionButtons().map((b) => b.getAttribute("data-slot") ?? "");
		// Expected: pause-all (secondary), resume-all (secondary), abort-all
		// (destructive), archive (finalize). No primary (no eligible specs).
		expect(slots).toEqual(["secondary", "secondary", "destructive", "finalize"]);
	});

	test("Archive on an all-terminal epic renders without confirm or disabled state", () => {
		// Once every child reaches a terminal status (completed/aborted/error),
		// `nonTerminal === false` and `anyRunning === false`, so Archive
		// renders enabled and uses only the registry confirm copy. Pinned to
		// detect any regression that would surface a confusing "0 workflows
		// have not finished" override on a settled epic.
		mount({
			epicId: "e-done",
			children: [
				{ id: "wf-1", status: "completed", epicDependencies: [] },
				{ id: "wf-2", status: "completed", epicDependencies: [] },
			],
		});
		const archive = actionButtons().find((b) => b.getAttribute("data-testid") === "action-archive");
		expect(archive).toBeDefined();
		expect(archive?.disabled).toBe(false);
		expect(archive?.title).toBe("");
	});
});

describe("epic-detail-handler — action bar refresh on workflow:state", () => {
	let router: TestRouter | null = null;
	let sendSpy: ReturnType<typeof mock>;
	let state: ClientStateManager;
	let routeHandler: ReturnType<typeof createEpicDetailHandler>;

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

	function mount(opts: MountOptions): void {
		const epic = makePersistedEpic({
			epicId: opts.epicId,
			title: "Test Epic",
			workflowIds: opts.children.map((c, i) => c?.id ?? `wf-${i}`),
			archived: opts.archived ?? false,
		});
		const wfs = opts.children.map((c, i) =>
			makeWorkflowState({
				epicId: opts.epicId,
				epicTitle: "Test Epic",
				id: c?.id ?? `wf-${i}`,
				...c,
			}),
		);
		state.handleMessage({ type: "epic:list", epics: [epic] });
		state.handleMessage({ type: "workflow:list", workflows: wfs });
		const container = document.getElementById("app-content") as HTMLElement;
		router = new TestRouter(container, "/");
		router.register("/", { mount: () => {}, unmount: () => {}, onMessage: () => {} });
		routeHandler = createEpicDetailHandler({
			getState: () => state,
			getConfig: () => null,
			send: sendSpy as unknown as (m: ClientMessage) => void,
			navigate: (p) => router?.navigate(p),
		});
		router.register("/epic/:id", routeHandler);
		router.setTestPath(`/epic/${opts.epicId}`);
		router.start();
	}

	function dispatch(msg: ServerMessage): void {
		routeHandler.onMessage?.(msg);
	}

	test("transitioning a child running→paused refreshes Pause-all → Resume-all", () => {
		mount({
			epicId: "e-1",
			children: [{ id: "wf-1", status: "running", epicDependencies: [] }],
		});
		expect(actionButtons().map((b) => b.getAttribute("data-testid"))).toContain("action-pause-all");
		expect(actionButtons().map((b) => b.getAttribute("data-testid"))).not.toContain(
			"action-resume-all",
		);

		const updated = makeWorkflowState({
			id: "wf-1",
			epicId: "e-1",
			epicTitle: "Test Epic",
			status: "paused",
			epicDependencies: [],
		});
		state.handleMessage({ type: "workflow:state", workflow: updated });
		dispatch({ type: "workflow:state", workflow: updated });

		const ids = actionButtons().map((b) => b.getAttribute("data-testid"));
		expect(ids).not.toContain("action-pause-all");
		expect(ids).toContain("action-resume-all");
	});

	test("transitioning the last running child to completed unlocks Archive", () => {
		mount({
			epicId: "e-1",
			children: [{ id: "wf-1", status: "running", epicDependencies: [] }],
		});
		const archiveBefore = actionButtons().find(
			(b) => b.getAttribute("data-testid") === "action-archive",
		);
		expect(archiveBefore?.disabled).toBe(true);

		const updated = makeWorkflowState({
			id: "wf-1",
			epicId: "e-1",
			epicTitle: "Test Epic",
			status: "completed",
			epicDependencies: [],
		});
		state.handleMessage({ type: "workflow:state", workflow: updated });
		dispatch({ type: "workflow:state", workflow: updated });

		const archiveAfter = actionButtons().find(
			(b) => b.getAttribute("data-testid") === "action-archive",
		);
		expect(archiveAfter?.disabled).toBe(false);
	});
});

describe("epic-detail-handler — thinking indicator during decomposition", () => {
	let router: TestRouter | null = null;
	let state: ClientStateManager;
	let routeHandler: ReturnType<typeof createEpicDetailHandler>;

	beforeEach(() => {
		document.body.innerHTML = BASE_DOM;
		state = new ClientStateManager();
	});

	afterEach(() => {
		router?.destroy();
		router = null;
		document.body.innerHTML = "";
	});

	function mountAnalyzing(epicId: string): void {
		const epic = makePersistedEpic({
			epicId,
			status: "analyzing",
			title: null,
			workflowIds: [],
		});
		state.handleMessage({ type: "epic:list", epics: [epic] });
		const container = document.getElementById("app-content") as HTMLElement;
		router = new TestRouter(container, "/");
		router.register("/", { mount: () => {}, unmount: () => {}, onMessage: () => {} });
		routeHandler = createEpicDetailHandler({
			getState: () => state,
			getConfig: () => null,
			send: () => {},
			navigate: (p) => router?.navigate(p),
		});
		router.register("/epic/:id", routeHandler);
		router.setTestPath(`/epic/${epicId}`);
		router.start();
	}

	function dispatch(msg: ServerMessage): void {
		routeHandler.onMessage?.(msg);
	}

	test("renders a thinking indicator while the epic is analyzing", () => {
		// Regression guard: parity with workflow detail's per-step dots — every
		// LLM use must show a thinking indicator, including epic decomposition.
		mountAnalyzing("e-analyzing");
		const log = document.getElementById("output-log");
		const indicator = log?.querySelector(".thinking-indicator");
		expect(indicator).not.toBeNull();
		expect(indicator?.classList.contains("visible")).toBe(true);
		expect(indicator?.querySelectorAll(".thinking-dot").length).toBe(3);
	});

	test("indicator is removed once the epic settles into infeasible", () => {
		mountAnalyzing("e-soon-infeasible");
		expect(document.querySelector(".thinking-indicator")).not.toBeNull();

		const settled = makePersistedEpic({
			epicId: "e-soon-infeasible",
			status: "infeasible",
			title: null,
			infeasibleNotes: "Cannot decompose this epic.",
			workflowIds: [],
		});
		state.handleMessage({ type: "epic:list", epics: [settled] });
		dispatch({
			type: "epic:infeasible",
			epicId: "e-soon-infeasible",
			title: "",
			infeasibleNotes: "Cannot decompose this epic.",
		});

		expect(document.querySelector(".thinking-indicator")).toBeNull();
	});
});
