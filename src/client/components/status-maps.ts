export const STATUS_LABELS: Record<string, string> = {
	idle: "Idle",
	running: "Running",
	waiting_for_input: "Waiting: Input",
	waiting_for_dependencies: "Waiting: Deps",
	paused: "Paused",
	completed: "Done",
	aborted: "Aborted",
	error: "Error",
};

export const STATUS_CLASSES: Record<string, string> = {
	idle: "card-status-idle",
	running: "card-status-running",
	waiting_for_input: "card-status-waiting",
	waiting_for_dependencies: "card-status-waiting-deps",
	paused: "card-status-paused",
	completed: "card-status-completed",
	aborted: "card-status-aborted",
	error: "card-status-error",
};

export const EPIC_CARD_PREFIX = "epic:";

export const EPIC_AGG_STATUS_CLASSES: Record<string, string> = {
	idle: "card-status-idle",
	running: "card-status-running",
	paused: "card-status-paused",
	waiting: "card-status-waiting",
	error: "card-status-error",
	in_progress: "card-status-running",
	completed: "card-status-completed",
};
