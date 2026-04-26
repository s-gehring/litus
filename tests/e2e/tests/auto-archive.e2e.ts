import { expect, test } from "../harness/fixtures";
import { AppPage } from "../pages";

test.use({
	scenarioName: "auto-archive",
	autoMode: "manual",
	autoArchiveSeed: { standaloneWorkflows: 2, epicWithChildren: 2 },
});

test.describe("auto-archive backlog cleanup", () => {
	test("hides backlogged terminal workflows + epic from the strip after the initial sweep", async ({
		page,
		server,
	}) => {
		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		// 4 seeded workflow JSONs (2 standalone + 2 epic children) and 1 seeded
		// epic, all with timestamps far in the past — well beyond the
		// auto-archive threshold. The auto-archiver runs an immediate sweep on
		// `start()` after restoring persisted state, so the strip should drain
		// to empty without further user action.
		await expect(app.workflowCards()).toHaveCount(0, { timeout: 15_000 });
	});
});
