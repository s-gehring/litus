import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../../src/config-store";
import { expect, test } from "../harness/fixtures";
import {
	expectConfigFieldValue,
	purgeAll,
	readConfigJson,
	reloadConfigPage,
	resetToDefaults,
	selectAndSave,
	setAndSave,
} from "../helpers/config-actions";
import { ServerMessageObserver } from "../helpers/server-messages";
import { AppPage, ConfigPage } from "../pages";

test.use({ scenarioName: "config-happy", autoMode: "manual" });
test.describe.configure({ timeout: 60_000 });

test.describe("config page edits persist across reloads", () => {
	test("edit model, effort, and prompt → reload → values persist", async ({
		page,
		server,
		sandbox,
	}) => {
		const observer = new ServerMessageObserver(page);

		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		const cfg = new ConfigPage(page);
		await cfg.goto(server.baseUrl);
		await cfg.root().waitFor();

		// Edit one model selector, one effort select, one prompt textarea. Each
		// helper waits for the server's `config:state` broadcast before returning.
		await cfg.activateTab("models");
		await setAndSave(observer, cfg.modelInput("questionDetection"), "custom-model-id");
		await selectAndSave(observer, cfg.effortSelect("questionDetection"), "high");

		await cfg.activateTab("prompts");
		await setAndSave(observer, cfg.promptTextarea("activitySummarization"), "CUSTOM: ${text}");

		// Reload — fresh WS, fresh config:get, form repopulated from disk.
		await reloadConfigPage(cfg);
		await cfg.activateTab("models");
		await expect(cfg.modelInput("questionDetection")).toHaveValue("custom-model-id");
		await expect(cfg.effortSelect("questionDetection")).toHaveValue("high");
		await cfg.activateTab("prompts");
		await expect(cfg.promptTextarea("activitySummarization")).toHaveValue("CUSTOM: ${text}");

		// On-disk ground truth.
		const onDisk = await readConfigJson(sandbox.homeDir);
		const models = onDisk.models as Record<string, string>;
		const efforts = onDisk.efforts as Record<string, string>;
		const prompts = onDisk.prompts as Record<string, string>;
		expect(models.questionDetection).toBe("custom-model-id");
		expect(efforts.questionDetection).toBe("high");
		expect(prompts.activitySummarization).toBe("CUSTOM: ${text}");
	});

	test("reset-to-defaults restores UI and on-disk defaults", async ({ page, server, sandbox }) => {
		const observer = new ServerMessageObserver(page);

		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		const cfg = new ConfigPage(page);
		await cfg.goto(server.baseUrl);
		await cfg.root().waitFor();

		// Make a change first so reset has something to undo.
		await cfg.activateTab("models");
		await setAndSave(observer, cfg.modelInput("questionDetection"), "before-reset");

		await resetToDefaults(cfg, observer);

		// The UI shows the default because `ConfigStore.get()` merges DEFAULT_CONFIG
		// with the saved (now-empty) overrides.
		await expectConfigFieldValue(
			page,
			"models.questionDetection",
			DEFAULT_CONFIG.models.questionDetection,
		);

		// Ground truth: reset writes `{}` to disk — no user-set overrides remain.
		const onDisk = await readConfigJson(sandbox.homeDir);
		const models = (onDisk.models ?? {}) as Record<string, string>;
		expect(models.questionDetection).toBeUndefined();
	});

	test("purge-all clears $HOME/.litus/workflows/", async ({ page, server, sandbox }) => {
		// Pre-seed workflows on disk AFTER server start. Purge reads from disk at
		// purge time, so it will pick up these entries even though the in-memory
		// workflow store never loaded them.
		const workflowsDir = join(sandbox.homeDir, ".litus", "workflows");
		await mkdir(workflowsDir, { recursive: true });
		const seededId = "seeded-workflow-1";
		await writeFile(
			join(workflowsDir, `${seededId}.json`),
			JSON.stringify({ id: seededId, status: "completed", steps: [] }),
			"utf8",
		);
		await writeFile(join(workflowsDir, "index.json"), JSON.stringify([seededId]), "utf8");

		// Also seed an epics.json — the purge handler wipes it too via
		// `deps.sharedEpicStore.removeAll()` and spec scenario 4 pins this down.
		await writeFile(
			join(sandbox.homeDir, ".litus", "workflows", "epics.json"),
			JSON.stringify([{ id: "seeded-epic", title: "x", workflows: [] }]),
			"utf8",
		);

		const observer = new ServerMessageObserver(page);

		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		const cfg = new ConfigPage(page);
		await cfg.goto(server.baseUrl);
		await cfg.root().waitFor();

		await purgeAll(cfg, observer);

		// On-disk ground truth: every .json payload is gone, including
		// index.json and epics.json — the actual `removeAll` guarantee.
		const after = await readdir(workflowsDir).catch(() => [] as string[]);
		const remainingJson = after.filter((f) => f.endsWith(".json"));
		expect(remainingJson).toHaveLength(0);
	});

	test("empty prompt save is rejected — on-disk config unchanged", async ({
		page,
		server,
		sandbox,
	}) => {
		const observer = new ServerMessageObserver(page);

		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		const cfg = new ConfigPage(page);
		await cfg.goto(server.baseUrl);
		await cfg.root().waitFor();

		// Establish a non-empty baseline so the assertion is not vacuously `{}`.
		await cfg.activateTab("prompts");
		const textarea = cfg.promptTextarea("activitySummarization");
		await setAndSave(observer, textarea, "BASELINE: ${text}");

		const baseline = JSON.stringify(await readConfigJson(sandbox.homeDir));

		// Clear to whitespace — ConfigStore.validate rejects empty/whitespace
		// prompt values, so the server responds with `config:error` instead of
		// `config:state`.
		const errorFrame = observer.waitFor((m) => m.type === "config:error");
		await textarea.fill("   ");
		await textarea.dispatchEvent("change");
		const err = (await errorFrame) as { errors?: Array<{ path: string; message: string }> };
		expect(Array.isArray(err.errors)).toBe(true);
		expect(err.errors?.some((e) => e.path === "prompts.activitySummarization")).toBe(true);

		const after = JSON.stringify(await readConfigJson(sandbox.homeDir));
		expect(after).toBe(baseline);
	});
});
