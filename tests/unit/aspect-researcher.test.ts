import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	aggregateStepStatus,
	buildAspectFindingsBlock,
	buildResearchPrompt,
	computeAspectProgress,
	formatAspectHeadline,
	formatAspectProgressLine,
	inspectAspectFindings,
	normaliseAspectsOnLoad,
	pickNextAspect,
} from "../../src/aspect-researcher";
import type { AspectManifestEntry, AspectState } from "../../src/types";

function aspect(overrides: Partial<AspectState> = {}): AspectState {
	return {
		id: overrides.id ?? "a",
		fileName: overrides.fileName ?? "a.md",
		status: overrides.status ?? "pending",
		sessionId: overrides.sessionId ?? null,
		startedAt: overrides.startedAt ?? null,
		completedAt: overrides.completedAt ?? null,
		errorMessage: overrides.errorMessage ?? null,
		output: overrides.output ?? "",
		outputLog: overrides.outputLog ?? [],
	};
}

describe("buildResearchPrompt", () => {
	test("substitutes the three template variables", () => {
		const out = buildResearchPrompt(
			"T: ${aspectTitle}\nP: ${aspectResearchPrompt}\nF: ${aspectFileName}",
			{ aspectTitle: "Title", aspectResearchPrompt: "Prompt", aspectFileName: "01.md" },
		);
		expect(out).toBe("T: Title\nP: Prompt\nF: 01.md");
	});
});

describe("pickNextAspect", () => {
	test("returns the first pending aspect in document order", () => {
		const aspects = [
			aspect({ id: "a", status: "completed" }),
			aspect({ id: "b", status: "pending" }),
			aspect({ id: "c", status: "pending" }),
		];
		expect(pickNextAspect(aspects)?.id).toBe("b");
	});

	test("returns null when every aspect is completed or errored", () => {
		const aspects = [
			aspect({ id: "a", status: "completed" }),
			aspect({ id: "b", status: "errored" }),
		];
		expect(pickNextAspect(aspects)).toBeNull();
	});
});

describe("normaliseAspectsOnLoad", () => {
	test("flips in_progress aspects back to pending and clears errorMessage", () => {
		const aspects = [
			aspect({ id: "a", status: "completed" }),
			aspect({ id: "b", status: "in_progress", errorMessage: "stale" }),
			aspect({ id: "c", status: "pending" }),
		];
		const changed = normaliseAspectsOnLoad(aspects);
		expect(changed).toBe(true);
		expect(aspects[1].status).toBe("pending");
		expect(aspects[1].errorMessage).toBeNull();
	});

	test("returns false when no aspect was in_progress", () => {
		const aspects = [aspect({ status: "completed" })];
		expect(normaliseAspectsOnLoad(aspects)).toBe(false);
	});

	test("handles null input gracefully", () => {
		expect(normaliseAspectsOnLoad(null)).toBe(false);
	});
});

describe("formatAspectHeadline", () => {
	test("formats `Researching aspect N of M: <title>`", () => {
		expect(formatAspectHeadline(2, 5, "How does X work")).toBe(
			"Researching aspect 3 of 5: How does X work",
		);
	});
});

describe("aggregateStepStatus", () => {
	test("all completed → completed", () => {
		expect(
			aggregateStepStatus([
				aspect({ id: "a", status: "completed" }),
				aspect({ id: "b", status: "completed" }),
			]),
		).toBe("completed");
	});

	test("any pending or in_progress → running (no errors)", () => {
		expect(
			aggregateStepStatus([
				aspect({ id: "a", status: "completed" }),
				aspect({ id: "b", status: "pending" }),
			]),
		).toBe("running");
		expect(
			aggregateStepStatus([
				aspect({ id: "a", status: "in_progress" }),
				aspect({ id: "b", status: "pending" }),
			]),
		).toBe("running");
	});

	test("any pending or in_progress → running even with errored siblings", () => {
		expect(
			aggregateStepStatus([
				aspect({ id: "a", status: "errored", errorMessage: "x" }),
				aspect({ id: "b", status: "in_progress" }),
			]),
		).toBe("running");
	});

	test("≥1 errored AND none pending/in_progress → error", () => {
		expect(
			aggregateStepStatus([
				aspect({ id: "a", status: "completed" }),
				aspect({ id: "b", status: "errored", errorMessage: "x" }),
			]),
		).toBe("error");
	});

	test("empty input → completed", () => {
		expect(aggregateStepStatus([])).toBe("completed");
	});
});

describe("computeAspectProgress / formatAspectProgressLine", () => {
	test("counts every status correctly", () => {
		const aspects = [
			aspect({ id: "a", status: "completed" }),
			aspect({ id: "b", status: "in_progress" }),
			aspect({ id: "c", status: "errored", errorMessage: "x" }),
			aspect({ id: "d", status: "pending" }),
		];
		expect(computeAspectProgress(aspects)).toEqual({
			pending: 1,
			running: 1,
			completed: 1,
			errored: 1,
			total: 4,
		});
	});

	test("formats the progress line per FR-006", () => {
		const aspects = [
			aspect({ id: "a", status: "completed" }),
			aspect({ id: "b", status: "in_progress" }),
			aspect({ id: "c", status: "pending" }),
		];
		expect(formatAspectProgressLine(computeAspectProgress(aspects))).toBe(
			"Research: 1 of 3 complete (1 in progress, 0 errored)",
		);
	});
});

describe("inspectAspectFindings", () => {
	test("returns missing when the file does not exist", () => {
		const dir = mkdtempSync(join(tmpdir(), "litus-aspect-"));
		try {
			expect(inspectAspectFindings(dir, "nope.md")).toEqual({ kind: "missing" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns empty when the file is whitespace-only", () => {
		const dir = mkdtempSync(join(tmpdir(), "litus-aspect-"));
		try {
			writeFileSync(join(dir, "a.md"), "   \n\t\n");
			expect(inspectAspectFindings(dir, "a.md")).toEqual({ kind: "empty" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns ok when the file has content", () => {
		const dir = mkdtempSync(join(tmpdir(), "litus-aspect-"));
		try {
			writeFileSync(join(dir, "a.md"), "Findings.\n");
			expect(inspectAspectFindings(dir, "a.md")).toEqual({ kind: "ok" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("buildAspectFindingsBlock", () => {
	const manifest: AspectManifestEntry[] = [
		{ id: "a1", title: "First aspect", researchPrompt: "p", fileName: "first.md" },
		{ id: "a2", title: "Second aspect", researchPrompt: "p", fileName: "second.md" },
	];

	test("concatenates per-aspect files separated by `---` and prefixed with the title", () => {
		const dir = mkdtempSync(join(tmpdir(), "litus-aspect-"));
		try {
			writeFileSync(join(dir, "first.md"), "Body 1\n");
			writeFileSync(join(dir, "second.md"), "Body 2\n");
			const block = buildAspectFindingsBlock(dir, manifest);
			expect(block).toContain("## First aspect");
			expect(block).toContain("_(file: first.md)_");
			expect(block).toContain("Body 1");
			expect(block).toContain("## Second aspect");
			expect(block).toContain("Body 2");
			expect(block).toContain("\n\n---\n\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("uses an empty body for missing per-aspect files", () => {
		const dir = mkdtempSync(join(tmpdir(), "litus-aspect-"));
		try {
			writeFileSync(join(dir, "first.md"), "Body 1\n");
			const block = buildAspectFindingsBlock(dir, manifest);
			expect(block).toContain("## Second aspect");
			expect(block.trim().endsWith("_(file: second.md)_")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
