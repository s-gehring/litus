import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Enforces the invariant that only ONE place in the codebase spawns the
// `claude` CLI. The pain this guards against: before centralization, four
// different files each built their own argv starting with `"claude"`, and a
// forgotten flag in one of them (e.g. `--dangerously-skip-permissions` or
// `--append-system-prompt`) was a recurring source of "sometimes the
// invocation is broken" bugs.
//
// The test scans `src/` for literal array constructions whose first element
// is `"claude"` — the only way the CLI can be invoked via `Bun.spawn`. Every
// new Claude call site MUST go through `src/claude-spawn.ts`.

function walkTs(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		const s = statSync(p);
		if (s.isDirectory()) out.push(...walkTs(p));
		else if (p.endsWith(".ts")) out.push(p);
	}
	return out;
}

describe("claude CLI invocation centralization", () => {
	test("exactly one source file constructs a claude argv", () => {
		const files = walkTs("src");
		const matchers = files
			.map((file) => {
				const src = readFileSync(file, "utf8");
				const matches = src.match(/\[\s*["']claude["']\s*[,\]]/g);
				return { file, count: matches?.length ?? 0 };
			})
			.filter((f) => f.count > 0);

		expect(matchers).toHaveLength(1);
		const only = matchers[0];
		expect(only.file.replaceAll("\\", "/")).toEndWith("src/claude-spawn.ts");
		expect(only.count).toBe(1);
	});
});
