import { LITUS } from "../../design-system/tokens";
import { renderMarkdown } from "../../render-markdown";
import type { LogEvent, LogEventKind, LogToolItem } from "./log-kind-classifier";
import type { LogConsoleModel } from "./run-screen-model";

type AutoScrollState = "on" | "off-by-user" | "off-by-toggle";

const GREEN = "oklch(0.80 0.14 155)";
const VIOLET = "oklch(0.76 0.14 298)";

export interface LogConsoleController {
	element: HTMLElement;
	update(model: LogConsoleModel): void;
	scrollToSection(stepName: string): void;
}

function renderSection(ev: Extract<LogEvent, { kind: "section" }>): HTMLElement {
	const d = document.createElement("div");
	d.dataset.logKind = "section";
	d.dataset.sectionKey = ev.text.replace(/^[\s─=#-]+/, "").trim();
	Object.assign(d.style, {
		color: LITUS.textMute,
		margin: "4px 0 8px",
		scrollMarginTop: "8px",
	} satisfies Partial<CSSStyleDeclaration>);
	d.textContent = ev.text;
	return d;
}

function renderCmd(ev: Extract<LogEvent, { kind: "cmd" }>): HTMLElement {
	const d = document.createElement("div");
	d.dataset.logKind = "cmd";
	Object.assign(d.style, {
		display: "flex",
		gap: "8px",
		marginTop: "4px",
	} satisfies Partial<CSSStyleDeclaration>);
	if (ev.cwd) {
		const cwd = document.createElement("span");
		cwd.style.color = VIOLET;
		cwd.textContent = `[${ev.cwd}]`;
		d.appendChild(cwd);
	}
	const dollar = document.createElement("span");
	dollar.style.color = LITUS.cyan;
	dollar.textContent = "$";
	d.appendChild(dollar);
	const body = document.createElement("span");
	body.style.color = LITUS.text;
	body.textContent = ev.body;
	d.appendChild(body);
	return d;
}

function renderOut(ev: Extract<LogEvent, { kind: "out" }>): HTMLElement {
	const d = document.createElement("div");
	d.dataset.logKind = "out";
	Object.assign(d.style, {
		color: ev.muted ? LITUS.textMute : LITUS.textDim,
		paddingLeft: "16px",
	} satisfies Partial<CSSStyleDeclaration>);
	d.textContent = ev.text;
	return d;
}

function renderAssistant(ev: Extract<LogEvent, { kind: "assistant" }>): HTMLElement {
	const d = document.createElement("div");
	d.dataset.logKind = "assistant";
	Object.assign(d.style, {
		margin: "10px 0",
		padding: "10px 14px",
		borderRadius: "10px",
		background: "rgba(148,163,184,.04)",
		border: `1px solid ${LITUS.border}`,
		fontFamily: "Inter, system-ui, sans-serif",
		fontSize: "13.2px",
		lineHeight: "1.55",
		color: LITUS.text,
	} satisfies Partial<CSSStyleDeclaration>);

	const eyebrow = document.createElement("div");
	Object.assign(eyebrow.style, {
		display: "flex",
		alignItems: "center",
		gap: "6px",
		fontSize: "10px",
		color: LITUS.textMute,
		fontFamily: "'JetBrains Mono', ui-monospace, monospace",
		textTransform: "uppercase",
		letterSpacing: "0.12em",
		marginBottom: "4px",
	} satisfies Partial<CSSStyleDeclaration>);
	const dot = document.createElement("span");
	dot.className = "dot";
	dot.style.background = LITUS.amber;
	eyebrow.appendChild(dot);
	eyebrow.appendChild(document.createTextNode("assistant"));
	d.appendChild(eyebrow);

	const body = document.createElement("div");
	body.innerHTML = renderMarkdown(ev.body);
	d.appendChild(body);
	return d;
}

const DIFF_RED = "oklch(0.68 0.18 25)";

function renderDiff(ev: Extract<LogEvent, { kind: "diff" }>): HTMLElement {
	const d = document.createElement("div");
	d.dataset.logKind = "diff";
	Object.assign(d.style, {
		color: LITUS.textDim,
		marginTop: "8px",
		fontSize: "11.5px",
		borderLeft: `2px solid ${LITUS.borderStrong}`,
		paddingLeft: "10px",
	} satisfies Partial<CSSStyleDeclaration>);
	const header = document.createElement("div");
	const diamond = document.createElement("span");
	diamond.textContent = "◇ ";
	header.appendChild(diamond);
	const path = document.createElement("span");
	path.style.color = LITUS.text;
	path.textContent = ev.path;
	header.appendChild(path);
	d.appendChild(header);
	for (const hunk of ev.hunks) {
		if (hunk.context) {
			const ctx = document.createElement("div");
			ctx.style.color = LITUS.textMute;
			ctx.textContent = hunk.context;
			d.appendChild(ctx);
		}
		for (const line of hunk.lines) {
			const lineEl = document.createElement("div");
			if (line.op === "+") {
				lineEl.style.color = GREEN;
				lineEl.textContent = `+${line.text}`;
			} else if (line.op === "-") {
				lineEl.style.color = DIFF_RED;
				lineEl.textContent = `-${line.text}`;
			} else {
				lineEl.style.color = LITUS.textDim;
				lineEl.textContent = line.text;
			}
			d.appendChild(lineEl);
		}
	}
	return d;
}

function toolIcon(item: LogToolItem): HTMLElement {
	const col =
		item.kind === "edit"
			? LITUS.amber
			: item.kind === "cmd"
				? GREEN
				: item.kind === "grep"
					? LITUS.cyan
					: LITUS.textMute;
	const ic =
		item.kind === "read" ? "◻" : item.kind === "edit" ? "✎" : item.kind === "grep" ? "⌕" : "»";
	const span = document.createElement("span");
	Object.assign(span.style, {
		width: "16px",
		height: "16px",
		borderRadius: "4px",
		background: "rgba(148,163,184,.06)",
		border: `1px solid ${LITUS.border}`,
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		fontSize: "9px",
		color: col,
		fontFamily: "'JetBrains Mono', ui-monospace, monospace",
	} satisfies Partial<CSSStyleDeclaration>);
	span.textContent = ic;
	if (item.label) span.title = item.label;
	return span;
}

function renderToolstrip(ev: Extract<LogEvent, { kind: "toolstrip" }>): HTMLElement {
	const d = document.createElement("div");
	d.dataset.logKind = "toolstrip";
	Object.assign(d.style, {
		display: "flex",
		gap: "4px",
		flexWrap: "wrap",
		margin: "6px 0 2px 16px",
	} satisfies Partial<CSSStyleDeclaration>);
	for (const item of ev.items) d.appendChild(toolIcon(item));
	return d;
}

function renderLine(ev: LogEvent): HTMLElement {
	const kind: LogEventKind = ev.kind;
	switch (kind) {
		case "section":
			return renderSection(ev as Extract<LogEvent, { kind: "section" }>);
		case "cmd":
			return renderCmd(ev as Extract<LogEvent, { kind: "cmd" }>);
		case "assistant":
			return renderAssistant(ev as Extract<LogEvent, { kind: "assistant" }>);
		case "diff":
			return renderDiff(ev as Extract<LogEvent, { kind: "diff" }>);
		case "toolstrip":
			return renderToolstrip(ev as Extract<LogEvent, { kind: "toolstrip" }>);
		default:
			return renderOut(ev as Extract<LogEvent, { kind: "out" }>);
	}
}

export function createLogConsole(initial: LogConsoleModel): LogConsoleController {
	const host = document.createElement("div");
	host.className = "glass";
	host.dataset.runScreen = "log-console";
	Object.assign(host.style, {
		flex: "1",
		borderRadius: "14px",
		padding: "0",
		display: "flex",
		flexDirection: "column",
		minHeight: "0",
		overflow: "hidden",
	} satisfies Partial<CSSStyleDeclaration>);

	const header = document.createElement("div");
	Object.assign(header.style, {
		display: "flex",
		alignItems: "center",
		gap: "10px",
		padding: "10px 16px",
		borderBottom: `1px solid ${LITUS.border}`,
	} satisfies Partial<CSSStyleDeclaration>);
	host.appendChild(header);

	const title = document.createElement("span");
	title.className = "mono";
	Object.assign(title.style, {
		fontSize: "10px",
		letterSpacing: "0.18em",
		color: LITUS.textMute,
		textTransform: "uppercase",
	} satisfies Partial<CSSStyleDeclaration>);
	header.appendChild(title);

	const spacer = document.createElement("span");
	spacer.style.flex = "1";
	header.appendChild(spacer);

	const counters = document.createElement("span");
	counters.className = "mono";
	Object.assign(counters.style, {
		fontSize: "10.5px",
		color: LITUS.textDim,
	} satisfies Partial<CSSStyleDeclaration>);
	header.appendChild(counters);

	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = "btn btn-ghost";
	Object.assign(toggle.style, {
		padding: "3px 7px",
		fontSize: "10.5px",
	} satisfies Partial<CSSStyleDeclaration>);
	toggle.textContent = "auto-scroll";
	header.appendChild(toggle);

	const body = document.createElement("div");
	body.className = "scroll mono";
	Object.assign(body.style, {
		flex: "1",
		overflow: "auto",
		padding: "14px 20px 20px",
		fontSize: "12.5px",
		lineHeight: "1.65",
		color: LITUS.textDim,
		background: "linear-gradient(180deg, rgba(8,12,20,.4), rgba(8,12,20,.2))",
	} satisfies Partial<CSSStyleDeclaration>);
	host.appendChild(body);

	let autoScroll: AutoScrollState = "on";

	function paintToggle(): void {
		toggle.style.color = autoScroll === "on" ? LITUS.text : LITUS.textMute;
	}
	paintToggle();

	toggle.addEventListener("click", () => {
		autoScroll = autoScroll === "on" ? "off-by-toggle" : "on";
		paintToggle();
		if (autoScroll === "on") body.scrollTop = body.scrollHeight;
	});

	body.addEventListener("scroll", () => {
		const atBottom = body.scrollHeight - (body.scrollTop + body.clientHeight) < 4;
		if (autoScroll === "on" && !atBottom) {
			autoScroll = "off-by-user";
			paintToggle();
		} else if (autoScroll === "off-by-user" && atBottom) {
			autoScroll = "on";
			paintToggle();
		}
	});

	// Counter DOM built once; update text content on each tick (§4.9).
	const writingDot = document.createElement("span");
	writingDot.style.color = GREEN;
	writingDot.textContent = "●";
	counters.appendChild(writingDot);
	const countersText = document.createElement("span");
	counters.appendChild(countersText);

	// Append-only rendering: track how many events have been mounted and only
	// append the new tail. Caret lives on exactly one line — the writingLine —
	// and is moved in place instead of triggering a full re-render.
	let mountedCount = 0;
	let caretLine: HTMLElement | null = null;

	function update(model: LogConsoleModel): void {
		const step = model.currentStep ?? "idle";
		title.textContent = `Stream · ${step}`;
		countersText.textContent = ` tool calls: ${model.counters.toolCalls} · reads: ${model.counters.reads} · edits: ${model.counters.edits}`;

		// If the event array was truncated or replaced entirely (step switch,
		// workflow reload), rebuild.
		if (model.events.length < mountedCount) {
			body.innerHTML = "";
			mountedCount = 0;
			caretLine = null;
		}

		for (let i = mountedCount; i < model.events.length; i++) {
			const el = renderLine(model.events[i]);
			body.appendChild(el);
		}
		mountedCount = model.events.length;

		// Re-seat the caret on the current writingLineIndex.
		if (caretLine) {
			const existing = caretLine.querySelector(".caret");
			if (existing) existing.remove();
			caretLine = null;
		}
		if (model.writingLineIndex != null && model.writingLineIndex < body.children.length) {
			const target = body.children[model.writingLineIndex] as HTMLElement;
			const caret = document.createElement("span");
			caret.className = "caret";
			caret.setAttribute("aria-hidden", "true");
			target.appendChild(caret);
			caretLine = target;
		}

		if (autoScroll === "on") {
			body.scrollTop = body.scrollHeight;
		}
	}

	function scrollToSection(stepName: string): void {
		const target = body.querySelector<HTMLElement>(
			`[data-log-kind="section"][data-section-key*="${cssEscape(stepName)}"]`,
		);
		if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
	}

	update(initial);

	return { element: host, update, scrollToSection };
}

function cssEscape(s: string): string {
	// Prefer the standard `CSS.escape` where available — happy-dom (used in
	// tests) does not expose it, so fall back to a conservative escape
	// over non-word characters (§4.3).
	if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
		return CSS.escape(s);
	}
	return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
