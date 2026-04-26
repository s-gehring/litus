import { expect, test } from "../harness/fixtures";
import { purgeAll } from "../helpers/config-actions";
import { ServerMessageObserver } from "../helpers/server-messages";
import { AppPage, ConfigPage } from "../pages";

test.use({
	scenarioName: "purge-all",
	autoMode: "manual",
	purgeSeed: { workflows: 2, epics: 1 },
});

test.describe("purge-all", () => {
	test("success path: clears workflow cards, epic tree, and surfaces no warnings", async ({
		page,
		server,
	}) => {
		const observer = new ServerMessageObserver(page);
		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		// Confirm the seeded state actually reached the client — otherwise the
		// post-purge "emptied" assertion could pass vacuously. `3` = 2 seeded
		// workflows + 1 seeded epic (epics render as cards in #card-strip).
		await expect(app.workflowCards()).toHaveCount(3, { timeout: 10_000 });

		const cfg = new ConfigPage(page);
		await cfg.goto(server.baseUrl);
		await cfg.root().waitFor();

		// Register the progress waiter BEFORE kicking off the purge so we don't
		// miss the `purge:progress` broadcast (FR-008-analogue). `purgeAll`
		// internally waits for `purge:complete` — we only assert on receipt of
		// `purge:progress`, not on the overlay's live DOM state, because with a
		// minimal seeded sandbox the purge completes fast enough that the
		// overlay can hide between progress and complete.
		await purgeAll(cfg, observer);
		expect(observer.hasReceived((m) => m.type === "purge:progress")).toBe(true);

		// Client redirects to `/` on `purge:complete` — wait for the home view.
		await expect(page).toHaveURL(new RegExp(`${server.baseUrl}/?$`));

		// FR-013: workflow cards (including epics) all gone.
		await expect(app.workflowCards()).toHaveCount(0, { timeout: 10_000 });
		// FR-014: no error-class warnings in #output-log after a clean purge.
		await expect(cfg.outputLogErrorLines()).toHaveCount(0);
	});

	test.describe("failure sub-case (scripted purge:error)", () => {
		test.use({
			scenarioOverride: {
				purgeError: {
					message: "Scripted purge failure for e2e",
					warnings: ["Simulated warning: dangling worktree not cleaned"],
				},
			},
		});

		test("surfaces error message and warning list in #output-log", async ({ page, server }) => {
			const observer = new ServerMessageObserver(page);
			const app = new AppPage(page);
			await app.goto(server.baseUrl);
			await app.waitConnected();

			// Sanity: seed is visible before purge runs. 3 = 2 workflows + 1 epic.
			await expect(app.workflowCards()).toHaveCount(3, { timeout: 10_000 });

			const cfg = new ConfigPage(page);
			await cfg.goto(server.baseUrl);
			await cfg.root().waitFor();

			await purgeAll(cfg, observer, { expect: "error" });

			// purge:error does NOT auto-navigate — `#output-log` is part of the
			// SPA shell so it's addressable from the current route without a
			// full reload (which would wipe the accumulated log lines).
			// FR-015: `#output-log` contains error-class lines with both the
			// scripted message and the scripted warning.
			await expect(cfg.outputLogErrorLines()).toContainText([
				/Scripted purge failure for e2e/,
				/Simulated warning: dangling worktree/,
			]);
		});
	});
});
