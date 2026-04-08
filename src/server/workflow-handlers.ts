import { toErrorMessage } from "../errors";
import { validateTargetRepository } from "../target-repo-validator";
import type { ClientMessage } from "../types";
import type { MessageHandler } from "./handler-types";
import { withOrchestrator } from "./handler-types";

export const handleStart: MessageHandler = async (ws, data, deps) => {
	const msg = data as ClientMessage & { type: "workflow:start" };
	const { specification, targetRepository } = msg;

	if (!specification.trim()) {
		deps.sendTo(ws, { type: "error", message: "Specification must be non-empty" });
		return;
	}
	if (specification.length > 100_000) {
		deps.sendTo(ws, { type: "error", message: "Specification exceeds maximum length (100 KB)" });
		return;
	}

	const validation = await validateTargetRepository(targetRepository);
	if (!validation.valid) {
		deps.sendTo(ws, { type: "error", message: validation.error ?? "Invalid target repository" });
		return;
	}

	try {
		const orch = deps.createOrchestrator();
		const workflow = await orch.startPipeline(specification.trim(), validation.effectivePath);
		deps.orchestrators.set(workflow.id, orch);

		const state = deps.stripInternalFields(workflow);
		deps.broadcast({ type: "workflow:created", workflow: state });
	} catch (err) {
		const message = toErrorMessage(err);
		deps.sendTo(ws, { type: "error", message });
	}
};

export const handleAnswer: MessageHandler = withOrchestrator((ws, data, deps, orch) => {
	const msg = data as ClientMessage & { type: "workflow:answer" };
	const { workflowId, questionId, answer } = msg;

	if (!answer.trim()) {
		deps.sendTo(ws, { type: "error", message: "Answer must be non-empty" });
		return;
	}
	if (answer.length > 100_000) {
		deps.sendTo(ws, { type: "error", message: "Answer exceeds maximum length (100 KB)" });
		return;
	}

	const workflow = orch.getEngine().getWorkflow();
	if (!workflow?.pendingQuestion || workflow.pendingQuestion.id !== questionId) {
		deps.sendTo(ws, { type: "error", message: "Question not found or already answered" });
		return;
	}

	orch.answerQuestion(workflowId, questionId, answer.trim());
});

export const handleSkip: MessageHandler = withOrchestrator((ws, data, deps, orch) => {
	const msg = data as ClientMessage & { type: "workflow:skip" };
	const { workflowId, questionId } = msg;

	const workflow = orch.getEngine().getWorkflow();
	if (!workflow?.pendingQuestion || workflow.pendingQuestion.id !== questionId) {
		deps.sendTo(ws, { type: "error", message: "Question not found or already answered" });
		return;
	}

	orch.skipQuestion(workflowId, questionId);
});

export const handlePause: MessageHandler = withOrchestrator((_ws, data, _deps, orch) => {
	const msg = data as ClientMessage & { type: "workflow:pause" };
	const workflow = orch.getEngine().getWorkflow();
	if (!workflow || workflow.status !== "running") return;
	orch.pause(msg.workflowId);
});

export const handleResume: MessageHandler = withOrchestrator((_ws, data, _deps, orch) => {
	const msg = data as ClientMessage & { type: "workflow:resume" };
	const workflow = orch.getEngine().getWorkflow();
	if (!workflow || workflow.status !== "paused") return;
	orch.resume(msg.workflowId);
});

export const handleAbort: MessageHandler = withOrchestrator((_ws, data, deps, orch) => {
	const msg = data as ClientMessage & { type: "workflow:abort" };
	const { workflowId } = msg;
	const workflow = orch.getEngine().getWorkflow();
	if (!workflow) return;

	if (
		workflow.status !== "paused" &&
		workflow.status !== "waiting_for_input" &&
		workflow.status !== "waiting_for_dependencies"
	) {
		return;
	}

	orch.cancelPipeline(workflowId);
	deps.orchestrators.delete(workflowId);
});

export const handleRetry: MessageHandler = withOrchestrator((ws, data, deps, orch) => {
	const msg = data as ClientMessage & { type: "workflow:retry" };
	const workflow = orch.getEngine().getWorkflow();
	if (!workflow || workflow.status !== "error") {
		deps.sendTo(ws, { type: "error", message: "No failed step to retry" });
		return;
	}
	orch.retryStep(msg.workflowId);
});

export const handleStartExisting: MessageHandler = withOrchestrator((ws, data, deps, orch) => {
	const msg = data as ClientMessage & { type: "workflow:start-existing" };
	const workflow = orch.getEngine().getWorkflow();
	if (!workflow || workflow.status !== "idle") {
		deps.sendTo(ws, { type: "error", message: "Workflow is not idle" });
		return;
	}

	try {
		orch.startPipelineFromWorkflow(workflow);
	} catch (err) {
		deps.sendTo(ws, { type: "error", message: `Failed to start workflow: ${err}` });
		return;
	}
	deps.broadcastWorkflowState(msg.workflowId);
});

export const handleForceStart: MessageHandler = withOrchestrator((ws, data, deps, orch) => {
	const msg = data as ClientMessage & { type: "workflow:force-start" };
	const { workflowId } = msg;
	const workflow = orch.getEngine().getWorkflow();
	if (!workflow || workflow.status !== "waiting_for_dependencies") {
		deps.sendTo(ws, { type: "error", message: "Workflow is not waiting for dependencies" });
		return;
	}

	workflow.epicDependencyStatus = "overridden";
	workflow.updatedAt = new Date().toISOString();

	try {
		orch.startPipelineFromWorkflow(workflow);
	} catch (err) {
		workflow.epicDependencyStatus = "waiting";
		deps.sendTo(ws, { type: "error", message: `Failed to force-start workflow: ${err}` });
		return;
	}
	deps.broadcastWorkflowState(workflowId);
});
