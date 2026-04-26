import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const srcDir = join(repoRoot, "src");

/**
 * Modules allowed to reference free-text wire-frame discriminants directly.
 * `src/server/emit-text.ts` is the only sanctioned producer (FR-006); the
 * client must still pattern-match on `type: "..."` literals to render, and
 * `src/types.ts` must declare the discriminant literals themselves.
 */
const ALLOWED_PRODUCER = join("src", "server", "emit-text.ts");
const TYPES_FILE = join("src", "types.ts");
const CLIENT_DIR = join("src", "client") + (process.platform === "win32" ? "\\" : "/");

function* iterTsFiles(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) yield* iterTsFiles(full);
		else if (st.isFile() && entry.endsWith(".ts")) yield full;
	}
}

function isAllowed(rel: string): boolean {
	return rel === ALLOWED_PRODUCER || rel === TYPES_FILE || rel.startsWith(CLIENT_DIR);
}

describe("emit-text source scan", () => {
	test("no module outside emit-text constructs free-text wire frames directly (FR-006, SC-001)", () => {
		const re = /type:\s*['"](workflow:output|epic:output|console:output)['"]/g;
		const offenders: Array<{ file: string; matches: string[] }> = [];
		for (const file of iterTsFiles(srcDir)) {
			const rel = relative(repoRoot, file);
			if (isAllowed(rel)) continue;
			const content = readFileSync(file, "utf8");
			const matches = content.match(re);
			if (matches && matches.length > 0) {
				offenders.push({ file: rel, matches });
			}
		}
		expect(offenders).toEqual([]);
	});

	test("no module outside emit-text imports `channelToMessage` (FR-006)", () => {
		const re = /\bchannelToMessage\b/;
		const offenders: string[] = [];
		for (const file of iterTsFiles(srcDir)) {
			const rel = relative(repoRoot, file);
			if (rel === ALLOWED_PRODUCER) continue;
			const content = readFileSync(file, "utf8");
			if (re.test(content)) offenders.push(rel);
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
