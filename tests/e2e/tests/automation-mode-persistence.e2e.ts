import { expect, test } from "../harness/fixtures";
import { restartServer } from "../helpers";
import { AppPage } from "../pages";

// US3 — automation-mode persistence. The sandbox seeds config.json with
// `autoMode: "normal"`, so the button starts with class `mode-normal`. One
// click through `AUTO_MODE_CYCLE = ["manual", "normal", "full-auto"]`
// advances to `full-auto`. The observable contract (FR-013) is the
// `mode-full-auto` CSS class on `#btn-auto-mode` — never an internal API.
test.use({ scenarioName: "happy-path", autoMode: "normal" });

test.describe("automation mode persistence", () => {
	test("toggling to full-auto is acked by the server", async ({ page, server }) => {
		test.setTimeout(60_000);

		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		// Starting from "normal", one click → "full-auto". `config:save` has no
		// server ack (research.md §3), so the DOM class transition is the
		// observable proxy: the class only flips after the server broadcasts
		// `config:loaded` back in response to the saved autoMode.
		await expect(app.autoModeButton()).toHaveClass(/\bmode-normal\b/);
		await app.autoModeButton().click();
		await expect(app.autoModeButton()).toHaveClass(/\bmode-full-auto\b/, { timeout: 10_000 });
	});

	test("full-auto survives a page reload", async ({ page, server }) => {
		test.setTimeout(60_000);

		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await app.autoModeButton().click();
		await expect(app.autoModeButton()).toHaveClass(/\bmode-full-auto\b/, { timeout: 10_000 });

		await page.reload();
		await app.waitConnected();
		await expect(app.autoModeButton()).toHaveClass(/\bmode-full-auto\b/, { timeout: 10_000 });
	});

	test("full-auto survives restartServer() + reload", async ({ page, server, sandbox }) => {
		test.setTimeout(60_000);

		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		await app.autoModeButton().click();
		await expect(app.autoModeButton()).toHaveClass(/\bmode-full-auto\b/, { timeout: 10_000 });

		await restartServer({ server, sandbox, page });
		await app.waitConnected();
		await expect(app.autoModeButton()).toHaveClass(/\bmode-full-auto\b/, { timeout: 15_000 });
	});
});
