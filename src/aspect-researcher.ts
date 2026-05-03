// ── Aspect researcher ────────────────────────────────────
//
// Pure helpers for the `research-aspect` step. The orchestrator owns the
// CLI dispatch and per-aspect state mutation; this module supplies the
// prompt builder, the next-aspect picker, and the recovery normalisation
// used by the restart-recovery path.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AspectManifestEntry, AspectState } from "./types";

/**
 * Substitute `${name}` tokens in the per-aspect research prompt template.
 * Tokens not in `bindings` are left untouched (matches the existing
 * literal-replacement convention).
 */
export function buildResearchPrompt(
	template: string,
	bindings: { aspectTitle: string; aspectResearchPrompt: string; aspectFileName: string },
): string {
	return template
		.replaceAll("${aspectTitle}", bindings.aspectTitle)
		.replaceAll("${aspectResearchPrompt}", bindings.aspectResearchPrompt)
		.replaceAll("${aspectFileName}", bindings.aspectFileName);
}

/**
 * Pick the next aspect to dispatch on entry to (or re-entry into) the
 * `research-aspect` loop. Returns the first aspect whose status is
 * `"pending"` in document order, or null if every aspect has been resolved.
 */
export function pickNextAspect(aspects: AspectState[]): AspectState | null {
	for (const a of aspects) {
		if (a.status === "pending") return a;
	}
	return null;
}

/**
 * Inspect the agent's output: was the per-aspect findings file written
 * with non-empty content?
 *
 * Returns one of:
 *  - `{ kind: "ok" }` — file exists and is non-empty.
 *  - `{ kind: "missing" }` — agent did not write the file.
 *  - `{ kind: "empty" }` — file is present but zero bytes.
 */
export type AspectFindingsResult = { kind: "ok" } | { kind: "missing" } | { kind: "empty" };

export function inspectAspectFindings(
	worktreePath: string,
	fileName: string,
): AspectFindingsResult {
	const abs = join(worktreePath, fileName);
	if (!existsSync(abs)) return { kind: "missing" };
	let body = "";
	try {
		body = readFileSync(abs, "utf-8");
	} catch {
		return { kind: "missing" };
	}
	if (body.trim() === "") return { kind: "empty" };
	return { kind: "ok" };
}

/**
 * Normalise per-aspect state on workflow load: any aspect persisted in
 * `in_progress` represents a CLI process that has been killed by the
 * server restart. Flip it back to `pending` so the user can re-run it
 * with a fresh dispatch (per `aspect-retry.md`).
 *
 * Returns true if any aspect was mutated.
 */
export function normaliseAspectsOnLoad(aspects: AspectState[] | null): boolean {
	if (!aspects) return false;
	let changed = false;
	for (const a of aspects) {
		if (a.status === "in_progress") {
			a.status = "pending";
			a.errorMessage = null;
			changed = true;
		}
	}
	return changed;
}

/**
 * Format the system text headline emitted before each per-aspect run
 * (`"Researching aspect 3 of 7: <title>"`).
 */
export function formatAspectHeadline(
	aspectIndex: number,
	totalAspects: number,
	title: string,
): string {
	return `Researching aspect ${aspectIndex + 1} of ${totalAspects}: ${title}`;
}

/** Aggregate the step-level status across an aspect set. See data-model.md §2. */
export type AggregatedStepStatus = "running" | "completed" | "error" | "paused";

export function aggregateStepStatus(aspects: AspectState[]): AggregatedStepStatus {
	if (aspects.length === 0) return "completed";
	let pendingOrRunning = 0;
	let errored = 0;
	let completed = 0;
	for (const a of aspects) {
		if (a.status === "completed") completed++;
		else if (a.status === "errored") errored++;
		else pendingOrRunning++; // pending or in_progress
	}
	if (pendingOrRunning > 0) return "running";
	if (errored > 0) return "error";
	if (completed === aspects.length) return "completed";
	return "running";
}

/** Counts used to render the progress header above the per-aspect grid (FR-006). */
export interface AspectProgressSummary {
	pending: number;
	running: number;
	completed: number;
	errored: number;
	total: number;
}

export function computeAspectProgress(aspects: AspectState[]): AspectProgressSummary {
	const summary: AspectProgressSummary = {
		pending: 0,
		running: 0,
		completed: 0,
		errored: 0,
		total: aspects.length,
	};
	for (const a of aspects) {
		if (a.status === "pending") summary.pending++;
		else if (a.status === "in_progress") summary.running++;
		else if (a.status === "completed") summary.completed++;
		else if (a.status === "errored") summary.errored++;
	}
	return summary;
}

export function formatAspectProgressLine(s: AspectProgressSummary): string {
	return `Research: ${s.completed} of ${s.total} complete (${s.running} in progress, ${s.errored} errored)`;
}

/**
 * Build a manifest of per-aspect findings files for the `${aspectFindings}`
 * block in the synthesis prompt. The block lists each aspect's title and the
 * relative file name where its findings live in the synthesizer's working
 * directory. The synthesizer is expected to read those files via its own
 * file-reading tools rather than receive their contents inline — passing the
 * full concatenated bodies through the CLI argv overflows the OS argv limit
 * (`ENAMETOOLONG`) once research outputs grow.
 */
export function buildAspectFindingsBlock(manifest: AspectManifestEntry[]): string {
	const sections: string[] = [];
	for (const a of manifest) {
		sections.push(`- ${a.title} — \`${a.fileName}\``);
	}
	return sections.join("\n");
}
