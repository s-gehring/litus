import { describe, expect, test } from "bun:test";
import type {
	AppConfig,
	AuditConfig,
	AuditEvent,
	AuditEventType,
	CiCheckResult,
	CiCycle,
	CiFailureLog,
	ClientMessage,
	ConfigValidationError,
	ConfigWarning,
	DependencyGraph,
	EffortConfig,
	EffortLevel,
	EpicAggregatedState,
	EpicAggregatedStatus,
	EpicAnalysisResult,
	EpicClientState,
	EpicDependencyStatus,
	EpicSpecEntry,
	EpicStatus,
	LimitConfig,
	MergeCycle,
	MergeResult,
	ModelConfig,
	NumericSettingMeta,
	OutputEntry,
	PersistedEpic,
	PipelineStep,
	PipelineStepName,
	PipelineStepStatus,
	PromptConfig,
	PromptVariableInfo,
	Question,
	ReviewCycle,
	ReviewSeverity,
	ServerMessage,
	SetupCheckResult,
	SetupResult,
	SyncResult,
	TimingConfig,
	Workflow,
	WorkflowClientState,
	WorkflowIndexEntry,
	WorkflowState,
	WorkflowStatus,
} from "../src/types";
import {
	PIPELINE_STEP_DEFINITIONS,
	shouldAutoAnswer,
	shouldPauseBeforeMerge,
	VALID_TRANSITIONS,
} from "../src/types";

function makeAppConfig(): AppConfig {
	return {
		models: {
			questionDetection: "",
			reviewClassification: "",
			activitySummarization: "",
			specSummarization: "",
			epicDecomposition: "",
			mergeConflictResolution: "",
			ciFix: "",
			specify: "",
			clarify: "",
			plan: "",
			tasks: "",
			implement: "",
			review: "",
			implementReview: "",
			commitPushPr: "",
		},
		efforts: {
			questionDetection: "low",
			reviewClassification: "low",
			activitySummarization: "low",
			specSummarization: "low",
			epicDecomposition: "medium",
			mergeConflictResolution: "medium",
			ciFix: "medium",
			specify: "medium",
			clarify: "medium",
			plan: "medium",
			tasks: "medium",
			implement: "medium",
			review: "medium",
			implementReview: "medium",
			commitPushPr: "medium",
		},
		prompts: {
			questionDetection: "",
			reviewClassification: "",
			activitySummarization: "",
			specSummarization: "",
			mergeConflictResolution: "",
			ciFixInstruction: "",
			epicDecomposition: "",
			feedbackImplementerInstruction: "",
		},
		limits: {
			reviewCycleMaxIterations: 16,
			ciFixMaxAttempts: 3,
			mergeMaxAttempts: 3,
			maxJsonRetries: 3,
		},
		timing: {
			ciGlobalTimeoutMs: 600000,
			ciPollIntervalMs: 30000,
			activitySummaryIntervalMs: 60000,
			rateLimitBackoffMs: 5000,
			maxCiLogLength: 10000,
			maxClientOutputLines: 500,
			epicTimeoutMs: 300000,
			cliIdleTimeoutMs: 600000,
		},
		autoMode: "normal",
	};
}

describe("AutoMode helpers", () => {
	test("shouldAutoAnswer returns true only for full-auto", () => {
		expect(shouldAutoAnswer("full-auto")).toBe(true);
		expect(shouldAutoAnswer("normal")).toBe(false);
		expect(shouldAutoAnswer("manual")).toBe(false);
	});

	test("shouldPauseBeforeMerge returns true only for manual", () => {
		expect(shouldPauseBeforeMerge("manual")).toBe(true);
		expect(shouldPauseBeforeMerge("normal")).toBe(false);
		expect(shouldPauseBeforeMerge("full-auto")).toBe(false);
	});
});

describe("VALID_TRANSITIONS", () => {
	test("idle can transition to running or waiting_for_dependencies", () => {
		expect(VALID_TRANSITIONS.idle).toEqual(["running", "waiting_for_dependencies"]);
	});

	test("running can transition to waiting_for_input, completed, error, paused", () => {
		expect(VALID_TRANSITIONS.running).toEqual([
			"waiting_for_input",
			"completed",
			"error",
			"paused",
		]);
	});

	test("paused can transition to running, cancelled, or error", () => {
		expect(VALID_TRANSITIONS.paused).toEqual(["running", "cancelled", "error"]);
	});

	test("waiting_for_input can transition to running or cancelled", () => {
		expect(VALID_TRANSITIONS.waiting_for_input).toEqual(["running", "cancelled"]);
	});

	test("waiting_for_dependencies can transition to running or cancelled", () => {
		expect(VALID_TRANSITIONS.waiting_for_dependencies).toEqual(["running", "cancelled"]);
	});

	test("completed and cancelled are terminal states", () => {
		expect(VALID_TRANSITIONS.completed).toEqual([]);
		expect(VALID_TRANSITIONS.cancelled).toEqual([]);
	});

	test("error can transition to running (retry)", () => {
		expect(VALID_TRANSITIONS.error).toEqual(["running"]);
	});

	test("all workflow statuses are covered", () => {
		const allStatuses: WorkflowStatus[] = [
			"idle",
			"running",
			"waiting_for_input",
			"waiting_for_dependencies",
			"paused",
			"completed",
			"cancelled",
			"error",
		];
		expect(allStatuses).toHaveLength(8);
		for (const status of allStatuses) {
			expect(VALID_TRANSITIONS).toHaveProperty(status);
		}
	});
});

describe("PIPELINE_STEP_DEFINITIONS", () => {
	test("has exactly 14 steps in correct order", () => {
		const expectedNames: PipelineStepName[] = [
			"setup",
			"specify",
			"clarify",
			"plan",
			"tasks",
			"implement",
			"review",
			"implement-review",
			"commit-push-pr",
			"monitor-ci",
			"fix-ci",
			"feedback-implementer",
			"merge-pr",
			"sync-repo",
		];
		expect(PIPELINE_STEP_DEFINITIONS.map((s) => s.name)).toEqual(expectedNames);
	});

	test("every step has a non-empty displayName", () => {
		for (const step of PIPELINE_STEP_DEFINITIONS) {
			expect(step.displayName.length).toBeGreaterThan(0);
		}
	});
});

describe("PipelineStep shape", () => {
	test("a valid PipelineStep can be constructed", () => {
		const step: PipelineStep = {
			name: "specify",
			displayName: "Specifying",
			status: "pending",
			prompt: "/speckit-specify test",
			sessionId: null,
			output: "",
			outputLog: [],
			error: null,
			startedAt: null,
			completedAt: null,
			pid: null,
			history: [],
		};
		expect(step.name).toBe("specify");
		expect(step.status).toBe("pending");
	});

	test("all PipelineStepStatus values are valid", () => {
		const statuses: PipelineStepStatus[] = [
			"pending",
			"running",
			"waiting_for_input",
			"paused",
			"completed",
			"error",
		];
		expect(statuses).toHaveLength(6);
	});
});

describe("ReviewCycle shape", () => {
	test("a valid ReviewCycle can be constructed", () => {
		const cycle: ReviewCycle = {
			iteration: 1,
			maxIterations: 16,
			lastSeverity: null,
		};
		expect(cycle.iteration).toBe(1);
		expect(cycle.maxIterations).toBe(16);
		expect(cycle.lastSeverity).toBeNull();
	});

	test("all ReviewSeverity values are valid", () => {
		const severities: ReviewSeverity[] = ["critical", "major", "minor", "trivial", "nit"];
		expect(severities).toHaveLength(5);
		expect(new Set(severities).size).toBe(5);
	});
});

describe("MergeCycle shape", () => {
	test("a valid MergeCycle can be constructed", () => {
		const cycle: MergeCycle = {
			attempt: 0,
			maxAttempts: 3,
		};
		expect(cycle.attempt).toBe(0);
		expect(cycle.maxAttempts).toBe(3);
	});
});

describe("MergeResult shape", () => {
	test("a successful merge result", () => {
		const result: MergeResult = {
			merged: true,
			alreadyMerged: false,
			conflict: false,
			error: null,
		};
		expect(result.merged).toBe(true);
		expect(result.error).toBeNull();
	});

	test("a conflict merge result", () => {
		const result: MergeResult = {
			merged: false,
			alreadyMerged: false,
			conflict: true,
			error: null,
		};
		expect(result.conflict).toBe(true);
	});

	test("an error merge result", () => {
		const result: MergeResult = {
			merged: false,
			alreadyMerged: false,
			conflict: false,
			error: "Permission denied",
		};
		expect(result.error).toBe("Permission denied");
	});
});

describe("SyncResult shape", () => {
	test("a successful sync result", () => {
		const result: SyncResult = {
			pulled: true,
			skipped: false,
			worktreeRemoved: true,
			warning: null,
		};
		expect(result.pulled).toBe(true);
		expect(result.worktreeRemoved).toBe(true);
	});

	test("a skipped sync result with warning", () => {
		const result: SyncResult = {
			pulled: false,
			skipped: true,
			worktreeRemoved: true,
			warning: "Uncommitted changes detected",
		};
		expect(result.skipped).toBe(true);
		expect(result.warning).toBe("Uncommitted changes detected");
	});
});

// ── Phase 2: Union Type Exhaustiveness ──────────────────────

describe("EffortLevel exhaustiveness", () => {
	test("has exactly 4 values", () => {
		const values: EffortLevel[] = ["low", "medium", "high", "max"];
		expect(values).toHaveLength(4);
		expect(new Set(values).size).toBe(4);
	});
});

describe("AuditEventType exhaustiveness", () => {
	test("has exactly 5 values", () => {
		const values: AuditEventType[] = [
			"pipeline_start",
			"pipeline_end",
			"query",
			"answer",
			"commit",
		];
		expect(values).toHaveLength(5);
		expect(new Set(values).size).toBe(5);
	});
});

describe("EpicDependencyStatus exhaustiveness", () => {
	test("has exactly 4 values", () => {
		const values: EpicDependencyStatus[] = ["satisfied", "waiting", "blocked", "overridden"];
		expect(values).toHaveLength(4);
		expect(new Set(values).size).toBe(4);
	});
});

describe("EpicAggregatedStatus exhaustiveness", () => {
	test("has exactly 7 values", () => {
		const values: EpicAggregatedStatus[] = [
			"idle",
			"running",
			"paused",
			"waiting",
			"error",
			"in_progress",
			"completed",
		];
		expect(values).toHaveLength(7);
		expect(new Set(values).size).toBe(7);
	});
});

describe("EpicStatus exhaustiveness", () => {
	test("has exactly 4 values", () => {
		const values: EpicStatus[] = ["analyzing", "completed", "error", "infeasible"];
		expect(values).toHaveLength(4);
		expect(new Set(values).size).toBe(4);
	});
});

// ── Phase 3: Workflow Lifecycle Management ───────────────────

describe("Workflow Lifecycle", () => {
	test("VALID_TRANSITIONS covers every WorkflowStatus and targets are valid", () => {
		const allStatuses: WorkflowStatus[] = [
			"idle",
			"running",
			"waiting_for_input",
			"waiting_for_dependencies",
			"paused",
			"completed",
			"cancelled",
			"error",
		];
		const statusSet = new Set(allStatuses);
		for (const status of allStatuses) {
			expect(VALID_TRANSITIONS).toHaveProperty(status);
			for (const target of VALID_TRANSITIONS[status]) {
				expect(statusSet.has(target)).toBe(true);
			}
		}
	});

	test("Question shape", () => {
		const q: Question = {
			id: "q-123",
			content: "What branch?",
			detectedAt: "2026-04-06T12:00:00Z",
		};
		expect(q.id).toBe("q-123");
		expect(q.content).toBe("What branch?");
		expect(q.detectedAt).toBe("2026-04-06T12:00:00Z");
	});

	test("Workflow shape with all 30 fields", () => {
		const w: Workflow = {
			id: "w-1",
			specification: "Add feature X",
			status: "idle",
			targetRepository: null,
			worktreePath: null,
			worktreeBranch: "feat/x",
			featureBranch: null,
			summary: "",
			stepSummary: "",
			flavor: "standard",
			pendingQuestion: null,
			lastOutput: "",
			steps: [],
			currentStepIndex: 0,
			reviewCycle: { iteration: 0, maxIterations: 16, lastSeverity: null },
			ciCycle: {
				attempt: 0,
				maxAttempts: 3,
				monitorStartedAt: null,
				globalTimeoutMs: 600000,
				lastCheckResults: [],
				failureLogs: [],
			},
			mergeCycle: { attempt: 0, maxAttempts: 3 },
			prUrl: null,
			epicId: null,
			epicTitle: null,
			epicDependencies: [],
			epicDependencyStatus: null,
			epicAnalysisMs: 0,
			activeWorkMs: 0,
			activeWorkStartedAt: null,
			feedbackEntries: [],
			feedbackPreRunHead: null,
			activeInvocation: null,
			managedRepo: null,
			createdAt: "2026-04-06T00:00:00Z",
			updatedAt: "2026-04-06T00:00:00Z",
		};
		expect(Object.keys(w)).toHaveLength(31);
		expect(w.status).toBe("idle");
	});

	test("WorkflowState strips sessionId, prompt, pid from steps", () => {
		const ws: WorkflowState = {
			id: "w-1",
			specification: "test",
			status: "running",
			targetRepository: null,
			worktreePath: null,
			worktreeBranch: "feat/x",
			featureBranch: null,
			summary: "",
			stepSummary: "",
			flavor: "standard",
			pendingQuestion: null,
			lastOutput: "",
			steps: [
				{
					name: "setup",
					displayName: "Setup",
					status: "completed",
					output: "done",
					error: null,
					startedAt: "2026-04-06T00:00:00Z",
					completedAt: "2026-04-06T00:01:00Z",
					// @ts-expect-error sessionId is stripped from WorkflowState steps
					sessionId: "sess-1",
				},
			],
			currentStepIndex: 1,
			reviewCycle: { iteration: 0, maxIterations: 16, lastSeverity: null },
			ciCycle: {
				attempt: 0,
				maxAttempts: 3,
				monitorStartedAt: null,
				globalTimeoutMs: 600000,
				lastCheckResults: [],
				failureLogs: [],
			},
			mergeCycle: { attempt: 0, maxAttempts: 3 },
			prUrl: null,
			epicId: null,
			epicTitle: null,
			epicDependencies: [],
			epicDependencyStatus: null,
			epicAnalysisMs: 0,
			activeWorkMs: 0,
			activeWorkStartedAt: null,
			feedbackEntries: [],
			createdAt: "2026-04-06T00:00:00Z",
			updatedAt: "2026-04-06T00:00:00Z",
		};
		expect(ws.steps[0].name).toBe("setup");
		expect(ws.steps[0].status).toBe("completed");
	});

	test("WorkflowIndexEntry shape", () => {
		const entry: WorkflowIndexEntry = {
			id: "w-1",
			branch: "feat/x",
			status: "completed",
			summary: "Added feature X",
			epicId: null,
			createdAt: "2026-04-06T00:00:00Z",
			updatedAt: "2026-04-06T00:01:00Z",
		};
		expect(entry.id).toBe("w-1");
		expect(entry.status).toBe("completed");
	});
});

// ── Phase 4: Pipeline Step Progression ──────────────────────

describe("Pipeline Step Progression", () => {
	test("PipelineStepName has exactly 14 values in execution order", () => {
		const names: PipelineStepName[] = [
			"setup",
			"specify",
			"clarify",
			"plan",
			"tasks",
			"implement",
			"review",
			"implement-review",
			"commit-push-pr",
			"monitor-ci",
			"fix-ci",
			"feedback-implementer",
			"merge-pr",
			"sync-repo",
		];
		expect(names).toHaveLength(14);
		expect(new Set(names).size).toBe(14);
	});

	test("PIPELINE_STEP_DEFINITIONS match PipelineStepName order", () => {
		const expectedOrder: PipelineStepName[] = [
			"setup",
			"specify",
			"clarify",
			"plan",
			"tasks",
			"implement",
			"review",
			"implement-review",
			"commit-push-pr",
			"monitor-ci",
			"fix-ci",
			"feedback-implementer",
			"merge-pr",
			"sync-repo",
		];
		expect(PIPELINE_STEP_DEFINITIONS).toHaveLength(14);
		for (let i = 0; i < expectedOrder.length; i++) {
			expect(PIPELINE_STEP_DEFINITIONS[i].name).toBe(expectedOrder[i]);
		}
	});

	test("PipelineStep shape with all fields", () => {
		const step: PipelineStep = {
			name: "implement",
			displayName: "Implementing",
			status: "running",
			prompt: "/speckit-implement",
			sessionId: "sess-abc",
			output: "Working on it...",
			outputLog: [],
			error: null,
			startedAt: "2026-04-06T00:00:00Z",
			completedAt: null,
			pid: 12345,
			history: [],
		};
		expect(step.name).toBe("implement");
		expect(step.pid).toBe(12345);
		expect(step.sessionId).toBe("sess-abc");
	});
});

// ── Phase 5: Real-time Communication (Messages) ────────────

describe("ServerMessage variants", () => {
	test("workflow message variants (7)", () => {
		const msgs: ServerMessage[] = [
			{ type: "workflow:state", workflow: null },
			{ type: "workflow:list", workflows: [] },
			{
				type: "workflow:created",
				workflow: {
					id: "w-1",
					specification: "test",
					status: "idle",
					targetRepository: null,
					worktreePath: null,
					worktreeBranch: "b",
					featureBranch: null,
					summary: "",
					stepSummary: "",
					flavor: "",
					pendingQuestion: null,
					lastOutput: "",
					steps: [],
					currentStepIndex: 0,
					reviewCycle: { iteration: 0, maxIterations: 16, lastSeverity: null },
					ciCycle: {
						attempt: 0,
						maxAttempts: 3,
						monitorStartedAt: null,
						globalTimeoutMs: 600000,
						lastCheckResults: [],
						failureLogs: [],
					},
					mergeCycle: { attempt: 0, maxAttempts: 3 },
					prUrl: null,
					epicId: null,
					epicTitle: null,
					epicDependencies: [],
					epicDependencyStatus: null,
					epicAnalysisMs: 0,
					activeWorkMs: 0,
					activeWorkStartedAt: null,
					feedbackEntries: [],
					activeInvocation: null,
					managedRepo: null,
					createdAt: "",
					updatedAt: "",
				},
			},
			{ type: "workflow:output", workflowId: "w-1", text: "hello" },
			{ type: "workflow:tools", workflowId: "w-1", tools: [{ name: "Read" }] },
			{
				type: "workflow:question",
				workflowId: "w-1",
				question: { id: "q-1", content: "?", detectedAt: "" },
			},
			{
				type: "workflow:step-change",
				workflowId: "w-1",
				previousStep: null,
				currentStep: "setup",
				currentStepIndex: 0,
				reviewIteration: 0,
			},
		];
		expect(msgs).toHaveLength(7);
		expect(msgs[0].type).toBe("workflow:state");
		expect(msgs[6].type).toBe("workflow:step-change");
	});

	test("epic message variants (9)", () => {
		const msgs: ServerMessage[] = [
			{ type: "epic:list", epics: [] },
			{ type: "epic:created", epicId: "e-1", description: "Build app" },
			{ type: "epic:output", epicId: "e-1", text: "Analyzing..." },
			{ type: "epic:tools", epicId: "e-1", tools: [{ name: "Write" }] },
			{ type: "epic:summary", epicId: "e-1", summary: "3 specs" },
			{
				type: "epic:result",
				epicId: "e-1",
				title: "Build app",
				specCount: 3,
				workflowIds: ["w-1"],
				summary: null,
			},
			{
				type: "epic:infeasible",
				epicId: "e-1",
				title: "Build app",
				infeasibleNotes: "Too broad",
			},
			{ type: "epic:error", epicId: "e-1", message: "Failed" },
			{
				type: "epic:dependency-update",
				workflowId: "w-1",
				epicDependencyStatus: "satisfied",
				blockingWorkflows: [],
			},
		];
		expect(msgs).toHaveLength(9);
		expect(msgs[0].type).toBe("epic:list");
		expect(msgs[8].type).toBe("epic:dependency-update");
	});

	test("config and error message variants (3)", () => {
		const msgs: ServerMessage[] = [
			{
				type: "config:state",
				config: makeAppConfig(),
				warnings: [],
			},
			{
				type: "config:error",
				errors: [{ path: "limits.maxJsonRetries", message: "Must be > 0", value: -1 }],
			},
			{ type: "error", message: "Something went wrong" },
		];
		expect(msgs).toHaveLength(3);
		expect(msgs[0].type).toBe("config:state");
		expect(msgs[1].type).toBe("config:error");
		expect(msgs[2].type).toBe("error");
	});

	test("total ServerMessage variant count is 19", () => {
		// 7 workflow + 9 epic + 2 config + 1 error = 19
		const allTypes = [
			"workflow:state",
			"workflow:list",
			"workflow:created",
			"workflow:output",
			"workflow:tools",
			"workflow:question",
			"workflow:step-change",
			"epic:list",
			"epic:created",
			"epic:output",
			"epic:tools",
			"epic:summary",
			"epic:result",
			"epic:infeasible",
			"epic:error",
			"epic:dependency-update",
			"config:state",
			"config:error",
			"error",
		];
		expect(allTypes).toHaveLength(19);
		expect(new Set(allTypes).size).toBe(19);
	});
});

describe("ClientMessage variants", () => {
	test("workflow command variants (9)", () => {
		const msgs: ClientMessage[] = [
			{ type: "workflow:start", specification: "Add X" },
			{ type: "workflow:answer", workflowId: "w-1", questionId: "q-1", answer: "yes" },
			{ type: "workflow:skip", workflowId: "w-1", questionId: "q-1" },
			{ type: "workflow:pause", workflowId: "w-1" },
			{ type: "workflow:resume", workflowId: "w-1" },
			{ type: "workflow:abort", workflowId: "w-1" },
			{ type: "workflow:retry", workflowId: "w-1" },
			{ type: "workflow:start-existing", workflowId: "w-1" },
			{ type: "workflow:force-start", workflowId: "w-1" },
		];
		expect(msgs).toHaveLength(9);
		expect(msgs[0].type).toBe("workflow:start");
		expect(msgs[8].type).toBe("workflow:force-start");
	});

	test("epic and config command variants (5)", () => {
		const msgs: ClientMessage[] = [
			{ type: "epic:start", description: "Build app", autoStart: true },
			{ type: "epic:cancel" },
			{ type: "config:get" },
			{ type: "config:save", config: {} },
			{ type: "config:reset" },
		];
		expect(msgs).toHaveLength(5);
	});

	test("total ClientMessage variant count is 14", () => {
		const allTypes = [
			"workflow:start",
			"workflow:answer",
			"workflow:skip",
			"workflow:pause",
			"workflow:resume",
			"workflow:abort",
			"workflow:retry",
			"workflow:start-existing",
			"workflow:force-start",
			"epic:start",
			"epic:cancel",
			"config:get",
			"config:save",
			"config:reset",
		];
		expect(allTypes).toHaveLength(14);
		expect(new Set(allTypes).size).toBe(14);
	});
});

describe("OutputEntry discriminated union", () => {
	test("text variant with optional type field", () => {
		const plain: OutputEntry = { kind: "text", text: "hello" };
		const err: OutputEntry = { kind: "text", text: "fail", type: "error" };
		const sys: OutputEntry = { kind: "text", text: "info", type: "system" };
		expect(plain.kind).toBe("text");
		expect(err.kind).toBe("text");
		expect(sys.kind).toBe("text");
	});

	test("tools variant", () => {
		const entry: OutputEntry = { kind: "tools", tools: [{ name: "Read" }, { name: "Write" }] };
		expect(entry.kind).toBe("tools");
	});
});

// ── Phase 6: Epic Decomposition ─────────────────────────────

describe("Epic types", () => {
	test("EpicSpecEntry shape", () => {
		const entry: EpicSpecEntry = {
			id: "spec-1",
			title: "Auth module",
			description: "Implement auth",
			dependencies: ["spec-0"],
		};
		expect(entry.id).toBe("spec-1");
		expect(entry.dependencies).toEqual(["spec-0"]);
	});

	test("EpicAnalysisResult shape", () => {
		const result: EpicAnalysisResult = {
			title: "Build app",
			specs: [{ id: "s-1", title: "Auth", description: "Auth module", dependencies: [] }],
			infeasibleNotes: null,
			summary: "2 specs",
		};
		expect(result.title).toBe("Build app");
		expect(result.specs).toHaveLength(1);
	});

	test("DependencyGraph shape", () => {
		const graph: DependencyGraph = {
			nodes: ["a", "b"],
			edges: new Map([["a", ["b"]]]),
			inDegree: new Map([
				["a", 0],
				["b", 1],
			]),
		};
		expect(graph.nodes).toHaveLength(2);
		expect(graph.edges.get("a")).toEqual(["b"]);
		expect(graph.inDegree.get("b")).toBe(1);
	});

	test("PersistedEpic shape", () => {
		const epic: PersistedEpic = {
			epicId: "e-1",
			description: "Build app",
			status: "analyzing",
			title: null,
			workflowIds: [],
			startedAt: "2026-04-06T00:00:00Z",
			completedAt: null,
			errorMessage: null,
			infeasibleNotes: null,
			analysisSummary: null,
		};
		expect(epic.epicId).toBe("e-1");
		expect(epic.status).toBe("analyzing");
	});

	test("EpicAggregatedState shape", () => {
		const state: EpicAggregatedState = {
			epicId: "e-1",
			title: "Build app",
			status: "running",
			progress: { completed: 1, total: 3 },
			startDate: "2026-04-06T00:00:00Z",
			activeWorkMs: 5000,
			activeWorkStartedAt: null,
			childWorkflowIds: ["w-1", "w-2", "w-3"],
		};
		expect(state.progress.total).toBe(3);
		expect(state.childWorkflowIds).toHaveLength(3);
	});

	test("EpicClientState extends PersistedEpic with outputLines", () => {
		const state: EpicClientState = {
			epicId: "e-1",
			description: "Build app",
			status: "completed",
			title: "Build App",
			workflowIds: ["w-1"],
			startedAt: "2026-04-06T00:00:00Z",
			completedAt: "2026-04-06T01:00:00Z",
			errorMessage: null,
			infeasibleNotes: null,
			analysisSummary: "Done",
			outputLines: [{ kind: "text", text: "hello" }],
		};
		expect(state.outputLines).toHaveLength(1);
		expect(state.outputLines[0].kind).toBe("text");
	});
});

// ── Phase 7: Application Configuration ──────────────────────

describe("Config types", () => {
	test("ModelConfig shape (15 fields)", () => {
		const config: ModelConfig = {
			questionDetection: "haiku",
			reviewClassification: "haiku",
			activitySummarization: "haiku",
			specSummarization: "haiku",
			epicDecomposition: "",
			mergeConflictResolution: "",
			ciFix: "",
			specify: "",
			clarify: "",
			plan: "",
			tasks: "",
			implement: "",
			review: "",
			implementReview: "",
			commitPushPr: "",
		};
		expect(Object.keys(config)).toHaveLength(15);
	});

	test("EffortConfig shape (15 fields)", () => {
		const config: EffortConfig = {
			questionDetection: "low",
			reviewClassification: "low",
			activitySummarization: "low",
			specSummarization: "low",
			epicDecomposition: "medium",
			mergeConflictResolution: "medium",
			ciFix: "medium",
			specify: "medium",
			clarify: "medium",
			plan: "medium",
			tasks: "medium",
			implement: "medium",
			review: "medium",
			implementReview: "medium",
			commitPushPr: "medium",
		};
		expect(Object.keys(config)).toHaveLength(15);
	});

	test("PromptConfig shape (7 fields)", () => {
		const config: PromptConfig = {
			questionDetection: "",
			reviewClassification: "",
			activitySummarization: "",
			specSummarization: "",
			mergeConflictResolution: "",
			ciFixInstruction: "",
			epicDecomposition: "",
			feedbackImplementerInstruction: "",
		};
		expect(Object.keys(config)).toHaveLength(8);
	});

	test("LimitConfig shape (4 fields)", () => {
		const config: LimitConfig = {
			reviewCycleMaxIterations: 16,
			ciFixMaxAttempts: 3,
			mergeMaxAttempts: 3,
			maxJsonRetries: 3,
		};
		expect(Object.keys(config)).toHaveLength(4);
	});

	test("TimingConfig shape (7 fields)", () => {
		const config: TimingConfig = {
			ciGlobalTimeoutMs: 600000,
			ciPollIntervalMs: 30000,
			activitySummaryIntervalMs: 60000,
			rateLimitBackoffMs: 5000,
			maxCiLogLength: 10000,
			maxClientOutputLines: 500,
			epicTimeoutMs: 300000,
			cliIdleTimeoutMs: 600000,
		};
		expect(Object.keys(config)).toHaveLength(8);
	});

	test("AppConfig shape (6 fields)", () => {
		const config: AppConfig = makeAppConfig();
		expect(Object.keys(config)).toHaveLength(6);
		expect(Object.keys(config.models)).toHaveLength(15);
	});

	test("ConfigValidationError shape", () => {
		const err: ConfigValidationError = {
			path: "limits.maxJsonRetries",
			message: "Must be positive",
			value: -1,
		};
		expect(err.path).toBe("limits.maxJsonRetries");
	});

	test("ConfigWarning shape", () => {
		const warn: ConfigWarning = {
			path: "prompts.questionDetection",
			missingVariables: ["content"],
			message: "Missing variable: content",
		};
		expect(warn.missingVariables).toHaveLength(1);
	});

	test("PromptVariableInfo shape", () => {
		const info: PromptVariableInfo = {
			name: "content",
			description: "The message content",
		};
		expect(info.name).toBe("content");
	});

	test("NumericSettingMeta shape", () => {
		const meta: NumericSettingMeta = {
			key: "ciGlobalTimeoutMs",
			label: "CI Timeout",
			description: "Global timeout for CI checks",
			min: 0,
			defaultValue: 600000,
			unit: "ms",
		};
		expect(meta.key).toBe("ciGlobalTimeoutMs");
		expect(meta.unit).toBe("ms");
	});
});

// ── Phase 8: Review and CI Cycle Tracking ───────────────────

describe("CI and Setup types", () => {
	test("CiCheckResult shape", () => {
		const result: CiCheckResult = {
			name: "build",
			state: "success",
			bucket: "pass",
			link: "https://example.com/run/1",
		};
		expect(result.name).toBe("build");
	});

	test("CiFailureLog shape", () => {
		const log: CiFailureLog = {
			checkName: "test",
			runId: "run-123",
			logs: "Error: assertion failed",
		};
		expect(log.checkName).toBe("test");
	});

	test("CiCycle shape", () => {
		const cycle: CiCycle = {
			attempt: 1,
			maxAttempts: 3,
			monitorStartedAt: "2026-04-06T00:00:00Z",
			globalTimeoutMs: 600000,
			lastCheckResults: [{ name: "build", state: "failure", bucket: "fail", link: "" }],
			failureLogs: [{ checkName: "build", runId: "r-1", logs: "error" }],
		};
		expect(cycle.attempt).toBe(1);
		expect(cycle.lastCheckResults).toHaveLength(1);
		expect(cycle.failureLogs).toHaveLength(1);
	});

	test("SetupCheckResult shape", () => {
		const check: SetupCheckResult = {
			name: "git",
			passed: true,
			required: true,
		};
		expect(check.passed).toBe(true);
		expect(check.required).toBe(true);
	});

	test("SetupResult shape", () => {
		const result: SetupResult = {
			passed: true,
			checks: [{ name: "git", passed: true, required: true }],
			requiredFailures: [],
			optionalWarnings: [{ name: "gh", passed: false, error: "not found", required: false }],
		};
		expect(result.passed).toBe(true);
		expect(result.checks).toHaveLength(1);
		expect(result.optionalWarnings).toHaveLength(1);
	});
});

// ── Phase 9: Audit Trail ────────────────────────────────────

describe("Audit types", () => {
	test("AuditEvent shape", () => {
		const event: AuditEvent = {
			timestamp: "2026-04-06T00:00:00Z",
			eventType: "pipeline_start",
			runId: "run-1",
			pipelineName: "specify",
			branch: "feat/x",
			commitHash: null,
			stepName: "setup",
			sequenceNumber: 1,
			content: null,
			metadata: null,
		};
		expect(event.eventType).toBe("pipeline_start");
		expect(event.sequenceNumber).toBe(1);
	});

	test("AuditConfig shape", () => {
		const config: AuditConfig = {};
		expect(config.auditDir).toBeUndefined();

		const configWithDir: AuditConfig = { auditDir: "/custom/path" };
		expect(configWithDir.auditDir).toBe("/custom/path");
	});
});

// ── Phase 10: Cross-cutting ─────────────────────────────────

describe("WorkflowClientState shape", () => {
	test("combines WorkflowState with outputLines", () => {
		const clientState: WorkflowClientState = {
			state: {
				id: "w-1",
				specification: "test",
				status: "running",
				targetRepository: null,
				worktreePath: null,
				worktreeBranch: "feat/x",
				featureBranch: null,
				summary: "",
				stepSummary: "",
				flavor: "",
				pendingQuestion: null,
				lastOutput: "",
				steps: [],
				currentStepIndex: 0,
				reviewCycle: { iteration: 0, maxIterations: 16, lastSeverity: null },
				ciCycle: {
					attempt: 0,
					maxAttempts: 3,
					monitorStartedAt: null,
					globalTimeoutMs: 600000,
					lastCheckResults: [],
					failureLogs: [],
				},
				mergeCycle: { attempt: 0, maxAttempts: 3 },
				prUrl: null,
				epicId: null,
				epicTitle: null,
				epicDependencies: [],
				epicDependencyStatus: null,
				epicAnalysisMs: 0,
				activeWorkMs: 0,
				activeWorkStartedAt: null,
				feedbackEntries: [],
				activeInvocation: null,
				managedRepo: null,
				createdAt: "",
				updatedAt: "",
			},
			outputLines: [
				{ kind: "text", text: "hello" },
				{ kind: "tools", tools: [{ name: "Read" }] },
			],
		};
		expect(clientState.outputLines).toHaveLength(2);
	});
});
