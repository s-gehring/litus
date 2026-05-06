import type { AppConfig, AutoMode } from "../config-types";
import { looksLikeGitUrl } from "../git-url";
import type { PipelineStepName } from "../pipeline-steps";
import type { ClientMessage, ServerMessage } from "../protocol";
import {
	type Alert,
	type ArtifactDescriptor,
	type ArtifactListResponse,
	ASK_QUESTION_MAX_LENGTH,
	RESUME_WITH_FEEDBACK_MAX_LENGTH,
	type WorkflowState,
} from "../types";
import { ClientStateManager } from "./client-state-manager";
import {
	hideAlertList,
	initAlertList,
	refreshAlertList,
	showAlertList,
} from "./components/alert-list";
import { initAlertToasts, removeAlertToast, showAlertToast } from "./components/alert-toast";
import { updateArchiveCount } from "./components/archive-count-badge";
import { createArchiveHandler } from "./components/archive-handler";
import {
	createConfigPageHandler,
	hidePurgeProgress,
	reportTelegramConfigError,
	reportTelegramStatus,
	reportTelegramTestResult,
	showPurgeProgress,
	updateConfigPage,
	updatePurgeProgress,
} from "./components/config-page";
import type { TelegramStatusProjection } from "./components/config-page-telegram";
import { createModal, type Modal } from "./components/creation-modal";
import { createDashboardHandler } from "./components/dashboard-handler";
import { epicCreatedTarget } from "./components/epic-created-route";
import { createEpicDetailHandler } from "./components/epic-detail-handler";
import { updateFavicon } from "./components/favicon";
import { showFeedbackPanel } from "./components/feedback-panel";
import { createFolderPicker } from "./components/folder-picker";
import {
	type PipelineStepsArtifactContext,
	renderPipelineSteps,
} from "./components/pipeline-steps";
import { getAnswer } from "./components/question-panel";
import { EPIC_CARD_PREFIX } from "./components/status-maps";
import { renderCardStrip, updateTimers } from "./components/workflow-cards";
import { workflowCreatedTarget } from "./components/workflow-created-route";
import { createWorkflowDetailHandler } from "./components/workflow-detail-handler";
import { appendOutput, setDefaultModelDisplayName } from "./components/workflow-window";
import { $ } from "./dom";
import { attachFolderValidation } from "./folder-validation";
import { Router } from "./router";

const stateManager = new ClientStateManager(send);

// Per-workflow cache of artifacts grouped by step, populated by fetchWorkflowArtifacts.
const artifactsByWorkflow = new Map<string, Map<PipelineStepName, ArtifactDescriptor[]>>();
// Tracks in-flight artifact fetches so a burst of `workflow:state` / `workflow:list`
// broadcasts during the first request's async window doesn't spawn parallel
// duplicates. Cleared when the request resolves (success or failure).
const artifactsFetchInFlight = new Set<string>();

function getArtifactContext(workflowId: string): PipelineStepsArtifactContext | null {
	const byStep = artifactsByWorkflow.get(workflowId);
	if (!byStep) return null;
	return { workflowId, byStep };
}

async function fetchWorkflowArtifacts(workflowId: string): Promise<void> {
	if (artifactsFetchInFlight.has(workflowId)) return;
	artifactsFetchInFlight.add(workflowId);
	try {
		const res = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/artifacts`, {
			cache: "no-store",
		});
		if (!res.ok) return;
		const body = (await res.json()) as ArtifactListResponse;
		const byStep = new Map<PipelineStepName, ArtifactDescriptor[]>();
		for (const item of body.items) {
			const arr = byStep.get(item.step) ?? [];
			arr.push(item);
			byStep.set(item.step, arr);
		}
		artifactsByWorkflow.set(workflowId, byStep);
		if (isViewingWorkflow(workflowId)) {
			const entry = stateManager.getWorkflows().get(workflowId);
			if (entry) {
				renderPipelineSteps(
					entry.state,
					stateManager.getSelectedStepIndex(),
					(index) => workflowDetailSelectStep?.(index),
					getArtifactContext(workflowId),
				);
			}
		}
	} catch (err) {
		console.warn("fetchWorkflowArtifacts failed", err);
	} finally {
		artifactsFetchInFlight.delete(workflowId);
	}
}

// Bridge so `fetchWorkflowArtifacts`'s re-render of the pipeline strip can
// dispatch step clicks back into the workflow-detail handler instead of a
// no-op. Set while the handler is mounted; cleared on unmount.
let workflowDetailSelectStep: ((index: number) => void) | null = null;

let appRouter: Router | null = null;

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let currentAutoMode: AutoMode = "normal";
let latestConfig: AppConfig | null = null;
let cachedTelegramStatus: TelegramStatusProjection | null = null;

function getWsUrl(): string {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${location.host}/ws`;
}

function connect(): void {
	if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
		return;
	}

	ws = new WebSocket(getWsUrl());

	ws.onopen = () => {
		const dot = $("#connection-status");
		dot.className = "status-dot connected";
		dot.title = "Connected";

		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}

		send({ type: "config:get" });
		const path = appRouter?.currentPath;
		if (path) send({ type: "alert:route-changed", path });
	};

	ws.onclose = () => {
		const dot = $("#connection-status");
		dot.className = "status-dot disconnected";
		dot.title = "Disconnected";

		for (const [, handlers] of pendingCloneSubmissions) {
			handlers.onError(
				"disconnected",
				"Lost connection to the server while cloning. Please try again once reconnected.",
			);
		}
		pendingCloneSubmissions.clear();

		scheduleReconnect();
	};

	ws.onerror = () => {};

	ws.onmessage = (event) => {
		try {
			const msg = JSON.parse(event.data) as ServerMessage;
			handleMessage(msg);
		} catch (err) {
			console.warn("[ws] Failed to parse message:", err);
		}
	};
}

function scheduleReconnect(): void {
	if (reconnectTimer) return;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		connect();
	}, 2000);
}

function send(msg: ClientMessage): void {
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(msg));
	}
}

function isViewingWorkflow(workflowId: string): boolean {
	return (
		appRouter?.currentMatch?.params?.id === workflowId &&
		appRouter?.currentPath?.startsWith("/workflow/") === true
	);
}

function activeCardId(): string | null {
	const path = appRouter?.currentPath ?? null;
	if (!path) return null;
	const wfMatch = path.match(/^\/workflow\/(.+)$/);
	if (wfMatch) {
		const id = wfMatch[1];
		const entry = stateManager.getWorkflows().get(id);
		if (entry?.state.epicId) return `${EPIC_CARD_PREFIX}${entry.state.epicId}`;
		return id;
	}
	const epicMatch = path.match(/^\/epic\/(.+)$/);
	if (epicMatch) {
		const id = epicMatch[1];
		// Epic analysis card (no prefix) if the aggregate isn't present yet.
		if (stateManager.getEpicAggregates().has(id)) return `${EPIC_CARD_PREFIX}${id}`;
		return id;
	}
	return null;
}

function handleMessage(msg: ServerMessage): void {
	// Side-effects (state mutation, dev-console logging for `console:output`
	// and unrouted-fallback diagnostics) live in `stateManager.handleMessage`.
	// The switch below only translates state changes into UI updates; cases
	// for purely-side-effect messages are intentional no-ops.
	stateManager.handleMessage(msg);

	switch (msg.type) {
		case "workflow:list": {
			// Production-safe test observability: one dataset write per workflow:list
			// broadcast, no reader outside E2E. Lets tests distinguish a fresh
			// broadcast from cached state (e.g., after a reconnect). Gating this
			// client-side would require threading an env/query flag through the
			// bundle; the cost is negligible and it is not read in production.
			const prev = Number(document.body.dataset.workflowListRevision ?? "0");
			document.body.dataset.workflowListRevision = String(prev + 1);
			renderCards();
			// Pre-existing behaviour: on the dashboard, when exactly one top-level
			// item exists, jump into its detail view. The `currentPath === "/"`
			// guard prevents re-triggering on subsequent broadcasts.
			if (appRouter?.currentPath === "/") {
				const standalone = msg.workflows.filter((w) => !w.epicId);
				const epicAggregates = stateManager.getEpicAggregates();
				if (standalone.length === 1 && epicAggregates.size === 0) {
					appRouter.navigate(`/workflow/${standalone[0].id}`, { replace: true });
				} else if (epicAggregates.size === 1 && standalone.length === 0) {
					const epicId = [...epicAggregates.keys()][0];
					appRouter.navigate(`/epic/${epicId}`, { replace: true });
				}
			}
			break;
		}

		case "workflow:created": {
			renderCards();
			const target = workflowCreatedTarget(msg.workflow, appRouter?.currentPath ?? null);
			if (target) appRouter?.navigate(target);
			break;
		}

		case "workflow:removed":
		case "workflow:state":
		case "workflow:output":
		case "workflow:tools":
		case "workflow:question":
		case "workflow:step-change": {
			renderCards();
			break;
		}

		case "epic:list": {
			renderCards();
			break;
		}

		case "epic:created": {
			renderCards();
			const target = epicCreatedTarget(msg.epicId, appRouter?.currentPath ?? null);
			if (target) appRouter?.navigate(target);
			break;
		}

		case "epic:summary":
		case "epic:output":
		case "epic:tools":
		case "epic:result":
		case "epic:infeasible":
		case "epic:error":
		case "epic:dependency-update":
		case "epic:feedback:accepted":
		case "epic:feedback:rejected":
		case "epic:feedback:history": {
			renderCards();
			break;
		}

		case "purge:progress": {
			showPurgeProgress();
			updatePurgeProgress(msg.step, msg.current, msg.total);
			break;
		}

		case "purge:complete": {
			hidePurgeProgress();
			appRouter?.navigate("/");
			renderCards();
			if (msg.warnings.length > 0) {
				appendOutput(`Purge completed with warnings: ${msg.warnings.join("; ")}`, "error");
			}
			break;
		}

		case "purge:error": {
			hidePurgeProgress();
			appendOutput(`Purge aborted: ${msg.message}`, "error");
			if (msg.warnings.length > 0) {
				appendOutput(`Partial warnings before abort: ${msg.warnings.join("; ")}`, "error");
			}
			break;
		}

		case "default-model:info": {
			setDefaultModelDisplayName(msg.modelInfo ? msg.modelInfo.displayName : null);
			break;
		}

		case "config:state": {
			updateConfigPage(msg.config, msg.warnings);
			syncAutoModeToggle(msg.config.autoMode);
			currentAutoMode = msg.config.autoMode;
			latestConfig = msg.config;
			break;
		}

		case "config:error": {
			if (msg.errors.length > 0) {
				appendOutput(`Config error: ${msg.errors[0].path} — ${msg.errors[0].message}`, "error");
			}
			reportTelegramConfigError(msg.errors);
			break;
		}

		case "telegram:status": {
			cachedTelegramStatus = {
				unacknowledgedCount: msg.unacknowledgedCount,
				lastFailureReason: msg.lastFailureReason,
				lastFailureAt: msg.lastFailureAt,
			};
			reportTelegramStatus(cachedTelegramStatus);
			break;
		}

		case "telegram:test-result": {
			reportTelegramTestResult(
				msg.ok ? { ok: true } : { ok: false, errorCode: msg.errorCode, reason: msg.reason },
			);
			break;
		}

		case "console:output": {
			// Intentional no-op — see comment at top of handleMessage.
			break;
		}

		case "error": {
			appendOutput(`Error: ${msg.message}`, "error");
			break;
		}

		case "workflow:feedback:ok": {
			if (msg.warning === "prompt-injection-failed") {
				appendOutput(
					`Feedback recorded, but prompt delivery failed — workflow is now ${msg.workflowStatusAfter ?? "error"}.`,
					"error",
				);
			}
			renderCards();
			break;
		}

		case "workflow:feedback:rejected": {
			const reasonMessages: Record<typeof msg.reason, string> = {
				"workflow-not-paused": "Workflow is no longer paused — feedback was discarded.",
				"step-not-resumable": "Current step does not support feedback resume.",
				"text-length": `Feedback text is empty or exceeds ${RESUME_WITH_FEEDBACK_MAX_LENGTH.toLocaleString("en-US")} characters.`,
				"workflow-not-found": "Workflow not found.",
			};
			appendOutput(`Feedback rejected: ${reasonMessages[msg.reason]}`, "error");
			renderCards();
			break;
		}

		case "workflow:archive-denied": {
			showAlertToast({
				id: `archive-denied-${Date.now()}`,
				type: "error",
				title: "Archive refused",
				description: msg.message,
				workflowId: msg.workflowId,
				epicId: msg.epicId,
				targetRoute: "/",
				createdAt: Date.now(),
				seen: true,
			});
			break;
		}

		case "repo:clone-start": {
			pendingCloneSubmissions.get(msg.submissionId)?.onStart(msg.owner, msg.repo, msg.reused);
			break;
		}

		case "repo:clone-progress": {
			pendingCloneSubmissions.get(msg.submissionId)?.onProgress(msg.step, msg.message);
			break;
		}

		case "repo:clone-complete": {
			const handlers = pendingCloneSubmissions.get(msg.submissionId);
			if (!handlers) break;
			handlers.onComplete();
			break;
		}

		case "repo:clone-error": {
			pendingCloneSubmissions.get(msg.submissionId)?.onError(msg.code, msg.message);
			pendingCloneSubmissions.delete(msg.submissionId);
			break;
		}

		case "alert:list": {
			renderAlertBell();
			refreshAlertList();
			break;
		}

		case "alert:created": {
			showAlertToast(msg.alert);
			renderAlertBell();
			refreshAlertList();
			break;
		}

		case "alert:dismissed": {
			for (const id of msg.alertIds) removeAlertToast(id);
			renderAlertBell();
			refreshAlertList();
			break;
		}

		case "alert:seen": {
			// Keep live toasts visible on `alert:seen` so a user in tab A isn't
			// surprised when tab B's navigation auto-sees the alert. Toasts only
			// disappear on explicit dismissal (`alert:dismissed`).
			renderAlertBell();
			refreshAlertList();
			break;
		}
	}

	// Forward every message to the currently mounted route handler so detail
	// views can update their own DOM without the top-level switch knowing about
	// per-view rendering.
	appRouter?.forwardMessage(msg);
}

function showMissingTargetToast(message: string): void {
	showAlertToast({
		id: `transient_${Date.now()}`,
		type: "error",
		title: "Alert target unavailable",
		description: message,
		workflowId: null,
		epicId: null,
		targetRoute: "",
		createdAt: Date.now(),
		seen: false,
	});
}

function navigateToAlertTarget(alert: Alert): void {
	hideAlertList();
	const target = alert.targetRoute;
	if (!target) return;
	const workflowMatch = target.match(/^\/workflow\/(.+)$/);
	const epicMatch = target.match(/^\/epic\/(.+)$/);
	if (workflowMatch) {
		const wfId = workflowMatch[1];
		const entry = stateManager.getWorkflows().get(wfId);
		if (!entry) {
			showMissingTargetToast("This workflow no longer exists");
			return;
		}
		appRouter?.navigate(`/workflow/${wfId}`);
		return;
	}
	if (epicMatch) {
		const epicId = epicMatch[1];
		const hasEpic =
			stateManager.getEpics().has(epicId) || stateManager.getEpicAggregates().has(epicId);
		if (!hasEpic) {
			showMissingTargetToast("This epic no longer exists");
			return;
		}
		appRouter?.navigate(`/epic/${epicId}`);
	}
}

function renderAlertBell(): void {
	let count = 0;
	for (const a of stateManager.getAlerts().values()) {
		if (!a.seen) count++;
	}
	updateFavicon(count > 0);
	const btn = document.getElementById("btn-alert-bell");
	if (!btn) return;
	const badge = btn.querySelector(".bell-count");
	if (badge) {
		if (count > 0) {
			badge.textContent = String(count);
			badge.classList.remove("hidden");
		} else {
			badge.classList.add("hidden");
		}
	}
}

interface PendingCloneHandlers {
	onStart: (owner: string, repo: string, reused: boolean) => void;
	onProgress: (step: string, message?: string) => void;
	onComplete: () => void;
	onError: (code: string, message: string) => void;
}

const pendingCloneSubmissions = new Map<string, PendingCloneHandlers>();

function attachCloneSubmission(
	modal: Modal,
	cloneStatus: HTMLElement,
	errorEl: HTMLElement,
	setFormDisabled: (disabled: boolean) => void,
	submissionId: string,
): void {
	cloneStatus.textContent = "Preparing clone…";
	cloneStatus.classList.remove("hidden");
	setFormDisabled(true);

	pendingCloneSubmissions.set(submissionId, {
		onStart: (owner, repo, reused) => {
			cloneStatus.textContent = reused
				? `Reusing existing clone ${owner}/${repo}…`
				: `Cloning ${owner}/${repo}…`;
		},
		onProgress: (step, message) => {
			cloneStatus.textContent = message ? `${step}: ${message}` : `${step}…`;
		},
		onComplete: () => {
			modal.hide();
		},
		onError: (_code, message) => {
			cloneStatus.classList.add("hidden");
			setFormDisabled(false);
			errorEl.textContent = message;
			errorEl.classList.remove("hidden");
		},
	});

	const origHide = modal.hide;
	modal.hide = () => {
		pendingCloneSubmissions.delete(submissionId);
		origHide();
	};
}

function handleCardClick(cardId: string): void {
	if (cardId.startsWith(EPIC_CARD_PREFIX)) {
		const epicId = cardId.slice(EPIC_CARD_PREFIX.length);
		appRouter?.navigate(`/epic/${epicId}`);
		return;
	}
	if (stateManager.getWorkflows().has(cardId)) {
		appRouter?.navigate(`/workflow/${cardId}`);
		return;
	}
	// Epic analysis card — raw epicId
	appRouter?.navigate(`/epic/${cardId}`);
}

const AUTO_MODE_CYCLE = ["manual", "normal", "full-auto"] as const;
const AUTO_MODE_LABELS: Record<string, { icon: string; label: string; className: string }> = {
	manual: { icon: "⏸", label: "Manual", className: "mode-manual" },
	normal: { icon: "▶", label: "Normal", className: "mode-normal" },
	"full-auto": { icon: "⏩", label: "Full Auto", className: "mode-full-auto" },
};

function syncAutoModeToggle(mode: string): void {
	const btn = document.getElementById("btn-auto-mode");
	if (!btn) return;
	const info = AUTO_MODE_LABELS[mode] ?? AUTO_MODE_LABELS.normal;
	btn.className = `btn-header btn-toggle ${info.className}`;
	const icon = btn.querySelector(".toggle-icon");
	if (icon) icon.textContent = info.icon;
	const label = btn.querySelector(".toggle-label");
	if (label) label.textContent = info.label;
}

function renderCards(): void {
	const workflows = stateManager.getWorkflows();
	const epics = stateManager.getEpics();
	const epicAggregates = stateManager.getEpicAggregates();
	const cardOrder = stateManager.getCardOrder();
	renderCardStrip(cardOrder, workflows, epics, epicAggregates, activeCardId(), handleCardClick);
	updateArchiveCount(stateManager);
}

function openFeedbackPanel(wf: WorkflowState): void {
	showFeedbackPanel(wf, (text) => {
		send({ type: "workflow:feedback", workflowId: wf.id, text });
	});
}

function createRepoHint(): HTMLDivElement {
	const hint = document.createElement("div");
	hint.className = "modal-field-hint";
	hint.appendChild(document.createTextNode("Folder path (e.g. "));
	const pathCode = document.createElement("code");
	pathCode.textContent = "~/git/my-repo";
	hint.appendChild(pathCode);
	hint.appendChild(document.createTextNode(") or GitHub URL (e.g. "));
	const urlCode = document.createElement("code");
	urlCode.textContent = "https://github.com/user/repo";
	hint.appendChild(urlCode);
	hint.appendChild(document.createTextNode(")"));
	return hint;
}

function openSpecModal(): void {
	const content = document.createElement("div");

	const repoField = document.createElement("div");
	repoField.className = "modal-field";
	const repoLabel = document.createElement("label");
	repoLabel.textContent = "Target Repository";
	repoField.appendChild(repoLabel);
	const repoPicker = createFolderPicker("~/git");
	repoPicker.setValue(stateManager.getLastTargetRepo());
	repoField.appendChild(repoPicker.element);
	repoField.appendChild(createRepoHint());

	const specField = document.createElement("div");
	specField.className = "modal-field";
	const specLabel = document.createElement("label");
	specLabel.textContent = "Specification";
	specField.appendChild(specLabel);
	const specInput = document.createElement("textarea");
	specInput.placeholder = "Describe the feature you want to build...";
	specInput.rows = 5;
	specField.appendChild(specInput);

	const errorEl = document.createElement("div");
	errorEl.className = "modal-error hidden";

	const actions = document.createElement("div");
	actions.className = "modal-actions";
	const btnStart = document.createElement("button");
	btnStart.className = "btn btn-primary";
	btnStart.textContent = "Start";
	actions.appendChild(btnStart);

	content.appendChild(repoField);
	content.appendChild(specField);
	content.appendChild(errorEl);
	content.appendChild(actions);

	const modal = createModal("New Specification", content);

	const cloneStatus = document.createElement("div");
	cloneStatus.className = "modal-clone-status hidden";
	content.appendChild(cloneStatus);

	const folderValidation = attachFolderValidation(repoPicker, repoField);

	function setFormDisabled(disabled: boolean) {
		specInput.disabled = disabled;
		btnStart.disabled = disabled;
		repoPicker.element
			.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")
			.forEach((el) => {
				el.disabled = disabled;
			});
	}

	async function submit() {
		const spec = specInput.value.trim();
		if (!spec) {
			errorEl.textContent = "Specification is required";
			errorEl.classList.remove("hidden");
			return;
		}
		const folderOk = await folderValidation.submitCheck();
		if (!folderOk) return;
		errorEl.classList.add("hidden");
		const targetRepo = repoPicker.getValue();

		if (targetRepo && looksLikeGitUrl(targetRepo)) {
			const submissionId = crypto.randomUUID();
			attachCloneSubmission(modal, cloneStatus, errorEl, setFormDisabled, submissionId);
			send({
				type: "workflow:start",
				specification: spec,
				targetRepository: targetRepo,
				submissionId,
			});
			return;
		}

		send({
			type: "workflow:start",
			specification: spec,
			...(targetRepo ? { targetRepository: targetRepo } : {}),
		});
		modal.hide();
	}

	btnStart.addEventListener("click", () => void submit());
	specInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			void submit();
		}
	});

	modal.show();
}

function openQuickFixModal(): void {
	const content = document.createElement("div");

	const repoField = document.createElement("div");
	repoField.className = "modal-field";
	const repoLabel = document.createElement("label");
	repoLabel.textContent = "Target Repository";
	repoField.appendChild(repoLabel);
	const repoPicker = createFolderPicker("~/git");
	repoPicker.setValue(stateManager.getLastTargetRepo());
	repoField.appendChild(repoPicker.element);
	repoField.appendChild(createRepoHint());

	const descField = document.createElement("div");
	descField.className = "modal-field";
	const descLabel = document.createElement("label");
	descLabel.textContent = "Fix Description";
	descField.appendChild(descLabel);
	const descInput = document.createElement("textarea");
	descInput.placeholder = "Describe the small fix you want the agent to make...";
	descInput.rows = 5;
	descField.appendChild(descInput);

	const errorEl = document.createElement("div");
	errorEl.className = "modal-error hidden";

	const actions = document.createElement("div");
	actions.className = "modal-actions";
	const btnStart = document.createElement("button");
	btnStart.className = "btn btn-primary";
	btnStart.textContent = "Start";
	btnStart.disabled = true;
	actions.appendChild(btnStart);

	content.appendChild(repoField);
	content.appendChild(descField);
	content.appendChild(errorEl);
	content.appendChild(actions);

	const modal = createModal("Quick Fix", content);

	const folderValidation = attachFolderValidation(repoPicker, repoField);

	const cloneStatus = document.createElement("div");
	cloneStatus.className = "modal-clone-status hidden";
	content.appendChild(cloneStatus);

	function setFormDisabled(disabled: boolean) {
		descInput.disabled = disabled;
		btnStart.disabled = disabled || descInput.value.trim() === "";
		repoPicker.element
			.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")
			.forEach((el) => {
				el.disabled = disabled;
			});
	}

	descInput.addEventListener("input", () => {
		btnStart.disabled = descInput.value.trim() === "";
	});

	async function submit() {
		const desc = descInput.value.trim();
		if (!desc) {
			errorEl.textContent = "Fix description is required";
			errorEl.classList.remove("hidden");
			return;
		}
		errorEl.classList.add("hidden");
		if (!(await folderValidation.submitCheck())) return;
		const targetRepo = repoPicker.getValue();

		if (targetRepo && looksLikeGitUrl(targetRepo)) {
			const submissionId = crypto.randomUUID();
			attachCloneSubmission(modal, cloneStatus, errorEl, setFormDisabled, submissionId);
			send({
				type: "workflow:start",
				workflowKind: "quick-fix",
				specification: desc,
				targetRepository: targetRepo,
				submissionId,
			});
			return;
		}

		send({
			type: "workflow:start",
			workflowKind: "quick-fix",
			specification: desc,
			...(targetRepo ? { targetRepository: targetRepo } : {}),
		});
		modal.hide();
	}

	btnStart.addEventListener("click", submit);
	descInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			submit();
		}
	});

	modal.show();
}

function openAskQuestionModal(): void {
	const content = document.createElement("div");

	const repoField = document.createElement("div");
	repoField.className = "modal-field";
	const repoLabel = document.createElement("label");
	repoLabel.textContent = "Target Repository";
	repoField.appendChild(repoLabel);
	const repoPicker = createFolderPicker("~/git");
	repoPicker.setValue(stateManager.getLastTargetRepo());
	repoField.appendChild(repoPicker.element);
	repoField.appendChild(createRepoHint());

	const questionField = document.createElement("div");
	questionField.className = "modal-field";
	const questionLabel = document.createElement("label");
	questionLabel.textContent = "Your question";
	questionField.appendChild(questionLabel);
	const questionInput = document.createElement("textarea");
	questionInput.placeholder = "Ask a research-style question about this codebase...";
	questionInput.rows = 6;
	questionField.appendChild(questionInput);

	const errorEl = document.createElement("div");
	errorEl.className = "modal-error hidden";

	const actions = document.createElement("div");
	actions.className = "modal-actions";
	const btnStart = document.createElement("button");
	btnStart.className = "btn btn-primary";
	btnStart.textContent = "Start";
	btnStart.disabled = true;
	actions.appendChild(btnStart);

	content.appendChild(repoField);
	content.appendChild(questionField);
	content.appendChild(errorEl);
	content.appendChild(actions);

	const modal = createModal("Ask Question", content);

	const cloneStatus = document.createElement("div");
	cloneStatus.className = "modal-clone-status hidden";
	content.appendChild(cloneStatus);

	const folderValidation = attachFolderValidation(repoPicker, repoField);

	function setFormDisabled(disabled: boolean) {
		questionInput.disabled = disabled;
		btnStart.disabled = disabled || questionInput.value.trim() === "";
		repoPicker.element
			.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")
			.forEach((el) => {
				el.disabled = disabled;
			});
	}

	questionInput.addEventListener("input", () => {
		btnStart.disabled = questionInput.value.trim() === "";
	});

	async function submit() {
		const question = questionInput.value;
		if (question.trim() === "") {
			errorEl.textContent = "Please enter a question.";
			errorEl.classList.remove("hidden");
			return;
		}
		if (question.length > ASK_QUESTION_MAX_LENGTH) {
			errorEl.textContent = `Question is too long. The maximum allowed length is ${ASK_QUESTION_MAX_LENGTH.toLocaleString("en-US")} characters; this is a guardrail against the LLM token budget.`;
			errorEl.classList.remove("hidden");
			return;
		}
		errorEl.classList.add("hidden");
		const folderOk = await folderValidation.submitCheck();
		if (!folderOk) return;
		const targetRepo = repoPicker.getValue();

		if (targetRepo && looksLikeGitUrl(targetRepo)) {
			const submissionId = crypto.randomUUID();
			attachCloneSubmission(modal, cloneStatus, errorEl, setFormDisabled, submissionId);
			send({
				type: "workflow:start",
				workflowKind: "ask-question",
				specification: question.trim(),
				targetRepository: targetRepo,
				submissionId,
			});
			return;
		}

		send({
			type: "workflow:start",
			workflowKind: "ask-question",
			specification: question.trim(),
			...(targetRepo ? { targetRepository: targetRepo } : {}),
		});
		modal.hide();
	}

	btnStart.addEventListener("click", () => void submit());
	questionInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			void submit();
		}
	});

	modal.show();
}

function openEpicModal(): void {
	const content = document.createElement("div");

	const repoField = document.createElement("div");
	repoField.className = "modal-field";
	const repoLabel = document.createElement("label");
	repoLabel.textContent = "Target Repository";
	repoField.appendChild(repoLabel);
	const repoPicker = createFolderPicker("~/git");
	repoPicker.setValue(stateManager.getLastTargetRepo());
	repoField.appendChild(repoPicker.element);
	repoField.appendChild(createRepoHint());

	const descField = document.createElement("div");
	descField.className = "modal-field";
	const descLabel = document.createElement("label");
	descLabel.textContent = "Epic Description";
	descField.appendChild(descLabel);
	const descInput = document.createElement("textarea");
	descInput.placeholder = "Describe a large feature to decompose into multiple specs...";
	descInput.rows = 5;
	descField.appendChild(descInput);

	const errorEl = document.createElement("div");
	errorEl.className = "modal-error hidden";

	const actions = document.createElement("div");
	actions.className = "modal-actions";
	const btnCreateStart = document.createElement("button");
	btnCreateStart.className = "btn btn-primary";
	btnCreateStart.textContent = "Create + Start";
	const btnCreate = document.createElement("button");
	btnCreate.className = "btn btn-secondary";
	btnCreate.textContent = "Create";
	actions.appendChild(btnCreateStart);
	actions.appendChild(btnCreate);

	content.appendChild(repoField);
	content.appendChild(descField);
	content.appendChild(errorEl);
	content.appendChild(actions);

	const modal = createModal("New Epic", content);

	const cloneStatus = document.createElement("div");
	cloneStatus.className = "modal-clone-status hidden";
	content.appendChild(cloneStatus);

	const folderValidation = attachFolderValidation(repoPicker, repoField);

	function setFormDisabled(disabled: boolean) {
		descInput.disabled = disabled;
		btnCreateStart.disabled = disabled;
		btnCreate.disabled = disabled;
		repoPicker.element
			.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")
			.forEach((el) => {
				el.disabled = disabled;
			});
	}

	async function submitEpic(autoStart: boolean) {
		const desc = descInput.value.trim();
		if (desc.length < 10) {
			errorEl.textContent = "Description must be at least 10 characters";
			errorEl.classList.remove("hidden");
			return;
		}
		const folderOk = await folderValidation.submitCheck();
		if (!folderOk) return;
		errorEl.classList.add("hidden");
		const targetRepo = repoPicker.getValue();

		if (targetRepo && looksLikeGitUrl(targetRepo)) {
			const submissionId = crypto.randomUUID();
			attachCloneSubmission(modal, cloneStatus, errorEl, setFormDisabled, submissionId);
			send({
				type: "epic:start",
				description: desc,
				autoStart,
				targetRepository: targetRepo,
				submissionId,
			});
			return;
		}

		send({
			type: "epic:start",
			description: desc,
			autoStart,
			...(targetRepo ? { targetRepository: targetRepo } : {}),
		});
		modal.hide();
	}

	btnCreateStart.addEventListener("click", () => void submitEpic(true));
	btnCreate.addEventListener("click", () => void submitEpic(false));

	modal.show();
}

// Wire up UI events
document.addEventListener("DOMContentLoaded", () => {
	const btnSubmitAnswer = $("#btn-submit-answer") as HTMLButtonElement;
	const btnSkip = $("#btn-skip-question") as HTMLButtonElement;

	const btnQuickFix = document.getElementById("btn-quick-fix");
	if (btnQuickFix) btnQuickFix.addEventListener("click", openQuickFixModal);

	const btnNewSpec = document.getElementById("btn-new-spec");
	if (btnNewSpec) btnNewSpec.addEventListener("click", openSpecModal);

	const btnAskQuestion = document.getElementById("btn-ask-question");
	if (btnAskQuestion) btnAskQuestion.addEventListener("click", openAskQuestionModal);

	const btnNewEpic = document.getElementById("btn-new-epic");
	if (btnNewEpic) btnNewEpic.addEventListener("click", openEpicModal);

	const btnAutoMode = document.getElementById("btn-auto-mode");
	if (btnAutoMode) {
		btnAutoMode.addEventListener("click", () => {
			const current =
				AUTO_MODE_CYCLE.find((m) => btnAutoMode.classList.contains(`mode-${m}`)) ?? "normal";
			const idx = AUTO_MODE_CYCLE.indexOf(current);
			const next = AUTO_MODE_CYCLE[(idx + 1) % AUTO_MODE_CYCLE.length];
			send({ type: "config:save", config: { autoMode: next } });
		});
	}

	btnSubmitAnswer.addEventListener("click", () => {
		const answer = getAnswer();
		const workflowId = activeWorkflowIdFromRoute();
		if (!answer || !workflowId) return;

		const entry = stateManager.getWorkflows().get(workflowId);
		if (!entry?.state.pendingQuestion) return;

		btnSubmitAnswer.disabled = true;
		btnSkip.disabled = true;
		send({
			type: "workflow:answer",
			workflowId,
			questionId: entry.state.pendingQuestion.id,
			answer,
		});
	});

	btnSkip.addEventListener("click", () => {
		const workflowId = activeWorkflowIdFromRoute();
		if (!workflowId) return;

		const entry = stateManager.getWorkflows().get(workflowId);
		if (!entry?.state.pendingQuestion) return;

		btnSubmitAnswer.disabled = true;
		btnSkip.disabled = true;
		send({
			type: "workflow:skip",
			workflowId,
			questionId: entry.state.pendingQuestion.id,
		});
	});

	const answerInput = $("#answer-input") as HTMLTextAreaElement;
	answerInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			btnSubmitAnswer.click();
		}
	});

	// Initialize router with four top-level views.
	const appContent = document.getElementById("app-content");
	if (appContent) {
		appRouter = new Router(appContent, "/");
		appRouter.register("/", createDashboardHandler());
		appRouter.register(
			"/workflow/:id",
			createWorkflowDetailHandler({
				getState: () => stateManager,
				getAutoMode: () => currentAutoMode,
				getArtifactContext,
				fetchArtifacts: (id) => {
					void fetchWorkflowArtifacts(id);
				},
				send,
				navigate: (path) => appRouter?.navigate(path),
				openFeedbackPanel,
				setSelectStep: (cb) => {
					workflowDetailSelectStep = cb;
				},
			}),
		);
		appRouter.register(
			"/epic/:id",
			createEpicDetailHandler({
				getState: () => stateManager,
				getConfig: () => latestConfig,
				send,
				navigate: (path) => appRouter?.navigate(path),
			}),
		);
		appRouter.register(
			"/config",
			createConfigPageHandler(
				send,
				(path) => appRouter?.navigate(path),
				() => latestConfig,
				() => cachedTelegramStatus,
			),
		);
		appRouter.register(
			"/archive",
			createArchiveHandler({
				getState: () => stateManager,
				send,
				navigate: (path) => appRouter?.navigate(path),
			}),
		);
		appRouter.setNavigateListener((path) => {
			// Re-render the card strip so the `card-expanded` affordance tracks the
			// URL on every navigation. Without this, back-navigating from a
			// `/workflow/<id>` view to `/` (or any route change where no server
			// message fires) leaves the stale selection class on the previously
			// active card.
			renderCards();
			send({ type: "alert:route-changed", path });
		});
		appRouter.start();
		// Render cards once the router is ready so highlights pick up the current path.
		renderCards();
	}

	const btnConfig = document.getElementById("btn-config");
	if (btnConfig) {
		btnConfig.addEventListener("click", () => {
			if (!appRouter) return;
			if (appRouter.currentPath === "/config") {
				appRouter.navigate("/");
			} else {
				appRouter.navigate("/config");
			}
		});
	}

	setInterval(updateTimers, 1000);

	initAlertToasts((alert) => {
		navigateToAlertTarget(alert);
	});

	initAlertList({
		getAlerts: () => stateManager.getAlerts(),
		getState: () => stateManager,
		onDismiss: (id) => {
			send({ type: "alert:dismiss", alertId: id });
		},
		onNavigate: (alert) => {
			// FR-011: clicking an alert row removes it entirely (stronger than
			// auto-dismiss). Covers errors too, which navigation alone never
			// marks seen.
			send({ type: "alert:dismiss", alertId: alert.id });
			navigateToAlertTarget(alert);
		},
		onClearAll: () => {
			send({ type: "alert:clear-all" });
		},
	});

	const btnHome = document.getElementById("btn-home");
	if (btnHome) {
		btnHome.addEventListener("click", (e) => {
			e.preventDefault();
			appRouter?.navigate("/");
		});
	}

	const btnArchive = document.getElementById("btn-archive");
	if (btnArchive) {
		btnArchive.addEventListener("click", (e) => {
			e.preventDefault();
			if (!appRouter) return;
			if (appRouter.currentPath === "/archive") {
				appRouter.navigate("/");
			} else {
				appRouter.navigate("/archive");
			}
		});
	}

	const btnBell = document.getElementById("btn-alert-bell");
	if (btnBell) {
		btnBell.addEventListener("click", (e) => {
			e.stopPropagation();
			showAlertList();
		});
	}

	connect();
});

function activeWorkflowIdFromRoute(): string | null {
	const path = appRouter?.currentPath ?? null;
	if (!path) return null;
	const m = path.match(/^\/workflow\/(.+)$/);
	return m ? m[1] : null;
}
