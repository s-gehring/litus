import { LITUS } from "../../design-system/tokens";
import type { ConfigRowModel } from "./run-screen-model";

export interface ConfigRowHandlers {
	onModelChange: (model: string) => void;
	onEffortChange: (effort: ConfigRowModel["effort"]) => void;
}

export interface ConfigRowController {
	element: HTMLElement;
	update(model: ConfigRowModel): void;
}

const MODEL_OPTIONS = [
	{ id: "haiku-4", label: "Haiku 4" },
	{ id: "sonnet-4.5", label: "Sonnet 4.5" },
	{ id: "opus-4.7", label: "Opus 4.7" },
];

const EFFORT_OPTIONS: Array<ConfigRowModel["effort"]> = ["low", "medium", "high"];

export function createConfigRow(
	initial: ConfigRowModel,
	handlers: ConfigRowHandlers,
): ConfigRowController {
	const row = document.createElement("div");
	row.dataset.runScreen = "config-row";
	Object.assign(row.style, {
		display: "flex",
		gap: "10px",
		alignItems: "center",
		fontSize: "11.5px",
		color: LITUS.textDim,
		fontFamily: "'JetBrains Mono', ui-monospace, monospace",
	} satisfies Partial<CSSStyleDeclaration>);

	function label(text: string, mlStart = false): HTMLSpanElement {
		const s = document.createElement("span");
		s.textContent = text;
		s.style.color = LITUS.textMute;
		if (mlStart) s.style.marginLeft = "6px";
		return s;
	}

	row.appendChild(label("model"));

	const modelPicker = document.createElement("div");
	Object.assign(modelPicker.style, {
		display: "inline-flex",
		background: "rgba(255,255,255,.03)",
		border: `1px solid ${LITUS.border}`,
		borderRadius: "8px",
		padding: "2px",
	} satisfies Partial<CSSStyleDeclaration>);
	const modelButtons = new Map<string, HTMLButtonElement>();
	for (const opt of MODEL_OPTIONS) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.dataset.value = opt.id;
		btn.textContent = opt.label;
		Object.assign(btn.style, {
			border: "none",
			cursor: "pointer",
			fontFamily: "inherit",
			padding: "3px 9px",
			borderRadius: "6px",
			fontSize: "11.5px",
			background: "transparent",
			color: LITUS.textMute,
		} satisfies Partial<CSSStyleDeclaration>);
		btn.addEventListener("click", () => handlers.onModelChange(opt.id));
		modelButtons.set(opt.id, btn);
		modelPicker.appendChild(btn);
	}
	row.appendChild(modelPicker);

	row.appendChild(label("effort", true));

	const effortPicker = document.createElement("div");
	Object.assign(effortPicker.style, {
		display: "inline-flex",
		gap: "2px",
	} satisfies Partial<CSSStyleDeclaration>);
	const effortButtons = new Map<string, HTMLButtonElement>();
	for (const opt of EFFORT_OPTIONS) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.dataset.value = opt;
		btn.textContent = opt;
		Object.assign(btn.style, {
			padding: "2px 8px",
			borderRadius: "6px",
			background: "transparent",
			color: LITUS.textMute,
			cursor: "pointer",
			fontFamily: "inherit",
			fontSize: "11.5px",
		} satisfies Partial<CSSStyleDeclaration>);
		btn.addEventListener("click", () => handlers.onEffortChange(opt));
		effortButtons.set(opt, btn);
		effortPicker.appendChild(btn);
	}
	row.appendChild(effortPicker);

	const spacer = document.createElement("span");
	spacer.style.flex = "1";
	row.appendChild(spacer);

	row.appendChild(label("tokens"));
	const tokensValue = document.createElement("span");
	row.appendChild(tokensValue);
	const mid = document.createElement("span");
	mid.style.color = LITUS.textMute;
	mid.style.marginLeft = "4px";
	mid.textContent = "·";
	row.appendChild(mid);
	row.appendChild(label("spend"));
	const spendValue = document.createElement("span");
	row.appendChild(spendValue);

	function paintPickers(modelId: string, effort: string): void {
		for (const [id, btn] of modelButtons) {
			const on = id === modelId;
			btn.style.background = on ? "rgba(255,255,255,.08)" : "transparent";
			btn.style.color = on ? LITUS.text : LITUS.textMute;
		}
		for (const [id, btn] of effortButtons) {
			const on = id === effort;
			btn.style.border = `1px solid ${on ? LITUS.borderStrong : LITUS.border}`;
			btn.style.background = on ? "rgba(255,255,255,.06)" : "transparent";
			btn.style.color = on ? LITUS.text : LITUS.textMute;
		}
	}

	function update(m: ConfigRowModel): void {
		paintPickers(m.model, m.effort);
		if (m.metrics.tokens == null) {
			tokensValue.textContent = "—";
			tokensValue.style.color = LITUS.textMute;
		} else {
			tokensValue.textContent = formatTokens(m.metrics.tokens);
			tokensValue.style.color = LITUS.text;
		}
		if (m.metrics.spendUsd == null) {
			spendValue.textContent = "—";
			spendValue.style.color = LITUS.textMute;
		} else {
			spendValue.textContent = `$${m.metrics.spendUsd.toFixed(2)}`;
			spendValue.style.color = LITUS.text;
		}
	}

	update(initial);
	return { element: row, update };
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}
