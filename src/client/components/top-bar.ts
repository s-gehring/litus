import { LITUS, typeAccent } from "../design-system/tokens";
import type { TopBarAutoMode, TopBarModel } from "./top-bar-model";

export interface TopBarHandlers {
	onAutoModeToggle: (next: TopBarAutoMode) => void;
	onNewQuickFix: () => void;
	onNewSpec: () => void;
	onNewEpic: () => void;
	onBellClick: () => void;
	onGearClick: () => void;
}

export interface TopBarController {
	element: HTMLElement;
	update(model: TopBarModel): void;
}

function litusMark(): SVGElement {
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("width", "22");
	svg.setAttribute("height", "22");
	svg.setAttribute("viewBox", "0 0 22 22");
	svg.style.display = "block";
	const defs = document.createElementNS(ns, "defs");
	const grad = document.createElementNS(ns, "linearGradient");
	grad.setAttribute("id", "litusMarkGrad");
	grad.setAttribute("x1", "0");
	grad.setAttribute("y1", "0");
	grad.setAttribute("x2", "1");
	grad.setAttribute("y2", "1");
	for (const [off, col] of [
		["0", LITUS.amber],
		[".55", LITUS.cyan],
		["1", LITUS.violet],
	] as const) {
		const stop = document.createElementNS(ns, "stop");
		stop.setAttribute("offset", off);
		stop.setAttribute("stop-color", col);
		grad.appendChild(stop);
	}
	defs.appendChild(grad);
	svg.appendChild(defs);
	const arc = document.createElementNS(ns, "path");
	arc.setAttribute("d", "M3 16 Q 11 3 19 16");
	arc.setAttribute("fill", "none");
	arc.setAttribute("stroke", "url(#litusMarkGrad)");
	arc.setAttribute("stroke-width", "1.5");
	arc.setAttribute("stroke-linecap", "round");
	arc.setAttribute("opacity", ".75");
	svg.appendChild(arc);
	for (const [cx, cy, color] of [
		[3, 16, LITUS.amber],
		[11, 5.5, LITUS.cyan],
		[19, 16, LITUS.violet],
	] as const) {
		const c = document.createElementNS(ns, "circle");
		c.setAttribute("cx", String(cx));
		c.setAttribute("cy", String(cy));
		c.setAttribute("r", "2.4");
		c.setAttribute("fill", color);
		svg.appendChild(c);
	}
	return svg;
}

function makeNewButton(type: "quickfix" | "spec" | "epic", onClick: () => void): HTMLButtonElement {
	const a = typeAccent(type);
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "btn";
	Object.assign(btn.style, {
		color: a.c,
		background: `linear-gradient(180deg, ${a.dim}, transparent)`,
		border: `1px solid color-mix(in oklch, ${a.c} 35%, transparent)`,
		fontWeight: "500",
	} satisfies Partial<CSSStyleDeclaration>);
	btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6 1.5v9M1.5 6h9"/></svg> New ${a.label}`;
	btn.addEventListener("click", onClick);
	return btn;
}

function iconButton(ariaLabel: string, svg: string, onClick: () => void): HTMLButtonElement {
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "btn btn-ghost";
	btn.setAttribute("aria-label", ariaLabel);
	Object.assign(btn.style, {
		position: "relative",
		padding: "7px",
		color: LITUS.textDim,
	} satisfies Partial<CSSStyleDeclaration>);
	btn.innerHTML = svg;
	btn.addEventListener("click", onClick);
	return btn;
}

function divider(): HTMLElement {
	const d = document.createElement("span");
	Object.assign(d.style, {
		width: "1px",
		height: "20px",
		background: LITUS.border,
		margin: "0 4px",
	} satisfies Partial<CSSStyleDeclaration>);
	return d;
}

export function createTopBar(initial: TopBarModel, handlers: TopBarHandlers): TopBarController {
	const host = document.createElement("div");
	host.dataset.runScreen = "top-bar";
	Object.assign(host.style, {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		padding: "14px 22px",
		borderBottom: `1px solid ${LITUS.border}`,
		background: "linear-gradient(180deg, rgba(20,26,38,.6), rgba(14,19,28,.2))",
		backdropFilter: "blur(10px)",
		position: "relative",
		zIndex: "2",
	} satisfies Partial<CSSStyleDeclaration>);

	const leftGroup = document.createElement("div");
	Object.assign(leftGroup.style, {
		display: "flex",
		alignItems: "center",
		gap: "10px",
	} satisfies Partial<CSSStyleDeclaration>);
	host.appendChild(leftGroup);

	leftGroup.appendChild(litusMark() as unknown as Node);

	const wordmark = document.createElement("span");
	wordmark.className = "serif";
	wordmark.textContent = "Litus";
	Object.assign(wordmark.style, {
		fontSize: "22px",
		letterSpacing: "-0.2px",
	} satisfies Partial<CSSStyleDeclaration>);
	leftGroup.appendChild(wordmark);

	const versionEl = document.createElement("span");
	versionEl.className = "mono";
	Object.assign(versionEl.style, {
		fontSize: "11px",
		color: LITUS.textMute,
		marginLeft: "8px",
		letterSpacing: "0.1em",
	} satisfies Partial<CSSStyleDeclaration>);
	leftGroup.appendChild(versionEl);

	leftGroup.appendChild(divider());

	const connGroup = document.createElement("span");
	Object.assign(connGroup.style, {
		fontSize: "12px",
		color: LITUS.textDim,
		display: "inline-flex",
		alignItems: "center",
		gap: "6px",
	} satisfies Partial<CSSStyleDeclaration>);
	const connDot = document.createElement("span");
	connDot.className = "dot";
	connGroup.appendChild(connDot);
	const connLabel = document.createElement("span");
	connGroup.appendChild(connLabel);
	leftGroup.appendChild(connGroup);

	const rightGroup = document.createElement("div");
	Object.assign(rightGroup.style, {
		display: "flex",
		alignItems: "center",
		gap: "8px",
	} satisfies Partial<CSSStyleDeclaration>);
	host.appendChild(rightGroup);

	const toggleWrap = document.createElement("div");
	Object.assign(toggleWrap.style, {
		display: "inline-flex",
		background: "rgba(255,255,255,.035)",
		border: `1px solid ${LITUS.border}`,
		borderRadius: "10px",
		padding: "3px",
	} satisfies Partial<CSSStyleDeclaration>);
	const modeButtons: Record<TopBarAutoMode, HTMLButtonElement> = {
		auto: document.createElement("button"),
		manual: document.createElement("button"),
	};
	const modeOrder: readonly TopBarAutoMode[] = ["auto", "manual"];
	// Last painted mode — used to suppress redundant `onAutoModeToggle`
	// dispatches so a click on the already-active segment does not silently
	// downgrade a tri-state `full-auto` server value to `normal` (§2.2).
	let lastPaintedMode: TopBarAutoMode | null = null;
	function emitModeChange(m: TopBarAutoMode): void {
		if (lastPaintedMode === m) return;
		handlers.onAutoModeToggle(m);
	}
	function focusMode(m: TopBarAutoMode): void {
		modeButtons[m].focus();
	}
	for (const m of modeOrder) {
		const b = modeButtons[m];
		b.type = "button";
		b.dataset.mode = m;
		Object.assign(b.style, {
			border: "none",
			cursor: "pointer",
			fontFamily: "inherit",
			padding: "5px 12px",
			borderRadius: "7px",
			fontSize: "12px",
			background: "transparent",
			color: LITUS.textDim,
		} satisfies Partial<CSSStyleDeclaration>);
		b.textContent = m === "auto" ? "Auto" : "Manual";
		b.addEventListener("click", () => emitModeChange(m));
		// Keyboard: Left/Right arrows roam between segments; Enter/Space selects
		// (native <button> already fires click on Enter/Space, so the focused
		// segment is already actuable — arrow-key roving is what's missing per
		// contract §1.3 / §2.3).
		b.addEventListener("keydown", (e) => {
			if (e.key === "ArrowRight" || e.key === "ArrowDown") {
				e.preventDefault();
				const next = modeOrder[(modeOrder.indexOf(m) + 1) % modeOrder.length];
				focusMode(next);
			} else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
				e.preventDefault();
				const prev = modeOrder[(modeOrder.indexOf(m) - 1 + modeOrder.length) % modeOrder.length];
				focusMode(prev);
			}
		});
		toggleWrap.appendChild(b);
	}
	rightGroup.appendChild(toggleWrap);

	rightGroup.appendChild(divider());
	rightGroup.appendChild(makeNewButton("quickfix", handlers.onNewQuickFix));
	rightGroup.appendChild(makeNewButton("spec", handlers.onNewSpec));
	rightGroup.appendChild(makeNewButton("epic", handlers.onNewEpic));
	rightGroup.appendChild(divider());

	const bell = iconButton(
		"Notifications",
		'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
		handlers.onBellClick,
	);
	const bellPulse = document.createElement("span");
	Object.assign(bellPulse.style, {
		position: "absolute",
		top: "4px",
		right: "5px",
		width: "6px",
		height: "6px",
		borderRadius: "3px",
		background: LITUS.amber,
		boxShadow: `0 0 6px ${LITUS.amber}`,
		display: "none",
	} satisfies Partial<CSSStyleDeclaration>);
	bell.appendChild(bellPulse);
	rightGroup.appendChild(bell);

	const gear = iconButton(
		"Settings",
		'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
		handlers.onGearClick,
	);
	rightGroup.appendChild(gear);

	function paintMode(mode: TopBarAutoMode): void {
		for (const m of modeOrder) {
			const b = modeButtons[m];
			const on = m === mode;
			b.style.background = on ? "rgba(255,255,255,.08)" : "transparent";
			b.style.color = on ? LITUS.text : LITUS.textDim;
			b.style.boxShadow = on ? `inset 0 0 0 1px ${LITUS.border}` : "none";
		}
		lastPaintedMode = mode;
	}

	function update(model: TopBarModel): void {
		versionEl.textContent = `v${model.version}`;
		connDot.style.background = model.connected ? LITUS.green : LITUS.red;
		connDot.style.boxShadow = model.connected ? `0 0 8px ${LITUS.green}` : "none";
		// Contract §1.2: the connection label hides when connected without a
		// repo slug (only the green dot is shown). Disconnected always labels.
		if (!model.connected) {
			connLabel.textContent = "disconnected";
			connLabel.style.display = "";
		} else if (model.repoSlug) {
			connLabel.textContent = `connected · ${model.repoSlug}`;
			connLabel.style.display = "";
		} else {
			connLabel.textContent = "";
			connLabel.style.display = "none";
		}
		paintMode(model.autoMode);
		bellPulse.style.display = model.alertsUnseen ? "inline-block" : "none";
	}

	update(initial);
	return { element: host, update };
}
