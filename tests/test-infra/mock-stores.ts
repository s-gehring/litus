import { DEFAULT_CONFIG } from "../../src/config-store";
import type {
	AppConfig,
	ConfigValidationError,
	ConfigWarning,
	PersistedEpic,
	Workflow,
	WorkflowIndexEntry,
} from "../../src/types";
import { type CallTracker, createCallTracker } from "./call-tracker";

// ── Mock Workflow Store ──────────────────────────────────

export interface MockWorkflowStore {
	mock: {
		save(workflow: Workflow): Promise<void>;
		load(id: string): Promise<Workflow | null>;
		loadAll(): Promise<Workflow[]>;
		loadIndex(): Promise<WorkflowIndexEntry[]>;
		remove(id: string): Promise<void>;
		removeAll(): Promise<void>;
		waitForPendingWrites(): Promise<void>;
	};
	tracker: CallTracker;
	seedWorkflow(workflow: Workflow): void;
}

/** Create a mock workflow store backed by an in-memory map */
export function createMockWorkflowStore(): MockWorkflowStore {
	const tracker = createCallTracker();
	const workflows = new Map<string, Workflow>();

	const mock = {
		async save(workflow: Workflow): Promise<void> {
			tracker.calls.push({ method: "save", args: [workflow] });
			workflows.set(workflow.id, workflow);
		},
		async load(id: string): Promise<Workflow | null> {
			const result = workflows.get(id) ?? null;
			tracker.calls.push({ method: "load", args: [id], returnValue: result });
			return result;
		},
		async loadAll(): Promise<Workflow[]> {
			const result = Array.from(workflows.values());
			tracker.calls.push({ method: "loadAll", args: [], returnValue: result });
			return result;
		},
		async loadIndex(): Promise<WorkflowIndexEntry[]> {
			const result = Array.from(workflows.values()).map((w) => ({
				id: w.id,
				branch: w.worktreeBranch,
				status: w.status,
				summary: w.summary,
				epicId: w.epicId,
				createdAt: w.createdAt,
				updatedAt: w.updatedAt,
			}));
			tracker.calls.push({
				method: "loadIndex",
				args: [],
				returnValue: result,
			});
			return result;
		},
		async remove(id: string): Promise<void> {
			tracker.calls.push({ method: "remove", args: [id] });
			workflows.delete(id);
		},
		async removeAll(): Promise<void> {
			tracker.calls.push({ method: "removeAll", args: [] });
			workflows.clear();
		},
		async waitForPendingWrites(): Promise<void> {
			tracker.calls.push({ method: "waitForPendingWrites", args: [] });
		},
	};

	return {
		mock,
		tracker,
		seedWorkflow(workflow: Workflow): void {
			workflows.set(workflow.id, workflow);
		},
	};
}

// ── Mock Epic Store ──────────────────────────────────────

export interface MockEpicStore {
	mock: {
		loadAll(): Promise<PersistedEpic[]>;
		save(epic: PersistedEpic): Promise<void>;
		removeAll(): Promise<void>;
	};
	tracker: CallTracker;
}

/** Create a mock epic store backed by an in-memory array */
export function createMockEpicStore(): MockEpicStore {
	const tracker = createCallTracker();
	const epics: PersistedEpic[] = [];

	const mock = {
		async loadAll(): Promise<PersistedEpic[]> {
			tracker.calls.push({
				method: "loadAll",
				args: [],
				returnValue: [...epics],
			});
			return [...epics];
		},
		async save(epic: PersistedEpic): Promise<void> {
			tracker.calls.push({ method: "save", args: [epic] });
			const idx = epics.findIndex((e) => e.epicId === epic.epicId);
			if (idx >= 0) {
				epics[idx] = epic;
			} else {
				epics.push(epic);
			}
		},
		async removeAll(): Promise<void> {
			tracker.calls.push({ method: "removeAll", args: [] });
			epics.length = 0;
		},
	};

	return { mock, tracker };
}

// ── Mock Config Store ────────────────────────────────────

export interface MockConfigStore {
	mock: {
		get(): AppConfig;
		save(partial: Partial<AppConfig>): {
			errors: ConfigValidationError[];
			warnings: ConfigWarning[];
		};
		reset(key?: string): void;
	};
	tracker: CallTracker;
}

/**
 * Create a mock config store returning DEFAULT_CONFIG by default.
 * Note: save() always returns empty errors/warnings — it does not replicate the real
 * ConfigStore's validation logic. Tests that need to verify validation-rejection behavior
 * should test against the real ConfigStore or extend this mock with configureValidationErrors().
 */
export function createMockConfigStore(): MockConfigStore {
	const tracker = createCallTracker();
	let current: AppConfig = structuredClone(DEFAULT_CONFIG);

	const mock = {
		get(): AppConfig {
			tracker.calls.push({
				method: "get",
				args: [],
				returnValue: current,
			});
			return structuredClone(current);
		},
		save(partial: Partial<AppConfig>): {
			errors: ConfigValidationError[];
			warnings: ConfigWarning[];
		} {
			tracker.calls.push({ method: "save", args: [partial] });
			// Deep merge: shallow-merge any nested plain objects, assign primitives
			const cur = current as unknown as Record<string, unknown>;
			for (const [key, value] of Object.entries(partial)) {
				if (
					value !== undefined &&
					typeof value === "object" &&
					value !== null &&
					!Array.isArray(value)
				) {
					cur[key] = {
						...(cur[key] as Record<string, unknown>),
						...(value as unknown as Record<string, unknown>),
					};
				} else if (value !== undefined) {
					cur[key] = value;
				}
			}
			return { errors: [], warnings: [] };
		},
		reset(key?: string): void {
			tracker.calls.push({ method: "reset", args: [key] });
			if (key) {
				(current as unknown as Record<string, unknown>)[key] = structuredClone(
					(DEFAULT_CONFIG as unknown as Record<string, unknown>)[key],
				);
			} else {
				current = structuredClone(DEFAULT_CONFIG);
			}
		},
	};

	return { mock, tracker };
}
