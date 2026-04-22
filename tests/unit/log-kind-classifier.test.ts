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
});
