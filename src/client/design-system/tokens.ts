export interface LitusTokens {
	bg: string;
	panel: string;
	panelStrong: string;
	border: string;
	borderStrong: string;
	text: string;
	textDim: string;
	textMute: string;

	amber: string;
	amberDim: string;
	amberGlow: string;
	cyan: string;
	cyanDim: string;
	cyanGlow: string;
	violet: string;
	violetDim: string;
	violetGlow: string;

	green: string;
	red: string;
}

export const LITUS: LitusTokens = {
	bg: "#0b0f16",
	panel: "rgba(20, 26, 38, 0.55)",
	panelStrong: "rgba(24, 30, 44, 0.72)",
	border: "rgba(148, 163, 184, 0.10)",
	borderStrong: "rgba(148, 163, 184, 0.18)",
	text: "#e7ecf3",
	textDim: "#9aa4b5",
	textMute: "#6b7588",

	amber: "oklch(0.82 0.14 72)",
	amberDim: "oklch(0.82 0.14 72 / 0.14)",
	amberGlow: "oklch(0.82 0.14 72 / 0.28)",
	cyan: "oklch(0.82 0.11 210)",
	cyanDim: "oklch(0.82 0.11 210 / 0.14)",
	cyanGlow: "oklch(0.82 0.11 210 / 0.28)",
	violet: "oklch(0.76 0.14 298)",
	violetDim: "oklch(0.76 0.14 298 / 0.16)",
	violetGlow: "oklch(0.76 0.14 298 / 0.30)",

	green: "oklch(0.80 0.14 155)",
	red: "oklch(0.72 0.16 22)",
};

export type TaskType = "quickfix" | "spec" | "epic";

export interface TaskAccent {
	c: string;
	dim: string;
	glow: string;
	label: string;
	abbr: string;
}

const ACCENTS: Record<TaskType, TaskAccent> = {
	quickfix: {
		c: LITUS.amber,
		dim: LITUS.amberDim,
		glow: LITUS.amberGlow,
		label: "Quick Fix",
		abbr: "QF",
	},
	spec: {
		c: LITUS.cyan,
		dim: LITUS.cyanDim,
		glow: LITUS.cyanGlow,
		label: "Specification",
		abbr: "SP",
	},
	epic: {
		c: LITUS.violet,
		dim: LITUS.violetDim,
		glow: LITUS.violetGlow,
		label: "Epic",
		abbr: "EP",
	},
};

export function typeAccent(t: TaskType): TaskAccent {
	return ACCENTS[t];
}

// Mapping table from TS token key → CSS custom-property name (kebab).
// Exported so unit tests can assert parity with `LitusTokens` keys.
export const TOKEN_CSS_VAR: Record<keyof LitusTokens, string> = {
	bg: "--litus-bg",
	panel: "--litus-panel",
	panelStrong: "--litus-panel-strong",
	border: "--litus-border",
	borderStrong: "--litus-border-strong",
	text: "--litus-text",
	textDim: "--litus-text-dim",
	textMute: "--litus-text-mute",
	amber: "--litus-amber",
	amberDim: "--litus-amber-dim",
	amberGlow: "--litus-amber-glow",
	cyan: "--litus-cyan",
	cyanDim: "--litus-cyan-dim",
	cyanGlow: "--litus-cyan-glow",
	violet: "--litus-violet",
	violetDim: "--litus-violet-dim",
	violetGlow: "--litus-violet-glow",
	green: "--litus-green",
	red: "--litus-red",
};
