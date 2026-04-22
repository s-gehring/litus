import { LITUS } from "../../design-system/tokens";
import { sectionLabel } from "./primitives";
import type { TouchedFile } from "./run-screen-model";

const GREEN = "oklch(0.80 0.14 155)";

export interface TouchedFilesCardController {
	element: HTMLElement;
	update(files: TouchedFile[]): void;
}

function fileRow(file: TouchedFile): HTMLElement {
	const col = file.kind === "edit" ? LITUS.amber : file.kind === "new" ? GREEN : LITUS.textMute;
	const d = document.createElement("div");
	Object.assign(d.style, {
		display: "flex",
		alignItems: "center",
		gap: "8px",
		padding: "5px 0",
		fontSize: "11.5px",
		fontFamily: "'JetBrains Mono', ui-monospace, monospace",
	} satisfies Partial<CSSStyleDeclaration>);

	const glyph = document.createElement("span");
	Object.assign(glyph.style, {
		color: col,
		width: "10px",
		textAlign: "center",
		fontSize: "9px",
	} satisfies Partial<CSSStyleDeclaration>);
	glyph.textContent = file.kind === "edit" ? "✎" : file.kind === "new" ? "+" : "·";
	d.appendChild(glyph);

	const path = document.createElement("span");
	Object.assign(path.style, {
		color: LITUS.textDim,
		flex: "1",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
	} satisfies Partial<CSSStyleDeclaration>);
	path.textContent = file.path;
	path.title = file.path;
	d.appendChild(path);

	// Stat column (+n −m) dropped per §2.6: the server doesn't emit per-file
	// added/removed line counts, so the UI would ship permanently empty. Drop
	// it from data-model.md §10 / FR-035 when re-spec'd.

	return d;
}

export function createTouchedFilesCard(initial: TouchedFile[]): TouchedFilesCardController {
	const host = document.createElement("div");
	host.className = "glass";
	host.dataset.runScreen = "touched-files-card";
	Object.assign(host.style, {
		borderRadius: "14px",
		padding: "14px 16px",
	} satisfies Partial<CSSStyleDeclaration>);
	host.appendChild(sectionLabel("Touched files"));

	const body = document.createElement("div");
	host.appendChild(body);

	function update(files: TouchedFile[]): void {
		body.innerHTML = "";
		if (files.length === 0) {
			const empty = document.createElement("div");
			empty.textContent = "No files touched yet.";
			Object.assign(empty.style, {
				color: LITUS.textMute,
				fontSize: "11.5px",
				padding: "4px 0",
			} satisfies Partial<CSSStyleDeclaration>);
			body.appendChild(empty);
			return;
		}
		for (const f of files) body.appendChild(fileRow(f));
	}

	update(initial);
	return { element: host, update };
}
