import type { AppConfig, ClientMessage, ConfigWarning, EffortLevel } from "../../types";

// Metadata mirrored from config-store (server-side) — kept in sync manually.
// Keys use "section.field" dot-path notation.
const NUMERIC_SETTING_META = [
	{
		key: "limits.reviewCycleMaxIterations",
		label: "Review Cycle Max Iterations",
		description: "Maximum number of review-fix iterations before advancing",
		min: 1,
		defaultValue: 16,
		unit: "iterations",
	},
	{
		key: "limits.ciFixMaxAttempts",
		label: "CI Fix Max Attempts",
		description: "Maximum number of CI fix attempts before giving up",
		min: 1,
		defaultValue: 3,
		unit: "attempts",
	},
	{
		key: "limits.mergeMaxAttempts",
		label: "Merge Max Attempts",
		description: "Maximum number of merge conflict resolution attempts",
		min: 1,
		defaultValue: 3,
		unit: "attempts",
	},
	{
		key: "limits.maxJsonRetries",
		label: "Max JSON Retries",
		description: "Maximum retry attempts when epic analysis returns unparseable JSON",
		min: 0,
		defaultValue: 2,
		unit: "retries",
	},
	{
		key: "timing.ciGlobalTimeoutMs",
		label: "CI Global Timeout",
		description: "Maximum time to wait for CI checks to complete",
		min: 60_000,
		defaultValue: 1_800_000,
		unit: "ms",
	},
	{
		key: "timing.ciPollIntervalMs",
		label: "CI Poll Interval",
		description: "How often to poll CI check status",
		min: 5_000,
		defaultValue: 15_000,
		unit: "ms",
	},
	{
		key: "timing.activitySummaryIntervalMs",
		label: "Activity Summary Interval",
		description: "Minimum time between activity summary generation",
		min: 5_000,
		defaultValue: 15_000,
		unit: "ms",
	},
	{
		key: "timing.rateLimitBackoffMs",
		label: "Rate Limit Backoff",
		description: "Wait time when rate limited by GitHub API",
		min: 10_000,
		defaultValue: 60_000,
		unit: "ms",
	},
	{
		key: "timing.maxCiLogLength",
		label: "Max CI Log Length",
		description: "Maximum characters of CI log to include in fix prompt",
		min: 1_000,
		defaultValue: 50_000,
		unit: "chars",
	},
	{
		key: "timing.maxClientOutputLines",
		label: "Max Client Output Lines",
		description: "Maximum number of output lines kept in the browser",
		min: 100,
		defaultValue: 5_000,
		unit: "lines",
	},
	{
		key: "timing.epicTimeoutMs",
		label: "Epic Analysis Timeout",
		description: "Maximum time to wait for epic decomposition analysis",
		min: 60_000,
		defaultValue: 900_000,
		unit: "ms",
	},
];

const PROMPT_VARIABLES: Record<string, Array<{ name: string; description: string }>> = {
	questionDetection: [{ name: "text", description: "The text being analyzed for questions" }],
	reviewClassification: [
		{ name: "reviewOutput", description: "The code review output to classify" },
	],
	activitySummarization: [{ name: "text", description: "Recent agent output to summarize" }],
	specSummarization: [{ name: "specification", description: "The feature specification text" }],
	mergeConflictResolution: [
		{ name: "specSummary", description: "Summary of the feature being implemented" },
	],
	ciFixInstruction: [
		{ name: "prUrl", description: "The pull request URL" },
		{ name: "logSections", description: "Formatted CI failure log sections" },
	],
	epicDecomposition: [
		{ name: "epicDescription", description: "The epic description to decompose into specs" },
	],
};

const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "max"];

// Module-level send reference — set when createConfigPanel is called
// biome-ignore lint/suspicious/noExplicitAny: internal dispatch uses dynamic message shapes
let sendFn: ((msg: any) => void) | null = null;

// Cached panel root for updateConfigPanel / showConfigWarning
let panelRoot: HTMLElement | null = null;

// ── Helpers ────��───────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	cls?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text !== undefined) e.textContent = text;
	return e;
}

function makeSectionHeader(title: string, sectionEl: HTMLElement): HTMLElement {
	const header = el("div", "cfg-section-header");
	const titleSpan = el("span", "cfg-section-title", title);
	const chevron = el("span", "cfg-section-chevron", "▾");
	header.appendChild(titleSpan);
	header.appendChild(chevron);
	header.addEventListener("click", () => {
		const collapsed = sectionEl.classList.toggle("cfg-section-collapsed");
		chevron.textContent = collapsed ? "▸" : "▾";
	});
	return header;
}

function makeResetButton(dotPath: string): HTMLButtonElement {
	const btn = el("button", "cfg-reset-btn", "↺");
	btn.title = `Reset to default`;
	btn.type = "button";
	btn.addEventListener("click", () => {
		sendFn?.({ type: "config:reset", key: dotPath });
	});
	return btn;
}

function makeEffortSelect(modelKey: string): HTMLSelectElement {
	const select = el("select", "cfg-effort-select") as HTMLSelectElement;
	select.dataset.cfgPath = `efforts.${modelKey}`;
	for (const level of EFFORT_LEVELS) {
		const option = el("option");
		option.value = level;
		option.textContent = level;
		select.appendChild(option);
	}
	select.addEventListener("change", () => {
		sendFn?.({
			type: "config:save",
			config: { efforts: { [modelKey]: select.value } },
		});
	});
	return select;
}

function formatNumber(value: number): string {
	return new Intl.NumberFormat().format(value);
}

function parseNumericValue(raw: string): number {
	return Number.parseInt(raw.replace(/[^\d-]/g, ""), 10);
}

// ── Section builders ───────────────────────────────────────

function buildModelsSection(): HTMLElement {
	const section = el("div", "cfg-section");

	const modelsLink = el("div", "cfg-subgroup-desc");
	const a = document.createElement("a");
	a.href =
		"https://platform.claude.com/docs/en/about-claude/models/overview#latest-models-comparison";
	a.target = "_blank";
	a.rel = "noopener noreferrer";
	a.textContent = "See available Claude API model IDs";
	modelsLink.appendChild(a);
	section.appendChild(modelsLink);

	// Classification Models sub-group
	const classificationHeading = el("div", "cfg-subgroup-heading", "Classification Models");
	const classificationDesc = el(
		"div",
		"cfg-subgroup-desc",
		"Quick classification and summary tasks (pinned to specific models)",
	);
	section.appendChild(classificationHeading);
	section.appendChild(classificationDesc);

	const classificationFields: Array<{
		key: keyof AppConfig["models"];
		label: string;
		description: string;
	}> = [
		{
			key: "questionDetection",
			label: "Question Detection",
			description: "Classifies whether agent output contains a question",
		},
		{
			key: "reviewClassification",
			label: "Review Classification",
			description: "Classifies code review severity (critical/major/minor)",
		},
		{
			key: "activitySummarization",
			label: "Activity Summarization",
			description: "Generates short summaries of recent agent activity",
		},
		{
			key: "specSummarization",
			label: "Spec Summarization",
			description: "Generates summary and flavor text for specifications",
		},
	];

	for (const { key, label, description } of classificationFields) {
		section.appendChild(buildModelRow(key, label, "model name", description));
	}

	// Workflow Step Models sub-group
	const workflowHeading = el(
		"div",
		"cfg-subgroup-heading cfg-subgroup-heading--spaced",
		"Workflow Step Models",
	);
	const workflowDesc = el(
		"div",
		"cfg-subgroup-desc",
		"Full agent sessions (leave empty to use CLI default model)",
	);
	section.appendChild(workflowHeading);
	section.appendChild(workflowDesc);

	const workflowFields: Array<{
		key: keyof AppConfig["models"];
		label: string;
		description: string;
	}> = [
		{ key: "specify", label: "Specify", description: "Generates the feature specification" },
		{ key: "clarify", label: "Clarify", description: "Asks clarifying questions about the spec" },
		{ key: "plan", label: "Plan", description: "Creates the implementation plan" },
		{ key: "tasks", label: "Tasks", description: "Generates task breakdown from the plan" },
		{
			key: "implement",
			label: "Implement",
			description: "Implements code changes for each task",
		},
		{ key: "review", label: "Review", description: "Reviews the implemented code changes" },
		{
			key: "implementReview",
			label: "Implement Review",
			description: "Applies fixes from review feedback",
		},
		{
			key: "commitPushPr",
			label: "Commit / Push / PR",
			description: "Commits changes and opens a pull request",
		},
		{ key: "ciFix", label: "CI Fix", description: "Fixes failing CI checks" },
		{
			key: "epicDecomposition",
			label: "Epic Decomposition",
			description: "Decomposes epics into smaller specifications",
		},
		{
			key: "mergeConflictResolution",
			label: "Merge Conflict Resolution",
			description: "Resolves git merge conflicts automatically",
		},
	];

	for (const { key, label, description } of workflowFields) {
		section.appendChild(buildModelRow(key, label, "empty = CLI default", description));
	}

	return section;
}

function buildModelRow(
	key: keyof AppConfig["models"],
	label: string,
	placeholder: string,
	description?: string,
): HTMLElement {
	const row = el("div", "cfg-field-row");
	const labelEl = el("label", "cfg-label", label);
	if (description) labelEl.title = description;

	const input = el("input", "cfg-text-input") as HTMLInputElement;
	input.type = "text";
	input.dataset.cfgPath = `models.${key}`;
	input.placeholder = placeholder;
	input.addEventListener("change", () => {
		sendFn?.({
			type: "config:save",
			config: { models: { [key]: input.value.trim() } },
		});
	});

	const effortLabel = el("span", "cfg-effort-label", "Effort:");
	const effortSelect = makeEffortSelect(key);

	const resetBtn = el("button", "cfg-reset-btn", "↺");
	resetBtn.title = "Reset to default";
	resetBtn.type = "button";
	resetBtn.addEventListener("click", () => {
		sendFn?.({ type: "config:reset", key: `models.${key}` });
		sendFn?.({ type: "config:reset", key: `efforts.${key}` });
	});

	const inputWrap = el("div", "cfg-input-wrap cfg-model-input-wrap");
	inputWrap.appendChild(input);
	inputWrap.appendChild(effortLabel);
	inputWrap.appendChild(effortSelect);
	inputWrap.appendChild(resetBtn);

	row.appendChild(labelEl);
	row.appendChild(inputWrap);
	return row;
}

function buildNumericSection(sectionKey: string): HTMLElement {
	const section = el("div", "cfg-section");
	const metas = NUMERIC_SETTING_META.filter((m) => m.key.startsWith(`${sectionKey}.`));

	for (const meta of metas) {
		const fieldKey = meta.key.split(".")[1];
		const input = el("input", "cfg-number-input") as HTMLInputElement;
		input.type = "text";
		input.inputMode = "numeric";
		input.dataset.cfgPath = meta.key;
		input.dataset.rawValue = String(meta.defaultValue);

		// Format on blur
		input.addEventListener("blur", () => {
			const val = parseNumericValue(input.value);
			if (!Number.isNaN(val)) {
				input.dataset.rawValue = String(val);
				input.value = formatNumber(val);
			}
		});

		// Show raw on focus
		input.addEventListener("focus", () => {
			input.value = input.dataset.rawValue ?? input.value;
		});

		input.addEventListener("change", () => {
			const val = parseNumericValue(input.value);
			if (!Number.isNaN(val)) {
				input.dataset.rawValue = String(val);
				sendFn?.({
					type: "config:save",
					config: { [sectionKey]: { [fieldKey]: val } },
				});
			}
		});

		const unitSpan = meta.unit ? el("span", "cfg-unit", meta.unit) : null;
		const inputWrap = el("div", "cfg-input-wrap");
		inputWrap.appendChild(input);
		if (unitSpan) inputWrap.appendChild(unitSpan);
		inputWrap.appendChild(makeResetButton(meta.key));

		const row = el("div", "cfg-field-row");
		const labelEl = el("label", "cfg-label", meta.label);
		labelEl.title = meta.description;
		row.appendChild(labelEl);
		row.appendChild(inputWrap);
		section.appendChild(row);
	}

	return section;
}

function buildPromptsSection(): HTMLElement {
	const section = el("div", "cfg-section");
	const promptFields: Array<{
		key: keyof AppConfig["prompts"];
		label: string;
		description: string;
	}> = [
		{
			key: "questionDetection",
			label: "Question Detection",
			description:
				"Prompt used to classify whether agent output is a question requiring user input",
		},
		{
			key: "reviewClassification",
			label: "Review Classification",
			description: "Prompt used to classify code review severity level",
		},
		{
			key: "activitySummarization",
			label: "Activity Summarization",
			description: "Prompt used to generate short summaries of recent agent activity",
		},
		{
			key: "specSummarization",
			label: "Spec Summarization",
			description: "Prompt used to generate summary and flavor text for feature specifications",
		},
		{
			key: "mergeConflictResolution",
			label: "Merge Conflict Resolution",
			description: "Prompt given to the agent when resolving git merge conflicts",
		},
		{
			key: "ciFixInstruction",
			label: "CI Fix Instruction",
			description: "Prompt given to the agent when fixing failing CI checks",
		},
		{
			key: "epicDecomposition",
			label: "Epic Decomposition",
			description: "Prompt used to decompose a large epic into smaller specifications",
		},
	];

	for (const { key, label, description } of promptFields) {
		const textarea = el("textarea", "cfg-textarea") as HTMLTextAreaElement;
		textarea.rows = 4;
		textarea.dataset.cfgPath = `prompts.${key}`;
		textarea.addEventListener("change", () => {
			sendFn?.({
				type: "config:save",
				config: { prompts: { [key]: textarea.value } },
			});
		});

		// Template variable info
		const vars = PROMPT_VARIABLES[key] ?? [];
		const varInfo = el("div", "cfg-var-info");
		if (vars.length > 0) {
			const varLabels = vars.map((v) => `\${${v.name}}`).join(", ");
			varInfo.textContent = `Variables: ${varLabels}`;
			varInfo.title = vars.map((v) => `\${${v.name}}: ${v.description}`).join("\n");
		}

		const row = el("div", "cfg-field-row cfg-field-row--textarea");
		const labelEl = el("label", "cfg-label", label);
		labelEl.title = description;

		const descEl = el("div", "cfg-prompt-desc", description);

		const inputWrap = el("div", "cfg-input-wrap cfg-input-wrap--textarea");
		inputWrap.appendChild(descEl);
		inputWrap.appendChild(textarea);
		if (vars.length > 0) inputWrap.appendChild(varInfo);
		inputWrap.appendChild(makeResetButton(`prompts.${key}`));

		row.appendChild(labelEl);
		row.appendChild(inputWrap);
		section.appendChild(row);
	}

	return section;
}

// ── Warning toasts ─────────────────────────────────────────

function makeWarningToast(warning: ConfigWarning): HTMLElement {
	const toast = el("div", "cfg-warning-toast");
	const msg = el("span", "cfg-warning-msg", warning.message);
	const close = el("button", "cfg-warning-close", "×");
	close.type = "button";
	close.addEventListener("click", () => toast.remove());
	toast.appendChild(msg);
	toast.appendChild(close);
	// Auto-remove after 8 seconds
	setTimeout(() => toast.remove(), 8000);
	return toast;
}

// ── Exported API ───────────────────────────────────────────

export function createConfigPanel(send: (msg: ClientMessage) => void): HTMLElement {
	sendFn = send;

	const panel = el("div", "cfg-panel");
	panelRoot = panel;

	// Close button
	const closeBtn = el("button", "cfg-close-btn", "×");
	closeBtn.type = "button";
	closeBtn.title = "Close";
	closeBtn.addEventListener("click", () => hideConfigPanel());
	panel.appendChild(closeBtn);

	// Warnings container (at top of panel)
	const warningsContainer = el("div", "cfg-warnings");
	warningsContainer.id = "cfg-warnings";
	panel.appendChild(warningsContainer);

	// Models section
	const modelsBody = buildModelsSection();
	const modelsHeader = makeSectionHeader("Models", modelsBody);
	panel.appendChild(modelsHeader);
	panel.appendChild(modelsBody);

	// Limits section
	const limitsBody = buildNumericSection("limits");
	const limitsHeader = makeSectionHeader("Limits", limitsBody);
	panel.appendChild(limitsHeader);
	panel.appendChild(limitsBody);

	// Timing section
	const timingBody = buildNumericSection("timing");
	const timingHeader = makeSectionHeader("Timing", timingBody);
	panel.appendChild(timingHeader);
	panel.appendChild(timingBody);

	// Prompts section (collapsed by default — it's large)
	const promptsBody = buildPromptsSection();
	const promptsHeader = makeSectionHeader("Prompts", promptsBody);
	promptsBody.classList.add("cfg-section-collapsed");
	// Update chevron to match collapsed state
	const chevron = promptsHeader.querySelector(".cfg-section-chevron");
	if (chevron) chevron.textContent = "▸";
	panel.appendChild(promptsHeader);
	panel.appendChild(promptsBody);

	// Reset all button at the bottom
	const resetAll = el("button", "cfg-reset-all-btn", "Reset all to defaults");
	resetAll.type = "button";
	resetAll.addEventListener("click", () => {
		sendFn?.({ type: "config:reset" });
	});
	panel.appendChild(resetAll);

	// Purge all data button (danger zone)
	const purgeBtn = el("button", "cfg-purge-btn", "Purge All Data");
	purgeBtn.type = "button";
	purgeBtn.title =
		"Delete all workflows, epics, audit logs, worktrees, and branches. This cannot be undone.";
	purgeBtn.addEventListener("click", () => {
		const confirmed = confirm(
			"This will permanently delete ALL workflows, epics, audit logs, git worktrees, and feature branches across all repositories.\n\nThis cannot be undone. Continue?",
		);
		if (confirmed) {
			sendFn?.({ type: "purge:all" });
		}
	});
	panel.appendChild(purgeBtn);

	return panel;
}

function ensurePurgeOverlay(): HTMLElement {
	let overlay = document.getElementById("purge-progress");
	if (!overlay) {
		overlay = document.createElement("div");
		overlay.id = "purge-progress";
		overlay.className = "purge-progress hidden";
		overlay.innerHTML = `
			<div class="purge-progress-title">Purging all data...</div>
			<div class="purge-progress-bar-track">
				<div class="purge-progress-bar-fill" id="purge-bar-fill"></div>
			</div>
			<div class="purge-progress-step" id="purge-step-label"></div>
			<div class="purge-progress-log" id="purge-log"></div>
		`;
		// Append to the outer config-panel container so it covers the whole panel
		const container = document.getElementById("config-panel");
		if (container) container.appendChild(overlay);
	}
	return overlay;
}

export function showPurgeProgress(): void {
	const overlay = ensurePurgeOverlay();
	overlay.classList.remove("hidden");
	const log = document.getElementById("purge-log");
	if (log) log.textContent = "";
}

export function updatePurgeProgress(step: string, current: number, total: number): void {
	const fill = document.getElementById("purge-bar-fill") as HTMLElement | null;
	const label = document.getElementById("purge-step-label");
	const log = document.getElementById("purge-log");

	if (label) label.textContent = step;
	if (fill) {
		const pct = total > 0 ? Math.round((current / total) * 100) : 0;
		fill.style.width = `${pct}%`;
	}
	if (log) {
		const line = document.createElement("div");
		line.textContent = step;
		log.appendChild(line);
		log.scrollTop = log.scrollHeight;
	}
}

export function hidePurgeProgress(): void {
	const el = document.getElementById("purge-progress");
	if (el) el.classList.add("hidden");
}

export function hideConfigPanel(): void {
	const panel = document.getElementById("config-panel");
	const overlay = document.getElementById("config-overlay");
	if (panel) panel.classList.add("hidden");
	if (overlay) overlay.classList.add("hidden");
}

export function showConfigPanel(send: (msg: ClientMessage) => void): void {
	const panel = document.getElementById("config-panel");
	const overlay = document.getElementById("config-overlay");
	if (panel) panel.classList.remove("hidden");
	if (overlay) overlay.classList.remove("hidden");
	send({ type: "config:get" });
}

export function updateConfigPanel(config: AppConfig, warnings?: ConfigWarning[]): void {
	if (!panelRoot) return;

	// Update all text/textarea inputs by data-cfg-path
	const allInputs = panelRoot.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
		"input[data-cfg-path], textarea[data-cfg-path]",
	);
	for (const input of allInputs) {
		const path = input.dataset.cfgPath;
		if (!path) continue;

		const [section, key] = path.split(".") as [keyof AppConfig, string];
		const sectionData = config[section] as unknown as Record<string, unknown> | undefined;
		if (!sectionData) continue;

		const value = sectionData[key];
		if (value !== undefined) {
			// For numeric text inputs, store raw value and display formatted
			if (input.classList.contains("cfg-number-input")) {
				const numVal = Number(value);
				(input as HTMLInputElement).dataset.rawValue = String(numVal);
				// Only format if the input is not focused
				if (document.activeElement !== input) {
					input.value = formatNumber(numVal);
				} else {
					input.value = String(numVal);
				}
			} else {
				input.value = String(value);
			}
		}
	}

	// Update all effort selects
	const allSelects = panelRoot.querySelectorAll<HTMLSelectElement>("select[data-cfg-path]");
	for (const select of allSelects) {
		const path = select.dataset.cfgPath;
		if (!path) continue;

		const [section, key] = path.split(".") as [keyof AppConfig, string];
		const sectionData = config[section] as unknown as Record<string, unknown> | undefined;
		if (!sectionData) continue;

		const value = sectionData[key];
		if (value !== undefined) {
			select.value = String(value);
		}
	}

	if (warnings && warnings.length > 0) {
		showConfigWarning(warnings);
	}
}

export function showConfigWarning(warnings: ConfigWarning[]): void {
	const container = document.getElementById("cfg-warnings");
	if (!container) return;

	for (const warning of warnings) {
		container.appendChild(makeWarningToast(warning));
	}
}
