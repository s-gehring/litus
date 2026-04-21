import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArtifactsManifest } from "../../src/artifacts-manifest";

// Guard against drift between the shipped JSON schema and the hand-rolled
// validator in src/artifacts-manifest.ts. Rather than re-deriving the schema
// in code, we read it from disk and exercise the validator against payloads
// that respect or violate specific schema fields.
const SCHEMA_PATH = join(
	__dirname,
	"..",
	"..",
	"specs",
	"001-implementation-artifacts",
	"contracts",
	"manifest.schema.json",
);

interface JsonSchema {
	properties?: { version?: { const?: number } };
	$defs?: {
		ManifestEntry?: {
			properties?: {
				description?: { maxLength?: number };
			};
		};
	};
}

describe("artifacts-manifest validator stays in sync with the shipped JSON schema", () => {
	const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8")) as JsonSchema;

	test("version constant matches the schema", () => {
		const schemaVersion = schema.properties?.version?.const;
		expect(schemaVersion).toBe(1);
		const accepted = parseArtifactsManifest(
			JSON.stringify({ version: schemaVersion, artifacts: [] }),
		);
		expect(accepted.ok).toBe(true);
		const wrongVersion = parseArtifactsManifest(
			JSON.stringify({ version: (schemaVersion ?? 1) + 1, artifacts: [] }),
		);
		expect(wrongVersion.ok).toBe(false);
	});

	test("description maxLength matches the schema", () => {
		const maxLen = schema.$defs?.ManifestEntry?.properties?.description?.maxLength;
		expect(typeof maxLen).toBe("number");
		const atLimit = parseArtifactsManifest(
			JSON.stringify({
				version: 1,
				artifacts: [{ path: "a.md", description: "x".repeat(maxLen ?? 0) }],
			}),
		);
		expect(atLimit.ok).toBe(true);
		const overLimit = parseArtifactsManifest(
			JSON.stringify({
				version: 1,
				artifacts: [{ path: "a.md", description: "x".repeat((maxLen ?? 0) + 1) }],
			}),
		);
		expect(overLimit.ok).toBe(false);
	});
});
