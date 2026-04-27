import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// FR-007 / SC-002: server-internal symbols must not leak into src/client/**.
// The type checker only catches imports of symbols that no longer exist on a
// module; it does not flag client files that still reach into ./types for the
// server-only `Workflow` shape or its `feedbackPreRunHead` field. This test
// locks in the grep that the spec uses for SC-002 so a future regression
// surfaces in CI rather than in the next code review.
const CLIENT_ROOT = join(import.meta.dir, "..", "..", "src", "client");
const FORBIDDEN_IMPORTED_SYMBOLS = ["Workflow"]; // server-internal interface
const FORBIDDEN_REFERENCES = ["feedbackPreRunHead"]; // server-only field

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			yield* walk(full);
		} else if (entry.endsWith(".ts")) {
			yield full;
		}
	}
}

describe("client/server boundary (FR-007, SC-002)", () => {
	test("no src/client/** file imports the server-internal Workflow type from ./types", () => {
		const offenders: string[] = [];
		const importTypesRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'][^"']*types["']/g;
		for (const file of walk(CLIENT_ROOT)) {
			const src = readFileSync(file, "utf8");
			let match: RegExpExecArray | null;
			match = importTypesRe.exec(src);
			while (match !== null) {
				const named = match[1].split(",").map(
					(s) =>
						s
							.trim()
							.replace(/^type\s+/, "")
							.split(/\s+as\s+/)[0],
				);
				for (const symbol of FORBIDDEN_IMPORTED_SYMBOLS) {
					if (named.includes(symbol)) offenders.push(`${file}: imports ${symbol}`);
				}
				match = importTypesRe.exec(src);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("no src/client/** file references server-only Workflow fields", () => {
		const offenders: string[] = [];
		for (const file of walk(CLIENT_ROOT)) {
			const src = readFileSync(file, "utf8");
			for (const ref of FORBIDDEN_REFERENCES) {
				if (src.includes(ref)) offenders.push(`${file}: references ${ref}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
