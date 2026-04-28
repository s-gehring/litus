import type { EffortLevel } from "../../config-types";

export const EFFORT_LEVELS_ORDER: readonly EffortLevel[] = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export function formatEffortLabel(effort: EffortLevel | null | undefined): string {
	if (effort == null) return "Default";
	if (effort === "xhigh") return "Extra High";
	return effort.charAt(0).toUpperCase() + effort.slice(1);
}
