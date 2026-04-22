import { LITUS } from "../../design-system/tokens";
import { sectionLabel } from "./primitives";
import type { RunScreenEnvironment } from "./run-screen-model";

export interface EnvironmentCardController {
	element: HTMLElement;
	update(env: RunScreenEnvironment): void;
}

const GREEN = "oklch(0.80 0.14 155)";

function envRow(label: string, value: string | null, accent?: string): HTMLElement {
	const d = document.createElement("div");
	Object.assign(d.style, {
		display: "flex",
		justifyContent: "space-between",
		padding: "6px 0",
		fontSize: "12px",
		borderBottom: `1px dashed ${LITUS.border}`,
	} satisfies Partial<CSSStyleDeclaration>);
	const lbl = document.createElement("span");
	lbl.textContent = label;
	lbl.style.color = LITUS.textMute;
	d.appendChild(lbl);
	const val = document.createElement("span");
	val.className = "mono";
	if (value == null || value === "") {
		val.textContent = "·";
		val.style.color = LITUS.textMute;
	} else {
		val.textContent = value;
		val.style.color = accent ?? LITUS.text;
	}
	d.appendChild(val);
	return d;
}

export function createEnvironmentCard(initial: RunScreenEnvironment): EnvironmentCardController {
	const host = document.createElement("div");
	host.className = "glass";
	host.dataset.runScreen = "environment-card";
	Object.assign(host.style, {
		borderRadius: "14px",
		padding: "14px 16px",
	} satisfies Partial<CSSStyleDeclaration>);
	host.appendChild(sectionLabel("Environment"));

	const rows = document.createElement("div");
	host.appendChild(rows);

	function update(env: RunScreenEnvironment): void {
		rows.innerHTML = "";
		rows.appendChild(envRow("Worktree", env.worktree));
		rows.appendChild(envRow("Python", env.python));
		rows.appendChild(envRow("Node", env.node));
		rows.appendChild(envRow("pnpm", env.pnpm));
		rows.appendChild(envRow("CLAUDE.md", env.claudeMdLoaded ? "✓ loaded" : null, GREEN));
		const skillsValue =
			env.skills.length === 0 ? null : env.skills.map((s) => `${s.name} · ${s.count}`).join(", ");
		rows.appendChild(envRow("Skills", skillsValue));
	}

	update(initial);
	return { element: host, update };
}
