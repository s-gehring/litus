// Artifacts-step manifest contract. Mirrors
// specs/001-implementation-artifacts/contracts/manifest.schema.json so the
// runtime validator and the shipped schema stay in sync. The LLM emits
// `manifest.json` into its output directory; only files listed here are kept.

export interface ArtifactsManifestEntry {
	path: string;
	description: string;
	contentType?: string;
}

export interface ArtifactsManifest {
	version: 1;
	artifacts: ArtifactsManifestEntry[];
}

export const DESCRIPTION_MAX_LENGTH = 500;

export type ManifestParseError =
	| { kind: "invalid-json"; message: string }
	| { kind: "schema-violation"; message: string; at: string };

export interface ManifestParseResult {
	ok: boolean;
	manifest: ArtifactsManifest | null;
	error: ManifestParseError | null;
}

function fail(error: ManifestParseError): ManifestParseResult {
	return { ok: false, manifest: null, error };
}

function invalid(at: string, message: string): ManifestParseResult {
	return fail({ kind: "schema-violation", at, message });
}

// Minimal hand-rolled validator — the schema is tiny and the project ships no
// JSON Schema runtime. Keeping it inline avoids pulling in ajv just for two
// object shapes. If the schema grows, swap this for a library validator.
export function parseArtifactsManifest(rawText: string): ManifestParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText);
	} catch (err) {
		return fail({ kind: "invalid-json", message: (err as Error).message });
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return invalid("$", "manifest must be a JSON object");
	}

	const root = parsed as Record<string, unknown>;
	if (root.version !== 1) {
		return invalid("$.version", "must be the integer 1");
	}
	if (!Array.isArray(root.artifacts)) {
		return invalid("$.artifacts", "must be an array");
	}

	const allowedRootKeys = new Set(["version", "artifacts"]);
	for (const key of Object.keys(root)) {
		if (!allowedRootKeys.has(key)) {
			return invalid(`$.${key}`, "unknown property");
		}
	}

	const entries: ArtifactsManifestEntry[] = [];
	for (let i = 0; i < root.artifacts.length; i++) {
		const raw = root.artifacts[i];
		const at = `$.artifacts[${i}]`;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return invalid(at, "entry must be an object");
		}
		const entry = raw as Record<string, unknown>;

		const allowedEntryKeys = new Set(["path", "description", "contentType"]);
		for (const key of Object.keys(entry)) {
			if (!allowedEntryKeys.has(key)) {
				return invalid(`${at}.${key}`, "unknown property");
			}
		}

		if (typeof entry.path !== "string" || entry.path.length === 0) {
			return invalid(`${at}.path`, "must be a non-empty string");
		}
		if (typeof entry.description !== "string" || entry.description.length === 0) {
			return invalid(`${at}.description`, "must be a non-empty string");
		}
		if (entry.description.length > DESCRIPTION_MAX_LENGTH) {
			return invalid(`${at}.description`, `must be at most ${DESCRIPTION_MAX_LENGTH} characters`);
		}
		if (entry.contentType !== undefined) {
			if (typeof entry.contentType !== "string" || entry.contentType.length === 0) {
				return invalid(`${at}.contentType`, "must be a non-empty string if present");
			}
		}

		entries.push({
			path: entry.path,
			description: entry.description,
			contentType: entry.contentType as string | undefined,
		});
	}

	return {
		ok: true,
		manifest: { version: 1, artifacts: entries },
		error: null,
	};
}
