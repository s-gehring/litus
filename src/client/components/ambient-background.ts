// Ambient background — three blurred radial blobs (amber TL / cyan TR / violet
// bottom-middle) layered over a deep slate fill, plus a faint 48px SVG grid
// overlay at 0.25 opacity. Mounted once at boot from app.ts and survives all
// route transitions (FR-006, FR-007, SC-005).

import { LITUS } from "../design-system/tokens";

const HOST_ID = "litus-ambient-bg";

interface BlobSpec {
	style: Partial<CSSStyleDeclaration>;
	gradient: string;
}

const BLOBS: BlobSpec[] = [
	{
		style: { top: "-240px", left: "-160px", width: "680px", height: "680px", filter: "blur(40px)" },
		gradient: "radial-gradient(circle at 30% 30%, oklch(0.82 0.14 72 / 0.10), transparent 60%)",
	},
	{
		style: { top: "120px", right: "-200px", width: "720px", height: "720px", filter: "blur(40px)" },
		gradient: "radial-gradient(circle at 50% 50%, oklch(0.82 0.11 210 / 0.09), transparent 60%)",
	},
	{
		style: {
			bottom: "-260px",
			left: "30%",
			width: "820px",
			height: "580px",
			filter: "blur(50px)",
		},
		gradient: "radial-gradient(circle at 50% 50%, oklch(0.76 0.14 298 / 0.08), transparent 65%)",
	},
];

export function mountAmbientBackground(parent: HTMLElement = document.body): HTMLElement {
	const existing = parent.querySelector<HTMLElement>(`#${HOST_ID}`);
	if (existing) return existing;

	const host = document.createElement("div");
	host.id = HOST_ID;
	host.setAttribute("aria-hidden", "true");
	Object.assign(host.style, {
		position: "fixed",
		inset: "0",
		zIndex: "0",
		pointerEvents: "none",
		overflow: "hidden",
	} satisfies Partial<CSSStyleDeclaration>);

	const baseFill = document.createElement("div");
	Object.assign(baseFill.style, {
		position: "absolute",
		inset: "0",
		background: LITUS.bg,
	} satisfies Partial<CSSStyleDeclaration>);
	host.appendChild(baseFill);

	for (const blob of BLOBS) {
		const el = document.createElement("div");
		Object.assign(el.style, {
			position: "absolute",
			borderRadius: "50%",
			background: blob.gradient,
			...blob.style,
		} satisfies Partial<CSSStyleDeclaration>);
		host.appendChild(el);
	}

	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("width", "100%");
	svg.setAttribute("height", "100%");
	svg.style.position = "absolute";
	svg.style.inset = "0";
	svg.style.opacity = "0.25";
	svg.style.pointerEvents = "none";

	const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
	const pattern = document.createElementNS("http://www.w3.org/2000/svg", "pattern");
	pattern.setAttribute("id", "litusGrid");
	pattern.setAttribute("width", "48");
	pattern.setAttribute("height", "48");
	pattern.setAttribute("patternUnits", "userSpaceOnUse");
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute("d", "M 48 0 L 0 0 0 48");
	path.setAttribute("fill", "none");
	path.setAttribute("stroke", "rgba(148,163,184,.05)");
	path.setAttribute("stroke-width", "1");
	pattern.appendChild(path);
	defs.appendChild(pattern);
	svg.appendChild(defs);

	const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
	rect.setAttribute("width", "100%");
	rect.setAttribute("height", "100%");
	rect.setAttribute("fill", "url(#litusGrid)");
	svg.appendChild(rect);

	host.appendChild(svg);
	parent.insertBefore(host, parent.firstChild);
	return host;
}
