import { LITUS, type TaskAccent } from "../../design-system/tokens";
import type { RunScreenModel } from "./run-screen-model";

export interface TaskHeaderHandlers {
	onPauseToggle: () => void;
}

function formatElapsed(ms: number): string {
	if (ms < 0 || !Number.isFinite(ms)) return "00:00:00";
	const totalSec = Math.floor(ms / 1000);
	const hh = String(Math.floor(totalSec / 3600)).padStart(2, "0");
	const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
	const ss = String(totalSec % 60).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

interface MetaFieldController {
	element: HTMLSpanElement;
	setValue(value: string | null): void;
}

function createMetaField(label: string): MetaFieldController {
	const wrap = document.createElement("span");
	Object.assign(wrap.style, {
		display: "inline-flex",
		alignItems: "baseline",
		gap: "6px",
	} satisfies Partial<CSSStyleDeclaration>);
	const lbl = document.createElement("span");
	lbl.textContent = label;
	Object.assign(lbl.style, {
		color: LITUS.textMute,
		fontSize: "10.5px",
		textTransform: "uppercase",
		letterSpacing: "0.12em",
	} satisfies Partial<CSSStyleDeclaration>);
	wrap.appendChild(lbl);
	const val = document.createElement("span");
	wrap.appendChild(val);
	function setValue(value: string | null): void {
		if (value == null || value === "") {
			val.textContent = "·";
			val.style.color = LITUS.textMute;
		} else {
			val.textContent = value;
			val.style.color = LITUS.text;
		}
	}
	return { element: wrap, setValue };
}

export interface TaskHeaderController {
	element: HTMLElement;
	update(model: RunScreenModel, accent: TaskAccent): void;
	/** Tick the elapsed clock (call once per second when running). */
	tick(): void;
}

export function createTaskHeader(
	initialModel: RunScreenModel,
	initialAccent: TaskAccent,
	handlers: TaskHeaderHandlers,
): TaskHeaderController {
	const host = document.createElement("div");
	host.className = "glass";
	host.dataset.runScreen = "task-header";
	Object.assign(host.style, {
		position: "relative",
		borderRadius: "14px",
		padding: "16px 20px",
		overflow: "hidden",
	} satisfies Partial<CSSStyleDeclaration>);

	const wash = document.createElement("div");
	Object.assign(wash.style, {
		position: "absolute",
		inset: "0",
		pointerEvents: "none",
		opacity: "0.55",
	} satisfies Partial<CSSStyleDeclaration>);
	host.appendChild(wash);

	const row = document.createElement("div");
	Object.assign(row.style, {
		position: "relative",
		display: "flex",
		alignItems: "flex-start",
		gap: "18px",
	} satisfies Partial<CSSStyleDeclaration>);
	host.appendChild(row);

	const leftCol = document.createElement("div");
	Object.assign(leftCol.style, {
		flex: "1",
		minWidth: "0",
	} satisfies Partial<CSSStyleDeclaration>);
	row.appendChild(leftCol);

	const chipRow = document.createElement("div");
	Object.assign(chipRow.style, {
		display: "flex",
		alignItems: "center",
		gap: "10px",
		marginBottom: "6px",
	} satisfies Partial<CSSStyleDeclaration>);
	leftCol.appendChild(chipRow);

	const typeChip = document.createElement("span");
	typeChip.className = "chip";
	const pulseDot = document.createElement("span");
	pulseDot.className = "pulse-dot";
	pulseDot.dataset.litusAnimate = "running-step-glow";
	typeChip.appendChild(pulseDot);
	const typeChipLabel = document.createElement("span");
	typeChip.appendChild(typeChipLabel);
	chipRow.appendChild(typeChip);

	const idSpan = document.createElement("span");
	idSpan.className = "mono";
	Object.assign(idSpan.style, {
		fontSize: "11px",
		color: LITUS.textMute,
	} satisfies Partial<CSSStyleDeclaration>);
	chipRow.appendChild(idSpan);

	const sep = document.createElement("span");
	sep.textContent = "·";
	sep.className = "mono";
	Object.assign(sep.style, {
		fontSize: "11px",
		color: LITUS.textMute,
	} satisfies Partial<CSSStyleDeclaration>);
	chipRow.appendChild(sep);

	const elapsedSpan = document.createElement("span");
	elapsedSpan.className = "mono";
	Object.assign(elapsedSpan.style, {
		fontSize: "11px",
		color: LITUS.textMute,
	} satisfies Partial<CSSStyleDeclaration>);
	chipRow.appendChild(elapsedSpan);

	const titleEl = document.createElement("h1");
	titleEl.className = "serif";
	Object.assign(titleEl.style, {
		fontSize: "30px",
		margin: "0",
		letterSpacing: "-0.4px",
		lineHeight: "1.1",
	} satisfies Partial<CSSStyleDeclaration>);
	leftCol.appendChild(titleEl);

	const metaRow = document.createElement("div");
	Object.assign(metaRow.style, {
		marginTop: "10px",
		display: "flex",
		flexWrap: "wrap",
		gap: "16px",
		fontSize: "11.5px",
		color: LITUS.textDim,
		fontFamily: "'JetBrains Mono', ui-monospace, monospace",
	} satisfies Partial<CSSStyleDeclaration>);
	// Build once; `update()` mutates values in place rather than wiping the
	// row every second (§2.7 — the 1s `tickInterval` re-enters `update()`).
	const branchField = createMetaField("branch");
	const worktreeField = createMetaField("worktree");
	const baseField = createMetaField("base");
	metaRow.appendChild(branchField.element);
	metaRow.appendChild(worktreeField.element);
	metaRow.appendChild(baseField.element);
	leftCol.appendChild(metaRow);

	const descEl = document.createElement("p");
	Object.assign(descEl.style, {
		marginTop: "12px",
		marginBottom: "0",
		fontSize: "13.5px",
		lineHeight: "1.55",
		color: LITUS.textDim,
		maxWidth: "820px",
	} satisfies Partial<CSSStyleDeclaration>);
	leftCol.appendChild(descEl);

	const rightCol = document.createElement("div");
	Object.assign(rightCol.style, {
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-end",
		gap: "8px",
	} satisfies Partial<CSSStyleDeclaration>);
	row.appendChild(rightCol);

	const pauseBtn = document.createElement("button");
	pauseBtn.className = "btn";
	pauseBtn.type = "button";
	Object.assign(pauseBtn.style, {
		padding: "8px 14px",
		fontSize: "12px",
	} satisfies Partial<CSSStyleDeclaration>);
	// Optimistic paint (contract §3.5): flip `paused` locally as soon as the
	// user clicks, then let the server's next `workflow:state` rebroadcast
	// reconcile. If the server rejects the transition the next model update
	// will simply paint the original value back.
	pauseBtn.addEventListener("click", () => {
		currentModel = { ...currentModel, paused: !currentModel.paused };
		paintPauseButton();
		handlers.onPauseToggle();
	});
	rightCol.appendChild(pauseBtn);

	const timelineBtn = document.createElement("button");
	timelineBtn.className = "btn btn-ghost";
	timelineBtn.type = "button";
	timelineBtn.setAttribute("aria-disabled", "true");
	timelineBtn.tabIndex = -1;
	timelineBtn.title = "Coming soon";
	Object.assign(timelineBtn.style, {
		fontSize: "11.5px",
		color: LITUS.textDim,
	} satisfies Partial<CSSStyleDeclaration>);
	timelineBtn.innerHTML =
		'<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="6" cy="6" r="4.5"/><path d="M6 3.5v3l2 1"/></svg> Timeline';
	rightCol.appendChild(timelineBtn);

	let currentModel = initialModel;
	let currentAccent = initialAccent;

	function renderElapsed(): void {
		elapsedSpan.textContent = `elapsed ${formatElapsed(Date.now() - currentModel.header.createdAt)}`;
	}

	function paintPauseButton(): void {
		const paused = currentModel.paused;
		pauseBtn.style.background = paused
			? `color-mix(in oklch, ${currentAccent.c} 20%, transparent)`
			: "rgba(255,255,255,.05)";
		pauseBtn.style.color = paused ? currentAccent.c : LITUS.text;
		pauseBtn.style.borderColor = paused
			? `color-mix(in oklch, ${currentAccent.c} 40%, transparent)`
			: LITUS.border;
		pauseBtn.innerHTML = paused
			? '<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M2 1l7 4-7 4z"/></svg> Resume'
			: '<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="2" y="1" width="2.2" height="8"/><rect x="5.8" y="1" width="2.2" height="8"/></svg> Pause';
	}

	function update(model: RunScreenModel, accent: TaskAccent): void {
		currentModel = model;
		currentAccent = accent;

		wash.style.background = `radial-gradient(ellipse at 0% 0%, ${accent.glow}, transparent 55%)`;

		typeChip.style.background = accent.dim;
		typeChip.style.color = accent.c;
		typeChip.style.border = `1px solid color-mix(in oklch, ${accent.c} 30%, transparent)`;
		pulseDot.style.color = accent.c;
		pulseDot.style.background = accent.c;
		pulseDot.style.display = model.state === "running" ? "inline-block" : "none";
		typeChipLabel.textContent = ` ${accent.label} · ${stateLabel(model.state)}`;

		// Match the task-card id truncation (first 8 chars) for consistency
		// with the rail; full id remains in the tooltip for copy-paste (§4.12).
		idSpan.textContent = `#${model.id.slice(0, 8)}`;
		idSpan.title = model.id;
		renderElapsed();
		titleEl.textContent = model.title;

		branchField.setValue(model.header.branch);
		worktreeField.setValue(model.header.worktree);
		baseField.setValue(model.header.base);

		if (model.header.description) {
			descEl.textContent = model.header.description;
			descEl.style.display = "";
		} else {
			descEl.textContent = "";
			descEl.style.display = "none";
		}

		paintPauseButton();
	}

	update(initialModel, initialAccent);

	return {
		element: host,
		update,
		tick: renderElapsed,
	};
}

function stateLabel(s: RunScreenModel["state"]): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}
