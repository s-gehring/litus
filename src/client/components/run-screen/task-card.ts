import { LITUS, typeAccent } from "../../design-system/tokens";
import type { TaskCardModel, TaskPipelineSegment } from "./task-card-model";

const CARD_WIDTH: Record<TaskCardModel["type"], number> = {
	quickfix: 200,
	spec: 236,
	epic: 280,
};

const DEFAULT_STEPS: Record<TaskCardModel["type"], number> = {
	quickfix: 7,
	spec: 9,
	epic: 9,
};

function formatElapsed(ms: number): string {
	if (ms <= 0) return "";
	const s = Math.floor(ms / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
	if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
	return `${sec}s`;
}

function stateChip(state: TaskCardModel["state"], accentColor: string): HTMLElement {
	const el = document.createElement("span");
	el.className = "mono";
	Object.assign(el.style, {
		fontSize: "9px",
		letterSpacing: "0.08em",
		textTransform: "uppercase",
	} satisfies Partial<CSSStyleDeclaration>);
	if (state === "paused") el.style.color = LITUS.amber;
	else if (state === "blocked") el.style.color = LITUS.red;
	else if (state === "running") el.style.color = accentColor;
	else el.style.color = LITUS.textMute;
	el.textContent = state;
	return el;
}

function pipelineBar(
	pipeline: TaskPipelineSegment[],
	accentC: string,
	type: TaskCardModel["type"],
): HTMLElement {
	const total = pipeline.length > 0 ? pipeline.length : DEFAULT_STEPS[type];
	const done = pipeline.filter((p) => p.state === "done").length;
	const runningIdx = pipeline.findIndex((p) => p.state === "running");

	const wrap = document.createElement("div");
	Object.assign(wrap.style, {
		display: "flex",
		gap: "2px",
		height: "3px",
		marginTop: "2px",
	} satisfies Partial<CSSStyleDeclaration>);

	for (let i = 0; i < total; i++) {
		const seg = document.createElement("span");
		const isDone = i < done;
		const isCurrent = i === runningIdx;
		Object.assign(seg.style, {
			flex: "1",
			borderRadius: "2px",
			background: isDone
				? accentC
				: isCurrent
					? `color-mix(in oklch, ${accentC} 60%, transparent)`
					: "rgba(148,163,184,.13)",
			boxShadow: isDone ? `0 0 6px color-mix(in oklch, ${accentC} 55%, transparent)` : "none",
		} satisfies Partial<CSSStyleDeclaration>);
		if (isCurrent) seg.dataset.litusAnimate = "running-step-bar";
		wrap.appendChild(seg);
	}
	return wrap;
}

export function createTaskCard(
	model: TaskCardModel,
	onClick: (routeId: string, type: TaskCardModel["type"]) => void,
): HTMLButtonElement {
	const accent = typeAccent(model.type);
	const btn = document.createElement("button");
	btn.type = "button";
	btn.dataset.taskCardId = model.id;
	btn.dataset.taskType = model.type;
	btn.dataset.taskState = model.state;
	btn.dataset.taskSelected = String(model.selected);
	const width = CARD_WIDTH[model.type];

	const selectedBg = `linear-gradient(180deg, ${accent.dim}, rgba(14,19,28,.8))`;
	const normalBg = "linear-gradient(180deg, rgba(26,33,48,.65), rgba(14,19,28,.5))";
	Object.assign(btn.style, {
		position: "relative",
		flexShrink: "0",
		width: `${width}px`,
		textAlign: "left",
		cursor: "pointer",
		padding: "11px 13px 10px",
		borderRadius: "12px",
		background: model.selected ? selectedBg : normalBg,
		border: `1px solid ${model.selected ? accent.c : LITUS.border}`,
		boxShadow: model.selected
			? `0 0 0 1px ${accent.glow}, 0 8px 28px -12px ${accent.glow}`
			: "0 1px 0 rgba(255,255,255,.03) inset",
		backdropFilter: "blur(12px)",
		fontFamily: "inherit",
		color: LITUS.text,
		transition: "transform .15s, box-shadow .15s",
	} satisfies Partial<CSSStyleDeclaration>);
	btn.addEventListener("click", () => onClick(model.routeId, model.type));

	const stripe = document.createElement("span");
	Object.assign(stripe.style, {
		position: "absolute",
		left: "0",
		top: "10px",
		bottom: "10px",
		width: "2px",
		background: accent.c,
		borderRadius: "2px",
		boxShadow: `0 0 10px ${accent.glow}`,
	} satisfies Partial<CSSStyleDeclaration>);
	btn.appendChild(stripe);

	const head = document.createElement("div");
	Object.assign(head.style, {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		marginBottom: "6px",
	} satisfies Partial<CSSStyleDeclaration>);

	const chipEl = document.createElement("span");
	chipEl.className = "chip";
	Object.assign(chipEl.style, {
		background: accent.dim,
		color: accent.c,
		border: `1px solid color-mix(in oklch, ${accent.c} 30%, transparent)`,
		padding: "2px 7px",
		fontSize: "9.5px",
	} satisfies Partial<CSSStyleDeclaration>);
	if (model.state === "running") {
		const dot = document.createElement("span");
		dot.className = "pulse-dot";
		dot.style.color = accent.c;
		dot.style.background = accent.c;
		chipEl.appendChild(dot);
	}
	chipEl.appendChild(document.createTextNode(accent.abbr));
	if (model.type === "epic" && model.branchProgress) {
		const extra = document.createElement("span");
		extra.style.opacity = "0.7";
		extra.style.marginLeft = "3px";
		extra.textContent = `· ${model.branchProgress.done}/${model.branchProgress.total}`;
		chipEl.appendChild(extra);
	}
	head.appendChild(chipEl);
	head.appendChild(stateChip(model.state, accent.c));
	btn.appendChild(head);

	const title = document.createElement("div");
	Object.assign(title.style, {
		fontSize: "13px",
		fontWeight: "500",
		lineHeight: "1.3",
		letterSpacing: "-0.01em",
		color: model.state === "queued" ? LITUS.textDim : LITUS.text,
		marginBottom: "3px",
		display: "-webkit-box",
		webkitBoxOrient: "vertical",
		overflow: "hidden",
		minHeight: "34px",
	} satisfies Partial<CSSStyleDeclaration>);
	(title.style as CSSStyleDeclaration & Record<string, string>)["-webkit-line-clamp"] = "2";
	title.textContent = model.title;
	btn.appendChild(title);

	const meta = document.createElement("div");
	meta.className = "mono";
	Object.assign(meta.style, {
		display: "flex",
		alignItems: "center",
		gap: "8px",
		fontSize: "10.5px",
		color: LITUS.textMute,
		marginBottom: "7px",
		minHeight: "13px",
	} satisfies Partial<CSSStyleDeclaration>);
	const metaParts: string[] = [];
	if (model.currentStep) metaParts.push(model.currentStep);
	else metaParts.push(`#${model.id.slice(0, 8)}`);
	if (model.elapsedMs > 0) metaParts.push(formatElapsed(model.elapsedMs));
	meta.textContent = metaParts.join(" · ");
	btn.appendChild(meta);

	btn.appendChild(pipelineBar(model.pipeline, accent.c, model.type));

	return btn;
}
