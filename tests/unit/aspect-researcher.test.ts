import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildAspectFindingsBlock,
	buildResearchPrompt,
	formatAspectHeadline,
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

	test("emits a bullet list of `<title> — <fileName>` references", () => {
		const block = buildAspectFindingsBlock(manifest);
		expect(block).toBe("- First aspect — `first.md`\n- Second aspect — `second.md`");
	});

	test("does NOT inline the per-aspect file bodies (avoids ENAMETOOLONG when passed via argv)", () => {
		const block = buildAspectFindingsBlock(manifest);
		// Body content from large research files must never reach the prompt
		// string — the synthesizer reads the files via its own tools instead.
		expect(block).not.toContain("Body 1");
		expect(block).not.toContain("Body 2");
		// The block size scales with the number of aspects, not their findings.
		expect(block.length).toBeLessThan(200);
	});

	test("returns an empty string for an empty manifest", () => {
		expect(buildAspectFindingsBlock([])).toBe("");
	});
});
