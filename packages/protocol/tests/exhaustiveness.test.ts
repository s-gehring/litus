// Exhaustiveness guard (R-9, SC-004, US4 acceptance #2).
//
// Derives the canonical variant set from `serverMessageSchema._def.optionsMap`
// and `clientMessageSchema._def.optionsMap` and fails the suite with a
// clear named-variant message if any schema variant has no entry in
// `FIXTURE_TYPES` (round-trip.test.ts). Adding a new variant to a schema
// without a corresponding fixture is therefore a hard CI failure.

import { describe, expect, test } from "bun:test";
import "./frontend-agnostic-guard";
import { clientMessageSchema, serverMessageSchema } from "../src/index";
import { FIXTURE_TYPES } from "./fixtures";

function variantKeys(schema: typeof serverMessageSchema | typeof clientMessageSchema): string[] {
	const def = (schema as { _def: { optionsMap?: Map<string, unknown> } })._def;
	if (def.optionsMap) {
		return Array.from(def.optionsMap.keys()).map(String);
	}
	throw new Error("Schema has no `_def.optionsMap`; expected a discriminated union.");
}

describe("schema-fixture exhaustiveness", () => {
	test("every ServerMessage schema variant has a round-trip fixture", () => {
		const fixtured = new Set(Object.keys(FIXTURE_TYPES.server));
		const declared = variantKeys(serverMessageSchema);
		const missing = declared.filter((v) => !fixtured.has(v));
		if (missing.length > 0) {
			throw new Error(
				`ServerMessage variants missing a fixture in FIXTURE_TYPES.server: ${missing.join(
					", ",
				)}. Add a fixture in round-trip.test.ts.`,
			);
		}
		expect(missing).toEqual([]);
	});

	test("every ClientMessage schema variant has a round-trip fixture", () => {
		const fixtured = new Set(Object.keys(FIXTURE_TYPES.client));
		const declared = variantKeys(clientMessageSchema);
		const missing = declared.filter((v) => !fixtured.has(v));
		if (missing.length > 0) {
			throw new Error(
				`ClientMessage variants missing a fixture in FIXTURE_TYPES.client: ${missing.join(
					", ",
				)}. Add a fixture in round-trip.test.ts.`,
			);
		}
		expect(missing).toEqual([]);
	});

	test("FIXTURE_TYPES.server has no orphan keys not in the schema", () => {
		const declared = new Set(variantKeys(serverMessageSchema));
		const orphans = Object.keys(FIXTURE_TYPES.server).filter((v) => !declared.has(v));
		expect(orphans).toEqual([]);
	});

	test("FIXTURE_TYPES.client has no orphan keys not in the schema", () => {
		const declared = new Set(variantKeys(clientMessageSchema));
		const orphans = Object.keys(FIXTURE_TYPES.client).filter((v) => !declared.has(v));
		expect(orphans).toEqual([]);
	});
});
