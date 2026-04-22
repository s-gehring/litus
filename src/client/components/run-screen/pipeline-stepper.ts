import { LITUS, type TaskAccent } from "../../design-system/tokens";
import { sectionLabel } from "./primitives";
import type { PipelineStepperModel } from "./run-screen-model";

export interface PipelineStepperHandlers {
	onStepClick: (stepName: string) => void;
}

export interface PipelineStepperController {
	element: HTMLElement;
	update(model: PipelineStepperModel, accent: TaskAccent): void;
}

function formatDuration(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
	const ss = String(totalSec % 60).padStart(2, "0");
	return `${mm}:${ss}`;
}

export function createPipelineStepper(
	initial: PipelineStepperModel,
	initialAccent: TaskAccent,
	handlers: PipelineStepperHandlers,
): PipelineStepperController {
	const host = document.createElement("div");
	host.className = "glass";
	host.dataset.runScreen = "pipeline-stepper";
	Object.assign(host.style, {
		borderRadius: "14px",
		padding: "18px 20px 16px",
		position: "relative",
		overflow: "hidden",
	} satisfies Partial<CSSStyleDeclaration>);

	const counter = document.createElement("span");
	counter.className = "mono";
	Object.assign(counter.style, {
		fontSize: "10.5px",
		color: LITUS.textMute,
	} satisfies Partial<CSSStyleDeclaration>);
	host.appendChild(sectionLabel("Pipeline", { right: counter }));

	const grid = document.createElement("div");
	Object.assign(grid.style, {
		position: "relative",
		padding: "14px 8px 4px",
	} satisfies Partial<CSSStyleDeclaration>);
	host.appendChild(grid);

	const railBase = document.createElement("div");
	Object.assign(railBase.style, {
		position: "absolute",
		left: "20px",
		right: "20px",
		top: "22px",
		height: "2px",
		background: LITUS.border,
		borderRadius: "2px",
	} satisfies Partial<CSSStyleDeclaration>);
	grid.appendChild(railBase);

	const railFill = document.createElement("div");
	Object.assign(railFill.style, {
		position: "absolute",
		left: "20px",
		top: "22px",
		height: "2px",
		borderRadius: "2px",
		width: "0",
	} satisfies Partial<CSSStyleDeclaration>);
	grid.appendChild(railFill);

	const stepsGrid = document.createElement("div");
	Object.assign(stepsGrid.style, {
		display: "grid",
		gap: "0",
	} satisfies Partial<CSSStyleDeclaration>);
	grid.appendChild(stepsGrid);

	function buildStep(step: PipelineStepperModel["steps"][number], accent: TaskAccent): HTMLElement {
		const wrap = document.createElement("div");
		Object.assign(wrap.style, {
			display: "flex",
			flexDirection: "column",
			alignItems: "center",
			gap: "8px",
			position: "relative",
			cursor: "pointer",
		} satisfies Partial<CSSStyleDeclaration>);
		wrap.tabIndex = 0;
		wrap.setAttribute("role", "button");
		wrap.dataset.stepName = step.name;
		wrap.addEventListener("click", () => handlers.onStepClick(step.name));
		wrap.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				handlers.onStepClick(step.name);
			}
		});

		const isDone = step.state === "done";
		const isRunning = step.state === "running";
		const isSkip = step.state === "skip";

		const node = document.createElement("div");
		const size = isRunning ? 22 : 14;
		Object.assign(node.style, {
			width: `${size}px`,
			height: `${size}px`,
			borderRadius: "11px",
			background: isRunning
				? `radial-gradient(circle, ${accent.c}, ${accent.dim})`
				: isDone
					? accent.c
					: "rgba(148,163,184,.15)",
			border: isSkip
				? `1.5px dashed ${LITUS.textMute}`
				: `1.5px solid ${isDone || isRunning ? accent.c : LITUS.borderStrong}`,
			boxShadow: isRunning ? `0 0 0 4px ${accent.glow}, 0 0 22px ${accent.glow}` : "none",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			transition: "all .2s",
		} satisfies Partial<CSSStyleDeclaration>);
		if (isRunning) node.dataset.litusAnimate = "running-step-glow";

		if (isDone && !isRunning) {
			node.innerHTML =
				'<svg width="7" height="7" viewBox="0 0 10 10" fill="none" stroke="#0b0f16" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5l2 2 4-4"/></svg>';
		} else if (isRunning) {
			const inner = document.createElement("span");
			inner.className = "pulse-dot";
			Object.assign(inner.style, {
				background: "#0b0f16",
				color: accent.c,
				width: "5px",
				height: "5px",
			} satisfies Partial<CSSStyleDeclaration>);
			node.appendChild(inner);
		}
		wrap.appendChild(node);

		const labelWrap = document.createElement("div");
		Object.assign(labelWrap.style, {
			textAlign: "center",
			minHeight: "32px",
		} satisfies Partial<CSSStyleDeclaration>);
		wrap.appendChild(labelWrap);

		const label = document.createElement("div");
		Object.assign(label.style, {
			fontSize: "11.5px",
			fontWeight: isRunning ? "600" : "400",
			color: isRunning
				? LITUS.text
				: isDone
					? LITUS.textDim
					: isSkip
						? LITUS.textMute
						: LITUS.textDim,
			textDecoration: isSkip ? "line-through" : "none",
			letterSpacing: "-0.01em",
		} satisfies Partial<CSSStyleDeclaration>);
		label.textContent = step.name;
		labelWrap.appendChild(label);

		if (step.durationMs != null) {
			const dur = document.createElement("div");
			dur.className = "mono";
			Object.assign(dur.style, {
				fontSize: "10px",
				color: isRunning ? accent.c : LITUS.textMute,
				marginTop: "2px",
			} satisfies Partial<CSSStyleDeclaration>);
			dur.textContent = formatDuration(step.durationMs);
			labelWrap.appendChild(dur);
		}

		return wrap;
	}

	function update(model: PipelineStepperModel, accent: TaskAccent): void {
		if (model.currentIndex < 0) {
			counter.textContent = `queued · ${model.type} pipeline`;
		} else {
			counter.textContent = `step ${model.currentIndex + 1} / ${model.steps.length} · ${model.type} pipeline`;
		}

		const pct =
			model.steps.length > 0
				? Math.max(0, Math.min(1, (model.currentIndex + 0.5) / model.steps.length))
				: 0;
		railFill.style.width = `calc(${pct * 100}% )`;
		railFill.style.background = accent.c;
		railFill.style.boxShadow = `0 0 10px ${accent.glow}`;

		stepsGrid.style.gridTemplateColumns = `repeat(${Math.max(1, model.steps.length)}, 1fr)`;

		// Reconcile existing nodes: replace each indexed slot rather than wiping
		// the grid, so focus on a step node and the running-step animation
		// survive between updates.
		const children = stepsGrid.children;
		for (let i = 0; i < model.steps.length; i++) {
			const fresh = buildStep(model.steps[i], accent);
			if (i < children.length) {
				children[i].replaceWith(fresh);
			} else {
				stepsGrid.appendChild(fresh);
			}
		}
		while (stepsGrid.children.length > model.steps.length) {
			stepsGrid.lastElementChild?.remove();
		}
	}

	update(initial, initialAccent);

	return { element: host, update };
}
