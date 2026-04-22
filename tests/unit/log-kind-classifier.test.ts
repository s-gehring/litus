import { describe, expect, it } from "bun:test";
import { classifyLine } from "../../src/client/components/run-screen/log-kind-classifier";

describe("classifyLine", () => {
	it("honours server-tagged kind when present", () => {
		expect(classifyLine("anything", "cmd")).toEqual({ kind: "cmd", cwd: null, body: "anything" });
		expect(classifyLine("hi", "assistant")).toEqual({ kind: "assistant", body: "hi" });
		expect(classifyLine("path.ts", "diff")).toEqual({ kind: "diff", path: "path.ts", hunks: [] });
	});

	it("classifies em-dash banners as section", () => {
		const ev = classifyLine("──────── step 2 · fix-implement ────────");
		expect(ev.kind).toBe("section");
	});

	it("classifies `$`-prefix lines as cmd", () => {
		const ev = classifyLine("$ pnpm test");
		expect(ev.kind).toBe("cmd");
		if (ev.kind === "cmd") expect(ev.body).toBe("pnpm test");
	});

	it("falls back to out for everything else", () => {
		const ev = classifyLine("15 passed · 0 failed · 2.14s");
		expect(ev.kind).toBe("out");
	});

	it("extracts [cwd] via the heuristic branch when server-kind is absent (§3.4)", () => {
		const ev = classifyLine("[/repo/litus] $ bun test");
		expect(ev.kind).toBe("cmd");
		if (ev.kind === "cmd") {
			expect(ev.cwd).toBe("/repo/litus");
			expect(ev.body).toBe("bun test");
		}
	});

	it("lets the heuristic win when server-kind is absent and body looks like a cmd (§3.4)", () => {
		// Contract: absent kind → heuristic wins. A line that visually starts with
		// `$ ` is classified as `cmd` even though it might be assistant markdown.
		// Flagged by review §3.4 as a decision worth locking.
		const ev = classifyLine("$ pnpm test --watch");
		expect(ev.kind).toBe("cmd");
	});

	it('parses a multi-line diff body through serverKind="diff" (§2.5 / §3.4)', () => {
		const body = ["◇ src/foo.ts", "@@ -1,3 +1,3 @@", " keep", "-drop", "+add"].join("\n");
		const ev = classifyLine(body, "diff");
		expect(ev.kind).toBe("diff");
		if (ev.kind !== "diff") return;
		expect(ev.path).toBe("src/foo.ts");
		expect(ev.hunks).toHaveLength(1);
		expect(ev.hunks[0].context).toBe("@@ -1,3 +1,3 @@");
		expect(ev.hunks[0].lines.map((l) => l.op)).toEqual([" ", "-", "+"]);
		expect(ev.hunks[0].lines[0].text).toBe(" keep");
		expect(ev.hunks[0].lines[1].text).toBe("drop");
		expect(ev.hunks[0].lines[2].text).toBe("add");
	});

	it('serverKind="diff" with only an ◇ path header and body collects a default hunk (§2.5)', () => {
		const body = ["◇ README.md", "+new line"].join("\n");
		const ev = classifyLine(body, "diff");
		expect(ev.kind).toBe("diff");
		if (ev.kind !== "diff") return;
		expect(ev.path).toBe("README.md");
		expect(ev.hunks).toHaveLength(1);
		expect(ev.hunks[0].lines[0].op).toBe("+");
		expect(ev.hunks[0].lines[0].text).toBe("new line");
	});
});
