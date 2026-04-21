import { DEFAULT_CONFIG, NUMERIC_SETTING_META } from "../../../src/config-store";
import type { EffortLevel } from "../../../src/types";
import { expect, test } from "../harness/fixtures";
import { readConfigJson, selectAndSave, setAndSave } from "../helpers/config-actions";
import { ServerMessageObserver } from "../helpers/server-messages";
import { AppPage, ConfigPage } from "../pages";

test.use({ scenarioName: "config-all-inputs", autoMode: "manual" });
test.describe.configure({ timeout: 120_000 });

const MODEL_KEYS = Object.keys(DEFAULT_CONFIG.models) as Array<keyof typeof DEFAULT_CONFIG.models>;
const EFFORT_KEYS = Object.keys(DEFAULT_CONFIG.efforts) as Array<
	keyof typeof DEFAULT_CONFIG.efforts
>;
const PROMPT_KEYS_IN_UI = [
	"questionDetection",
	"reviewClassification",
	"activitySummarization",
	"specSummarization",
	"mergeConflictResolution",
	"ciFixInstruction",
	"epicDecomposition",
] as const;

const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

test.describe("every config input persists to disk", () => {
	test("all model text inputs round-trip", async ({ page, server, sandbox }) => {
		const observer = new ServerMessageObserver(page);
		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		const cfg = new ConfigPage(page);
		await cfg.goto(server.baseUrl);
		await cfg.root().waitFor();
		await cfg.activateTab("models");

		for (const key of MODEL_KEYS) {
			await setAndSave(observer, cfg.modelInput(key), `custom-${key}-model`);
		}

		const onDisk = await readConfigJson(sandbox.homeDir);
		const models = onDisk.models as Record<string, string>;
		for (const key of MODEL_KEYS) {
			expect(models[key]).toBe(`custom-${key}-model`);
		}
	});

	test("all effort selects round-trip", async ({ page, server, sandbox }) => {
		const observer = new ServerMessageObserver(page);
		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		const cfg = new ConfigPage(page);
		await cfg.goto(server.baseUrl);
		await cfg.root().waitFor();
		await cfg.activateTab("models");

		// Assign each field a different non-default level so off-by-one errors surface.
		const assignments = new Map<string, EffortLevel>();
		EFFORT_KEYS.forEach((key, i) => {
			const level = EFFORT_LEVELS[i % EFFORT_LEVELS.length];
			assignments.set(key, level);
		});

		for (const [key, level] of assignments) {
			await selectAndSave(observer, cfg.effortSelect(key), level);
		}

		const onDisk = await readConfigJson(sandbox.homeDir);
		const efforts = onDisk.efforts as Record<string, string>;
		for (const [key, level] of assignments) {
			expect(efforts[key]).toBe(level);
		}
	});

	test("all prompt textareas round-trip", async ({ page, server, sandbox }) => {
		const observer = new ServerMessageObserver(page);
		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		const cfg = new ConfigPage(page);
		await cfg.goto(server.baseUrl);
		await cfg.root().waitFor();
		await cfg.activateTab("prompts");

		// Include each prompt's required template variables so the save doesn't get
		// rejected (questionDetection requires ${text}, reviewClassification requires
		// ${reviewOutput}, etc. — we include the union in every value).
		const payloadFor = (key: string) =>
			`CUSTOM ${key} | \${text} \${reviewOutput} \${specification} \${ciLog} \${conflictFiles} \${epicDescription}`;

		for (const key of PROMPT_KEYS_IN_UI) {
			await setAndSave(observer, cfg.promptTextarea(key), payloadFor(key));
		}

		const onDisk = await readConfigJson(sandbox.homeDir);
		const prompts = onDisk.prompts as Record<string, string>;
		for (const key of PROMPT_KEYS_IN_UI) {
			expect(prompts[key]).toBe(payloadFor(key));
		}
	});

	test("all numeric limits + timings round-trip", async ({ page, server, sandbox }) => {
		const observer = new ServerMessageObserver(page);
		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		const cfg = new ConfigPage(page);
		await cfg.goto(server.baseUrl);
		await cfg.root().waitFor();

		for (const meta of NUMERIC_SETTING_META) {
			const [section, key] = meta.key.split(".") as ["limits" | "timing", string];
			await cfg.activateTab(section);
			// Use a value clearly above `min` and distinct from the default, so either
			// a silent floor-at-min or a silent-revert-to-default would be visible.
			const rawTarget = Math.max(meta.min, meta.defaultValue) + meta.min + 1;
			const input = page.locator(`input[data-cfg-path="${meta.key}"]`);

			if (meta.inputKind === "size" || meta.inputKind === "duration") {
				// Unit-aware inputs multiply the typed number by the selected unit's
				// factor (MB/GB or minutes/hours). Pin the unit to the smallest option
				// so we can compute the canonical value the commit will store.
				const smallestUnit = meta.inputKind === "size" ? "MB" : "minutes";
				const factor = meta.inputKind === "size" ? 1_048_576 : 60_000;
				const unitSelect = page.locator(`select[data-cfg-unit-for="${meta.key}"]`);
				if ((await unitSelect.inputValue()) !== smallestUnit) {
					const unitBroadcast = observer.waitFor((m) => m.type === "config:state");
					await unitSelect.selectOption(smallestUnit);
					await unitBroadcast;
				}
				const displayed = Math.ceil(rawTarget / factor);
				const canonical = displayed * factor;
				const broadcast = observer.waitFor((m) => m.type === "config:state");
				await input.fill(String(displayed));
				await input.dispatchEvent("change");
				await broadcast;

				const onDisk = await readConfigJson(sandbox.homeDir);
				const sectionObj = onDisk[section] as Record<string, number>;
				expect(sectionObj[key]).toBe(canonical);
				continue;
			}

			const broadcast = observer.waitFor((m) => m.type === "config:state");
			await input.fill(String(rawTarget));
			await input.dispatchEvent("change");
			await broadcast;

			const onDisk = await readConfigJson(sandbox.homeDir);
			const sectionObj = onDisk[section] as Record<string, number>;
			expect(sectionObj[key]).toBe(rawTarget);
		}
	});

	test("autoMode toggle persists and cycles through all three modes", async ({
		page,
		server,
		sandbox,
	}) => {
		const observer = new ServerMessageObserver(page);
		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		// Sandbox seeds autoMode: "manual" — cycle button advances manual → normal →
		// full-auto → manual. Verify each step writes through to disk.
		const expectedSequence: Array<"normal" | "full-auto" | "manual"> = [
			"normal",
			"full-auto",
			"manual",
		];
		const toggle = page.locator("#btn-auto-mode");
		for (const expected of expectedSequence) {
			const broadcast = observer.waitFor((m) => m.type === "config:state");
			await toggle.click();
			await broadcast;
			const onDisk = await readConfigJson(sandbox.homeDir);
			expect(onDisk.autoMode).toBe(expected);
		}
	});
});
