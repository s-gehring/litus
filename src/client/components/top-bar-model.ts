import type { AutoMode } from "../../types";

export type TopBarAutoMode = "auto" | "manual";

export interface TopBarModel {
	version: string;
	connected: boolean;
	repoSlug: string | null;
	autoMode: TopBarAutoMode;
	alertsUnseen: boolean;
}

/**
 * Collapse the server's `AutoMode` tri-state (`manual` | `normal` | `full-auto`)
 * onto the top bar's binary `auto` / `manual` toggle per FR-010. `manual` maps
 * to manual; both `normal` and `full-auto` map to auto.
 */
export function topBarAutoMode(mode: AutoMode): TopBarAutoMode {
	return mode === "manual" ? "manual" : "auto";
}

/** Round-trip: map the toggle's binary state back to the server enum. */
export function serverAutoModeFor(mode: TopBarAutoMode): AutoMode {
	return mode === "manual" ? "manual" : "normal";
}
