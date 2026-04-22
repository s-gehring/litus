// Shared DOM-builder helpers used across the redesigned run-screen surfaces.
// All helpers return plain HTMLElements; no framework, no reactive wrappers.

import { LITUS, type TaskAccent } from "../../design-system/tokens";

export interface ChipOptions {
	accent?: TaskAccent;
	pulse?: boolean;
	tone?: "neutral" | "accent";
	size?: "sm" | "md";
}

/** A pill chip — `chip` primitive class. Accent fills + colours when supplied. */
export function chip(label: string, opts: ChipOptions = {}): HTMLSpanElement {
	const el = document.createElement("span");
	el.className = "chip";
	if (opts.accent && (opts.tone ?? "accent") === "accent") {
		const a = opts.accent;
		el.style.background = a.dim;
		el.style.color = a.c;
		el.style.border = `1px solid color-mix(in oklch, ${a.c} 30%, transparent)`;
	} else {
		el.style.color = LITUS.textMute;
	}
	if (opts.size === "sm") {
		el.style.padding = "2px 7px";
		el.style.fontSize = "9.5px";
	}
	if (opts.pulse && opts.accent) {
		el.appendChild(pulseDot(opts.accent.c));
	}
	el.appendChild(document.createTextNode(label));
	return el;
}

/** A 6×6 colour swatch — `dot` primitive. */
export function dot(color: string, glow = false): HTMLSpanElement {
	const el = document.createElement("span");
	el.className = "dot";
	el.style.background = color;
	if (glow) el.style.boxShadow = `0 0 8px ${color}`;
	return el;
}

/** A pulsing 7×7 dot — `pulse-dot` primitive. */
export function pulseDot(color: string): HTMLSpanElement {
	const el = document.createElement("span");
	el.className = "pulse-dot";
	el.style.background = color;
	el.style.color = color;
	return el;
}

export interface SectionLabelOptions {
	right?: HTMLElement | string | null;
}

/** Small-caps section heading with hairline rule + optional right-aligned slot. */
export function sectionLabel(text: string, opts: SectionLabelOptions = {}): HTMLDivElement {
	const wrap = document.createElement("div");
	Object.assign(wrap.style, {
		display: "flex",
		alignItems: "center",
		gap: "10px",
		padding: "0 0 10px",
	} satisfies Partial<CSSStyleDeclaration>);

	const label = document.createElement("span");
	label.className = "mono";
	Object.assign(label.style, {
		fontSize: "10px",
		letterSpacing: "0.18em",
		color: LITUS.textMute,
		textTransform: "uppercase",
	} satisfies Partial<CSSStyleDeclaration>);
	label.textContent = text;
	wrap.appendChild(label);

	const rule = document.createElement("span");
	Object.assign(rule.style, {
		flex: "1",
		height: "1px",
		background: `linear-gradient(90deg, ${LITUS.border}, transparent)`,
	} satisfies Partial<CSSStyleDeclaration>);
	wrap.appendChild(rule);

	if (opts.right != null) {
		if (typeof opts.right === "string") {
			const r = document.createElement("span");
			r.textContent = opts.right;
			r.className = "mono";
			r.style.fontSize = "10.5px";
			r.style.color = LITUS.textMute;
			wrap.appendChild(r);
		} else {
			wrap.appendChild(opts.right);
		}
	}

	return wrap;
}

/** A label / value pair for the task header meta row. value=null → empty placeholder. */
export function metaField(label: string, value: string | null): HTMLDivElement {
	const wrap = document.createElement("div");
	Object.assign(wrap.style, {
		display: "inline-flex",
		alignItems: "center",
		gap: "6px",
		fontFamily: "'JetBrains Mono', ui-monospace, monospace",
		fontSize: "11px",
	} satisfies Partial<CSSStyleDeclaration>);
	const lbl = document.createElement("span");
	lbl.textContent = label;
	lbl.style.color = LITUS.textMute;
	wrap.appendChild(lbl);
	const val = document.createElement("span");
	if (value == null || value === "") {
		val.textContent = "·";
		val.style.color = LITUS.textMute;
	} else {
		val.textContent = value;
		val.style.color = LITUS.textDim;
	}
	wrap.appendChild(val);
	return wrap;
}
