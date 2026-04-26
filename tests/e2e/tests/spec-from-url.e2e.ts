import { expect, test } from "../harness/fixtures";
import { ServerMessageObserver } from "../helpers";
import { AppPage, SpecFormPage } from "../pages";

// US2 — spec-from-URL creation path. See `specs/001-creation-modal-e2e/tasks.md`
// (T023) for the deferred happy-tail scope. The non-github rejection below
// short-circuits in the server before any scripted fake is invoked, so we
// reuse the default `happy-path` scenario rather than duplicating it.
test.use({ autoMode: "manual" });

test.describe("spec from URL", () => {
	test("non-GitHub URL surfaces clone-error and no workflow is created", async ({
		page,
		server,
	}) => {
		test.setTimeout(30_000);

		const observer = new ServerMessageObserver(page);
		const app = new AppPage(page);
		await app.goto(server.baseUrl);
		await app.waitConnected();

		const form = new SpecFormPage(page);
		await app.newSpecButton().click();
		await expect(form.modal()).toBeVisible();

		// `looksLikeGitUrl` accepts any https/ssh/git@ URL, so the client routes
		// this through the URL-submission branch (sends `submissionId`). The
		// server's `parseGitHubUrl` rejects non-github hosts and replies with
		// `repo:clone-error` code `non-github-url` — the modal's clone handler
		// surfaces that message in `.modal-error`.
		await form.repoInput().fill("https://gitlab.com/foo/bar.git");
		await form.specificationInput().fill("Spec pointed at a non-GitHub host.");
		await form.submitButton().click();

		await expect(form.errorMessage()).toBeVisible({ timeout: 10_000 });
		await expect(form.errorMessage()).toContainText(/github/i);
		await expect(form.modal()).toBeVisible();

		// Modal stays open; no workflow card appears. Grace window for any
		// stray broadcast that would regress this contract.
		await page.waitForTimeout(1_000);
		expect(observer.hasReceived((m) => m.type === "workflow:created")).toBe(false);
		await expect(app.workflowCards()).toHaveCount(0);
	});
});
