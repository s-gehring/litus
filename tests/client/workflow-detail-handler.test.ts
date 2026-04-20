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

	test("errored workflow renders both 'Retry step' and 'Retry workflow' buttons", () => {
		mountForWorkflow({ id: "wf-err", status: "error" });
		const labels = actionLabels();
		expect(labels).toContain("Retry step");
		expect(labels).toContain("Retry workflow");
		// Generated testids must match what the e2e page-object expects.
		const testids = actionTestIds();
		expect(testids).toContain("action-retry-step");
		expect(testids).toContain("action-retry-workflow");
	});

	test("aborted workflow renders only 'Retry workflow' (not 'Retry step')", () => {
		mountForWorkflow({ id: "wf-abort", status: "aborted" });
		const labels = actionLabels();
		expect(labels).toContain("Retry workflow");
		expect(labels).not.toContain("Retry step");
	});

	test("idle workflow renders neither retry button", () => {
		mountForWorkflow({ id: "wf-idle", status: "idle" });
		const labels = actionLabels();
		expect(labels).not.toContain("Retry step");
		expect(labels).not.toContain("Retry workflow");
	});
});
