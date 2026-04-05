export const STATUS_LABELS: Record<string, string> = {
	idle: "Idle",
	running: "Running",
	waiting_for_input: "Waiting",
	waiting_for_dependencies: "Waiting",
	completed: "Done",
	cancelled: "Cancelled",
	error: "Error",
};

export const STATUS_CLASSES: Record<string, string> = {
	idle: "card-status-idle",
	running: "card-status-running",
	waiting_for_input: "card-status-waiting",
	waiting_for_dependencies: "card-status-waiting-deps",
	completed: "card-status-completed",
	cancelled: "card-status-cancelled",
	error: "card-status-error",
};

export const EPIC_CARD_PREFIX = "epic:";
