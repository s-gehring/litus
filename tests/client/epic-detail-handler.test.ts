import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import "../happydom";
import { ClientStateManager } from "../../src/client/client-state-manager";
import { createEpicDetailHandler } from "../../src/client/components/epic-detail-handler";
import { Router } from "../../src/client/router";
import type { ClientMessage, ServerMessage } from "../../src/types";
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

	test("does not invoke confirm() modal", () => {
		mount({
			epicId: "e-1",
			children: [{ id: "wf-1", status: "idle", epicDependencies: [] }],
		});

		const btn = actionButtons().find((b) => b.textContent?.startsWith("Start "));
		btn?.click();
		expect(confirmSpy).not.toHaveBeenCalled();
	});
});
