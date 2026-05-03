// ── Answer synthesizer ───────────────────────────────────
//
// Pure helpers for the `synthesize` step (initial run + feedback iteration).
// Builds the synthesis prompt and reads the produced `answer.md` back into
// `workflow.synthesizedAnswer`. CLI dispatch and persistence are owned by
// the orchestrator.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SynthesizedAnswer } from "./types";

/**
 * Fixed feedback preamble prepended to the user-configurable synthesis
 * template when the orchestrator runs a feedback iteration. Encodes the
 * contract that the answer file must be edited in place rather than
 * rewritten from scratch — explicitly NOT user-configurable.
 */
export function buildFeedbackPreamble(previousAnswer: string, feedback: string): string {
	return [
		"The user has reviewed your previous answer and provided feedback.",
		"Apply the feedback by editing the answer file in place; you may also edit",
		"the per-aspect research files in `<worktreePath>` if doing so produces a",
		"better final answer.",
		"",
		"PREVIOUS ANSWER:",
		previousAnswer,
		"",
		"USER FEEDBACK:",
		feedback,
		"",
		"---",
		"",
	].join("\n");
}

/**
 * Substitute the synthesis template's `${name}` tokens.
 */
export function buildSynthesisPrompt(
	template: string,
	bindings: { question: string; aspectFindings: string; answerFileName: string },
): string {
	return template
		.replaceAll("${question}", bindings.question)
		.replaceAll("${aspectFindings}", bindings.aspectFindings)
		.replaceAll("${answerFileName}", bindings.answerFileName);
}

export type SynthesisReadResult =
	| { kind: "ok"; answer: SynthesizedAnswer }
	| { kind: "missing" }
	| { kind: "empty" };

/**
 * Read the synthesized answer file from the worktree and build the
 * `SynthesizedAnswer` payload mirrored onto the workflow record.
 * Empty content → `"empty"` (the synthesize step transitions to error).
 */
export function readSynthesizedAnswer(
	worktreePath: string,
	answerFileName: string,
): SynthesisReadResult {
	const abs = join(worktreePath, answerFileName);
	if (!existsSync(abs)) return { kind: "missing" };
	let body = "";
	try {
		body = readFileSync(abs, "utf-8");
	} catch {
		return { kind: "missing" };
	}
	if (body.trim() === "") return { kind: "empty" };
	return {
		kind: "ok",
		answer: {
			markdown: body,
			updatedAt: new Date().toISOString(),
			sourceFileName: answerFileName,
		},
	};
}
