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

/**
 * Concatenate per-aspect findings files into the `${aspectFindings}` block
 * the synthesis prompt expects. Each entry is prefixed with the aspect
 * title so the synthesizer can attribute findings.
 */
export function buildAspectFindingsBlock(
	worktreePath: string,
	manifest: AspectManifestEntry[],
): string {
	const sections: string[] = [];
	for (const a of manifest) {
		const abs = join(worktreePath, a.fileName);
		let body = "";
		try {
			if (existsSync(abs)) body = readFileSync(abs, "utf-8");
		} catch {
			body = "";
		}
		sections.push(`## ${a.title}\n\n_(file: ${a.fileName})_\n\n${body.trim()}`);
	}
	return sections.join("\n\n---\n\n");
}
