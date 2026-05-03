// ── Question decomposer ──────────────────────────────────
//
// Drives the `decompose` pipeline step for an ask-question workflow:
// builds the agent prompt from the configured template, validates the
// JSON manifest the agent writes to `.litus/decomposition.json`, and
// caps the resulting list at `config.limits.askQuestionMaxAspects`.
//
// The actual CLI dispatch and persistence are owned by the orchestrator;
// this module exposes pure functions so they're trivially unit-testable.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AspectManifest, AspectManifestEntry, AspectState } from "./types";

/** Sentinel relative path the decomposition agent writes the manifest to. */
export const DECOMPOSITION_FILE_REL = ".litus/decomposition.json";

/** Default file name for the synthesized answer (per contract). */
export const DEFAULT_ANSWER_FILE_NAME = "answer.md";

/**
 * Substitute `${name}` tokens in the configured prompt template. Tokens not
 * listed in `bindings` are left untouched (matches the existing template
 * substitution behavior used elsewhere in the orchestrator).
 */
export function buildDecompositionPrompt(
	template: string,
	bindings: { question: string; maxAspects: number; decompositionFile: string },
): string {
	return template
		.replaceAll("${question}", bindings.question)
		.replaceAll("${maxAspects}", String(bindings.maxAspects))
		.replaceAll("${decompositionFile}", bindings.decompositionFile);
}

export type DecomposeManifestResult =
	| { kind: "ok"; manifest: AspectManifest; cappedFrom: number | null }
	| { kind: "error"; message: string };

/** Filename safety: must end in `.md`, no path separators, ASCII slug. */
const FILE_NAME_RE = /^[a-z0-9][a-z0-9._-]*\.md$/i;
/** ID format: any non-empty alphanumeric / dash / underscore string. */
const ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate the parsed manifest object and apply the configured aspect cap.
 * Returns either a valid `AspectManifest` (with the original count if the
 * input was capped) or a typed error message naming the rule violation.
 *
 * `maxAspects` MUST be ≥ 1 (the ConfigStore enforces `min: 1`).
 */
export function validateAspectManifest(
	parsed: unknown,
	maxAspects: number,
): DecomposeManifestResult {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { kind: "error", message: "Aspect manifest must be a JSON object." };
	}
	const obj = parsed as Record<string, unknown>;
	if (obj.version !== 1) {
		return {
			kind: "error",
			message: `Aspect manifest validation failed: unsupported version ${JSON.stringify(obj.version)} (expected 1).`,
		};
	}
	if (!Array.isArray(obj.aspects)) {
		return {
			kind: "error",
			message: "Aspect manifest validation failed: `aspects` must be an array.",
		};
	}
	if (obj.aspects.length === 0) {
		return { kind: "error", message: "Aspect manifest is empty (zero aspects)." };
	}

	const seenIds = new Set<string>();
	const seenFileNames = new Set<string>();
	const entries: AspectManifestEntry[] = [];

	for (let i = 0; i < obj.aspects.length; i++) {
		const a = obj.aspects[i];
		if (typeof a !== "object" || a === null) {
			return {
				kind: "error",
				message: `Aspect manifest validation failed: aspects[${i}] is not an object.`,
			};
		}
		const item = a as Record<string, unknown>;
		const id = typeof item.id === "string" ? item.id.trim() : "";
		const title = typeof item.title === "string" ? item.title.trim() : "";
		const researchPrompt =
			typeof item.researchPrompt === "string" ? item.researchPrompt.trim() : "";
		const fileName = typeof item.fileName === "string" ? item.fileName.trim() : "";

		if (!id) {
			return {
				kind: "error",
				message: `Aspect manifest validation failed: aspects[${i}].id is missing or empty.`,
			};
		}
		if (!ID_RE.test(id)) {
			return {
				kind: "error",
				message: `Aspect manifest validation failed: aspects[${i}].id ${JSON.stringify(id)} is not a valid identifier.`,
			};
		}
		if (seenIds.has(id)) {
			return {
				kind: "error",
				message: `Aspect manifest validation failed: aspects[${i}].id ${JSON.stringify(id)} duplicates a prior entry.`,
			};
		}
		if (!title) {
			return {
				kind: "error",
				message: `Aspect manifest validation failed: aspects[${i}].title is missing or empty.`,
			};
		}
		if (!researchPrompt) {
			return {
				kind: "error",
				message: `Aspect manifest validation failed: aspects[${i}].researchPrompt is missing or empty.`,
			};
		}
		if (!fileName) {
			return {
				kind: "error",
				message: `Aspect manifest validation failed: aspects[${i}].fileName is missing or empty.`,
			};
		}
		if (!FILE_NAME_RE.test(fileName)) {
			return {
				kind: "error",
				message: `Aspect manifest validation failed: aspects[${i}].fileName ${JSON.stringify(fileName)} is not a valid slug.md file name.`,
			};
		}
		if (fileName.toLowerCase() === DEFAULT_ANSWER_FILE_NAME.toLowerCase()) {
			// `answer.md` is reserved for the synthesizer's output; an aspect
			// using it would be silently overwritten when synthesize runs.
			return {
				kind: "error",
				message: `Aspect manifest validation failed: aspects[${i}].fileName ${JSON.stringify(fileName)} is reserved for the synthesized answer.`,
			};
		}
		if (seenFileNames.has(fileName.toLowerCase())) {
			return {
				kind: "error",
				message: `Aspect manifest validation failed: aspects[${i}].fileName ${JSON.stringify(fileName)} duplicates a prior entry.`,
			};
		}
		seenIds.add(id);
		seenFileNames.add(fileName.toLowerCase());
		entries.push({ id, title, researchPrompt, fileName });
	}

	const original = entries.length;
	const cappedFrom = original > maxAspects ? original : null;
	const finalAspects = cappedFrom !== null ? entries.slice(0, maxAspects) : entries;

	return {
		kind: "ok",
		manifest: { version: 1, aspects: finalAspects },
		cappedFrom,
	};
}

/**
 * Read and validate the manifest file from the workflow's worktree.
 * Resolves a {kind:"error"} on any IO/parse failure and {kind:"ok"} on a
 * valid manifest. Caller is responsible for the cap-notice system message
 * (it has access to the step output channel).
 */
export function readAndValidateDecompositionFile(
	worktreePath: string,
	maxAspects: number,
): DecomposeManifestResult {
	const filePath = join(worktreePath, DECOMPOSITION_FILE_REL);
	if (!existsSync(filePath)) {
		return {
			kind: "error",
			message: `Decomposition agent did not write \`${DECOMPOSITION_FILE_REL}\`.`,
		};
	}
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch (err) {
		return {
			kind: "error",
			message: `Aspect manifest could not be read: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return {
			kind: "error",
			message: `Aspect manifest could not be parsed as JSON: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	return validateAspectManifest(parsed, maxAspects);
}

/**
 * Build the initial `AspectState[]` array for a freshly-decomposed workflow.
 * Mirrors `manifest.aspects` order one-to-one; every aspect starts pending.
 */
export function buildInitialAspectStates(manifest: AspectManifest): AspectState[] {
	return manifest.aspects.map((a) => ({
		id: a.id,
		fileName: a.fileName,
		status: "pending",
		sessionId: null,
		startedAt: null,
		completedAt: null,
		errorMessage: null,
	}));
}
