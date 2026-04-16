import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AlertStore } from "../../src/alert-store";
import { withTempDir } from "../test-infra";
import type { Alert } from "../../src/types";

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

	test("load returns [] on missing version", async () => {
		await withTempDir(async (dir) => {
			writeFileSync(
				join(dir, "alerts.json"),
				JSON.stringify({ alerts: [sampleAlert()] }),
			);
			const store = new AlertStore(dir);
			expect(await store.load()).toEqual([]);
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

	test("load returns [] on malformed JSON", async () => {
		await withTempDir(async (dir) => {
			writeFileSync(join(dir, "alerts.json"), "{not valid json");
			const store = new AlertStore(dir);
			expect(await store.load()).toEqual([]);
		});
	});
});
