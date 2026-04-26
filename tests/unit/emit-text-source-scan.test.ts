import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const srcDir = join(repoRoot, "src");
const serverDir = join(srcDir, "server");
const serverEntry = join(srcDir, "server.ts");

/**
 * Server-side modules allowed to construct free-text wire frames directly.
 * `src/server/emit-text.ts` is the only sanctioned producer (FR-006).
 */
const ALLOWED_SERVER_PRODUCERS = new Set<string>([join("src", "server", "emit-text.ts")]);

function* iterTsFiles(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) yield* iterTsFiles(full);
		else if (st.isFile() && entry.endsWith(".ts")) yield full;
	}
}

function* iterServerFiles(): Generator<string> {
	yield serverEntry;
	yield* iterTsFiles(serverDir);
}

describe("emit-text source scan", () => {
	test("no server file outside emit-text module constructs free-text wire frames directly (FR-006, SC-001)", () => {
		const re = /type:\s*['"](workflow:output|epic:output|console:output)['"]/g;
		const offenders: Array<{ file: string; matches: string[] }> = [];
		for (const file of iterServerFiles()) {
			const rel = relative(repoRoot, file);
			if (ALLOWED_SERVER_PRODUCERS.has(rel)) continue;
			const content = readFileSync(file, "utf8");
			const matches = content.match(re);
			if (matches && matches.length > 0) {
				offenders.push({ file: rel, matches });
			}
		}
		expect(offenders).toEqual([]);
	});

	test('no remaining `type: "log"` references in src/ (FR-007)', () => {
		const re = /type:\s*['"]log['"]/g;
		const offenders: string[] = [];
		for (const file of iterTsFiles(srcDir)) {
			const content = readFileSync(file, "utf8");
			if (re.test(content)) offenders.push(relative(repoRoot, file));
		}
		expect(offenders).toEqual([]);
	});
});
