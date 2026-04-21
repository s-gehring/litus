import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AlertStore } from "../../src/alert-store";
import type { Alert } from "../../src/types";
import { withTempDir } from "../test-infra";

function sampleAlert(overrides: Partial<Alert> = {}): Alert {
	return {
		id: "alert_01",
		type: "workflow-finished",
		title: "Done",
		description: "All good",
		workflowId: "wf_1",
		epicId: null,
		targetRoute: "/workflow/wf_1",
		createdAt: 1_700_000_000_000,
		seen: false,
		...overrides,
	};
}

describe("AlertStore", () => {
	test("load returns [] when file missing", async () => {
		await withTempDir(async (dir) => {
			const store = new AlertStore(dir);
			expect(await store.load()).toEqual([]);
		});
	});

	test("save + load round trip", async () => {
		await withTempDir(async (dir) => {
			const store = new AlertStore(dir);
			const alerts = [sampleAlert({ id: "a" }), sampleAlert({ id: "b", type: "error" })];
			await store.save(alerts);
			const loaded = await store.load();
			expect(loaded).toEqual(alerts);
		});
	});

	test("save writes via atomic rename (no .tmp remains)", async () => {
		await withTempDir(async (dir) => {
			const store = new AlertStore(dir);
			await store.save([sampleAlert()]);
			const file = Bun.file(join(dir, "alerts.json"));
			expect(await file.exists()).toBe(true);
		});
	});

	test("load returns [] on wrong version", async () => {
		await withTempDir(async (dir) => {
			writeFileSync(
				join(dir, "alerts.json"),
				JSON.stringify({ version: 42, alerts: [sampleAlert()] }),
			);
			const store = new AlertStore(dir);
			expect(await store.load()).toEqual([]);
		});
	});

	test("load treats missing version as v1 and migrates alerts to seen=true", async () => {
		await withTempDir(async (dir) => {
			// No `seen` field, no version — treated as v1; migration flips seen=true.
			writeFileSync(
				join(dir, "alerts.json"),
				JSON.stringify({
					alerts: [{ ...sampleAlert(), seen: undefined }],
				}),
			);
			const store = new AlertStore(dir);
			const loaded = await store.load();
			expect(loaded).toHaveLength(1);
			expect(loaded[0].seen).toBe(true);
		});
	});

	test("load drops invalid entries, keeps valid ones", async () => {
		await withTempDir(async (dir) => {
			const valid = sampleAlert({ id: "good" });
			writeFileSync(
				join(dir, "alerts.json"),
				JSON.stringify({
					version: 1,
					alerts: [
						valid,
						{ id: "bad", type: "unknown-type" },
						{ nope: true },
						null,
						sampleAlert({ id: "good2", type: "error" }),
					],
				}),
			);
			const store = new AlertStore(dir);
			const loaded = await store.load();
			expect(loaded.map((a) => a.id)).toEqual(["good", "good2"]);
		});
	});

	test("v1→v2 migration: pre-existing alerts load as seen=true", async () => {
		await withTempDir(async (dir) => {
			writeFileSync(
				join(dir, "alerts.json"),
				JSON.stringify({
					version: 1,
					alerts: [
						// Intentionally strip `seen` — v1 schema did not include it.
						{ ...sampleAlert({ id: "a1" }), seen: undefined },
						{ ...sampleAlert({ id: "a2", type: "error" }), seen: undefined },
					],
				}),
			);
			const store = new AlertStore(dir);
			const loaded = await store.load();
			expect(loaded).toHaveLength(2);
			expect(loaded.every((a) => a.seen === true)).toBe(true);

			// Next save writes v2 shape.
			await store.save(loaded);
			const raw = await Bun.file(join(dir, "alerts.json")).json();
			expect(raw.version).toBe(2);
		});
	});

	test("seen field round-trips through save → load", async () => {
		await withTempDir(async (dir) => {
			const store = new AlertStore(dir);
			const alerts = [
				sampleAlert({ id: "unseen", seen: false }),
				sampleAlert({ id: "seen", seen: true }),
			];
			await store.save(alerts);
			const loaded = await store.load();
			expect(loaded.find((a) => a.id === "unseen")?.seen).toBe(false);
			expect(loaded.find((a) => a.id === "seen")?.seen).toBe(true);
		});
	});

	test("load returns [] on malformed JSON", async () => {
		await withTempDir(async (dir) => {
			writeFileSync(join(dir, "alerts.json"), "{not valid json");
			const store = new AlertStore(dir);
			expect(await store.load()).toEqual([]);
		});
	});
});
