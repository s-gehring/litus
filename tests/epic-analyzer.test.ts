import { describe, expect, test } from "bun:test";
import { analyzeEpic, buildDecompositionPrompt, parseAnalysisResult } from "../src/epic-analyzer";

describe("buildDecompositionPrompt", () => {
	test("includes epic description in prompt", () => {
		const prompt = buildDecompositionPrompt("Add auth with OAuth2 and admin dashboard");
		expect(prompt).toContain("Add auth with OAuth2 and admin dashboard");
		expect(prompt).toContain("Epic Description");
		expect(prompt).toContain("JSON");
	});
});

describe("parseAnalysisResult", () => {
	test("parses valid JSON from code fence", () => {
		const text = `Here is the decomposition:

\`\`\`json
{
  "title": "Auth System",
  "specs": [
    { "id": "a", "title": "OAuth2", "description": "Add OAuth2 login", "dependencies": [] },
    { "id": "b", "title": "Admin", "description": "Add admin dashboard", "dependencies": ["a"] }
  ],
  "infeasibleNotes": null
}
\`\`\`

Done.`;
		const result = parseAnalysisResult(text);
		expect(result.title).toBe("Auth System");
		expect(result.specs).toHaveLength(2);
		expect(result.specs[0].id).toBe("a");
		expect(result.specs[1].dependencies).toEqual(["a"]);
		expect(result.infeasibleNotes).toBeNull();
	});

	test("parses raw JSON without code fence", () => {
		const text = `{
  "title": "Simple Feature",
  "specs": [{ "id": "a", "title": "Only spec", "description": "Do the thing", "dependencies": [] }],
  "infeasibleNotes": null
}`;
		const result = parseAnalysisResult(text);
		expect(result.title).toBe("Simple Feature");
		expect(result.specs).toHaveLength(1);
	});

	test("throws on missing code fence and invalid JSON", () => {
		expect(() => parseAnalysisResult("No JSON here at all")).toThrow(
			"Could not parse decomposition result",
		);
	});

	test("throws on invalid schema (missing specs)", () => {
		const text = '```json\n{ "title": "No specs" }\n```';
		expect(() => parseAnalysisResult(text)).toThrow();
	});

	test("throws on invalid schema (spec missing title)", () => {
		const text =
			'```json\n{ "title": "T", "specs": [{ "id": "a", "description": "d", "dependencies": [] }], "infeasibleNotes": null }\n```';
		expect(() => parseAnalysisResult(text)).toThrow();
	});

	test("throws on circular dependencies", () => {
		const text = `\`\`\`json
{
  "title": "Circular",
  "specs": [
    { "id": "a", "title": "A", "description": "A desc", "dependencies": ["b"] },
    { "id": "b", "title": "B", "description": "B desc", "dependencies": ["a"] }
  ],
  "infeasibleNotes": null
}
\`\`\``;
		expect(() => parseAnalysisResult(text)).toThrow("Circular dependencies");
	});

	test("throws on invalid dependency reference", () => {
		const text = `\`\`\`json
{
  "title": "Bad Ref",
  "specs": [
    { "id": "a", "title": "A", "description": "A desc", "dependencies": [] },
    { "id": "b", "title": "B", "description": "B desc", "dependencies": ["z"] }
  ],
  "infeasibleNotes": null
}
\`\`\``;
		expect(() => parseAnalysisResult(text)).toThrow(
			'Unknown dependency reference: "z" in spec "b"',
		);
	});

	test("handles infeasibleNotes", () => {
		const text = `\`\`\`json
{
  "title": "Partial",
  "specs": [{ "id": "a", "title": "A", "description": "d", "dependencies": [] }],
  "infeasibleNotes": "Cannot implement the cloud sync portion"
}
\`\`\``;
		const result = parseAnalysisResult(text);
		expect(result.infeasibleNotes).toBe("Cannot implement the cloud sync portion");
	});
});

describe("analyzeEpic", () => {
	test("throws on timeout when CLI is available", async () => {
		// Check if claude CLI is available — skip if not (e.g. CI)
		try {
			const which = Bun.spawn(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
			const code = await which.exited;
			if (code !== 0) return;
		} catch {
			return; // CLI not found in PATH
		}

		await expect(
			analyzeEpic("Some epic description that is long enough", process.cwd(), undefined, 1),
		).rejects.toThrow("Epic analysis timed out");
	});
});
