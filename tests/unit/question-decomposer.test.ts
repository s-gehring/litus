import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildDecompositionPrompt,
	buildInitialAspectStates,
	DECOMPOSITION_FILE_REL,
	readAndValidateDecompositionFile,
	validateAspectManifest,
} from "../../src/question-decomposer";
import type { AspectManifest } from "../../src/types";

describe("buildDecompositionPrompt", () => {
	test("substitutes ${question}, ${maxAspects}, and ${decompositionFile}", () => {
		const out = buildDecompositionPrompt(
			"Q: ${question}\nMax: ${maxAspects}\nFile: ${decompositionFile}",
			{ question: "Why?", maxAspects: 7, decompositionFile: ".litus/decomposition.json" },
		);
		expect(out).toBe("Q: Why?\nMax: 7\nFile: .litus/decomposition.json");
	});

	test("handles duplicate variable references", () => {
		const out = buildDecompositionPrompt("${question} / ${question}", {
			question: "x",
			maxAspects: 1,
			decompositionFile: "f.json",
		});
		expect(out).toBe("x / x");
	});
});

describe("validateAspectManifest", () => {
	const valid: AspectManifest = {
		version: 1,
		aspects: [
			{
				id: "aspect-01",
				title: "How does X work",
				researchPrompt: "investigate X",
				fileName: "01-x.md",
			},
			{
				id: "aspect-02",
				title: "How does Y work",
				researchPrompt: "investigate Y",
				fileName: "02-y.md",
			},
		],
	};

	test("accepts a minimal valid manifest", () => {
		const r = validateAspectManifest(valid, 10);
		expect(r.kind).toBe("ok");
		if (r.kind === "ok") {
			expect(r.manifest.aspects).toHaveLength(2);
			expect(r.cappedFrom).toBeNull();
		}
	});

	test("rejects zero aspects", () => {
		const r = validateAspectManifest({ version: 1, aspects: [] }, 10);
		expect(r.kind).toBe("error");
		if (r.kind === "error") expect(r.message).toContain("zero aspects");
	});

	test("rejects unsupported version", () => {
		const r = validateAspectManifest({ ...valid, version: 2 }, 10);
		expect(r.kind).toBe("error");
		if (r.kind === "error") expect(r.message).toContain("unsupported version");
	});

	test("rejects non-object input", () => {
		expect(validateAspectManifest("not an object", 10).kind).toBe("error");
		expect(validateAspectManifest([], 10).kind).toBe("error");
		expect(validateAspectManifest(null, 10).kind).toBe("error");
	});

	test("rejects entries missing required fields", () => {
		const r = validateAspectManifest(
			{ version: 1, aspects: [{ id: "a", title: "", researchPrompt: "p", fileName: "x.md" }] },
			10,
		);
		expect(r.kind).toBe("error");
		if (r.kind === "error") expect(r.message).toContain("title");
	});

	test("rejects invalid file names (path separator, missing extension)", () => {
		for (const fileName of ["../escape.md", "no-extension", "sub/dir.md", "weird name.md"]) {
			const r = validateAspectManifest(
				{
					version: 1,
					aspects: [{ id: "a", title: "t", researchPrompt: "p", fileName }],
				},
				10,
			);
			expect(r.kind).toBe("error");
			if (r.kind === "error") expect(r.message).toContain("fileName");
		}
	});

	test("rejects duplicate ids", () => {
		const r = validateAspectManifest(
			{
				version: 1,
				aspects: [
					{ id: "a", title: "t", researchPrompt: "p", fileName: "1.md" },
					{ id: "a", title: "t", researchPrompt: "p", fileName: "2.md" },
				],
			},
			10,
		);
		expect(r.kind).toBe("error");
		if (r.kind === "error") expect(r.message).toContain("duplicates");
	});

	test("rejects duplicate fileNames (case-insensitive)", () => {
		const r = validateAspectManifest(
			{
				version: 1,
				aspects: [
					{ id: "a", title: "t", researchPrompt: "p", fileName: "Same.md" },
					{ id: "b", title: "t", researchPrompt: "p", fileName: "same.md" },
				],
			},
			10,
		);
		expect(r.kind).toBe("error");
		if (r.kind === "error") expect(r.message).toContain("duplicates");
	});

	test("rejects fileName equal to reserved answer.md (case-insensitive)", () => {
		const r = validateAspectManifest(
			{
				version: 1,
				aspects: [{ id: "a", title: "t", researchPrompt: "p", fileName: "Answer.MD" }],
			},
			10,
		);
		expect(r.kind).toBe("error");
		if (r.kind === "error") expect(r.message).toContain("reserved");
	});

	test("caps at maxAspects and reports cappedFrom (no error)", () => {
		const aspects = Array.from({ length: 15 }, (_, i) => ({
			id: `aspect-${i + 1}`,
			title: `t${i}`,
			researchPrompt: "p",
			fileName: `file-${i + 1}.md`,
		}));
		const r = validateAspectManifest({ version: 1, aspects }, 10);
		expect(r.kind).toBe("ok");
		if (r.kind === "ok") {
			expect(r.manifest.aspects).toHaveLength(10);
			expect(r.cappedFrom).toBe(15);
			expect(r.manifest.aspects[0].id).toBe("aspect-1");
			expect(r.manifest.aspects[9].id).toBe("aspect-10");
		}
	});
});

describe("buildInitialAspectStates", () => {
	test("creates one pending state per manifest aspect", () => {
		const states = buildInitialAspectStates({
			version: 1,
			aspects: [
				{ id: "a", title: "t", researchPrompt: "p", fileName: "1.md" },
				{ id: "b", title: "t", researchPrompt: "p", fileName: "2.md" },
			],
		});
		expect(states).toHaveLength(2);
		expect(states[0]).toEqual({
			id: "a",
			fileName: "1.md",
			status: "pending",
			sessionId: null,
			startedAt: null,
			completedAt: null,
			errorMessage: null,
			output: "",
			outputLog: [],
		});
		expect(states[1].id).toBe("b");
	});
});

describe("readAndValidateDecompositionFile", () => {
	function withWorktree(setup: (path: string) => void): string {
		const dir = mkdtempSync(join(tmpdir(), "litus-decomp-"));
		setup(dir);
		return dir;
	}

	test("returns error when the manifest file does not exist", () => {
		const dir = withWorktree(() => {});
		try {
			const result = readAndValidateDecompositionFile(dir, 5);
			expect(result.kind).toBe("error");
			if (result.kind === "error") {
				expect(result.message).toContain(DECOMPOSITION_FILE_REL);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns error when the manifest is not valid JSON", () => {
		const dir = withWorktree((d) => {
			mkdirSync(join(d, ".litus"));
			writeFileSync(join(d, DECOMPOSITION_FILE_REL), "{not json");
		});
		try {
			const result = readAndValidateDecompositionFile(dir, 5);
			expect(result.kind).toBe("error");
			if (result.kind === "error") {
				expect(result.message).toContain("could not be parsed");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns ok with the parsed manifest on a valid file", () => {
		const dir = withWorktree((d) => {
			mkdirSync(join(d, ".litus"));
			const manifest = {
				version: 1,
				aspects: [
					{ id: "a1", title: "T1", researchPrompt: "P1", fileName: "a1.md" },
					{ id: "a2", title: "T2", researchPrompt: "P2", fileName: "a2.md" },
				],
			};
			writeFileSync(join(d, DECOMPOSITION_FILE_REL), JSON.stringify(manifest));
		});
		try {
			const result = readAndValidateDecompositionFile(dir, 5);
			expect(result.kind).toBe("ok");
			if (result.kind === "ok") {
				expect(result.manifest.aspects.length).toBe(2);
				expect(result.cappedFrom).toBeNull();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("caps the manifest when it exceeds maxAspects", () => {
		const dir = withWorktree((d) => {
			mkdirSync(join(d, ".litus"));
			const manifest = {
				version: 1,
				aspects: [
					{ id: "a1", title: "T1", researchPrompt: "P1", fileName: "a1.md" },
					{ id: "a2", title: "T2", researchPrompt: "P2", fileName: "a2.md" },
					{ id: "a3", title: "T3", researchPrompt: "P3", fileName: "a3.md" },
				],
			};
			writeFileSync(join(d, DECOMPOSITION_FILE_REL), JSON.stringify(manifest));
		});
		try {
			const result = readAndValidateDecompositionFile(dir, 2);
			expect(result.kind).toBe("ok");
			if (result.kind === "ok") {
				expect(result.manifest.aspects.length).toBe(2);
				expect(result.cappedFrom).toBe(3);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
