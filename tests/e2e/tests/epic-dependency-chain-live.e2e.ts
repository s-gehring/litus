import { expect, test } from "../harness/fixtures";
import { createEpic } from "../helpers/create-epic";
import { AppPage } from "../pages/app";
import { EpicTree } from "../pages/epic-tree";

// Duplicated from `epic-lifecycle.e2e.ts`; see that file for the full
// rationale. Summary: on Windows, cmd.exe's `%*` truncates the analyzer's
// multi-line `-p` prompt at the first newline, which drops
// `--output-format stream-json` from the argv the fake observes. Shortening
// `epicDecomposition` to a single line keeps the flag attached on Windows so
// the fake sees the stream-json path and emits the scripted analyzer entry
// instead of defaulting to text mode. `maxJsonRetries: 1` forces a fast-fail
// on parse errors rather than burning the test budget on retries.
const EPIC_E2E_CONFIG_OVERRIDES = {
	prompts: {
		epicDecomposition:
			"Decompose this epic into self-contained specs and return a JSON code block. Epic: ${epicDescription}",
	},
	limits: {
		maxJsonRetries: 1,
	},
} as const;

test.describe("Epic dependency chain (live unblock)", () => {
	test.use({
		scenarioName: "epic-dependency-chain-live",
		autoMode: "full-auto",
		configOverrides: EPIC_E2E_CONFIG_OVERRIDES,
	});

	test("live unblock on A merge", async ({ page, server, sandbox }) => {
		test.setTimeout(180_000);

		const app = new AppPage(page);
		const tree = new EpicTree(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await createEpic({
			page,
			description: "Ship spec A first, then spec B which depends on A.",
			repo: sandbox.targetRepo,
			start: true,
		});

		const aRow = tree.childRowByTitle("Spec A");
		const bRow = tree.childRowByTitle("Spec B");

		// Wait for decomposition to render both child rows before asserting on
		// status. A failed analyzer parse surfaces as "got 0, wanted 2" here
		// instead of the downstream status assertions catching it opaquely.
		await expect(tree.allChildRows()).toHaveCount(2, { timeout: 15_000 });
		await expect(aRow).toBeVisible();
		await expect(bRow).toBeVisible();

		// FR-007 — true single-tick read of B's card-status class. toHaveClass
		// would poll (5 s default) and could race A's pipeline completing
		// before the assertion resolves, masking a regression where B never
		// enters waiting-deps at all.
		const bClassSnapshot = await bRow.locator(".card-status").getAttribute("class");
		expect(bClassSnapshot).toMatch(/card-status-waiting-deps/);

		// FR-008 — A reaches completed via merged PR. 60 s ceiling keeps the
		// per-assertion budget sum under the 180 s outer setTimeout even if
		// several waits cluster near their caps.
		await expect(aRow.locator(".card-status")).toHaveClass(/card-status-completed/, {
			timeout: 60_000,
		});

		// FR-009 — B auto-transitions off waiting-deps after A completes.
		await expect(bRow.locator(".card-status")).not.toHaveClass(/card-status-waiting-deps/, {
			timeout: 30_000,
		});

		// FR-010 — B reaches completed.
		await expect(bRow.locator(".card-status")).toHaveClass(/card-status-completed/, {
			timeout: 60_000,
		});

		// FR-011 — aggregate counter.
		await expect(tree.epicNode()).toContainText(/\(2\/2 completed\)/, { timeout: 15_000 });
	});
});
