import { expect, test } from "../harness/fixtures";
import { createSpecification, waitForStep } from "../helpers";
import { AppPage, WorkflowCardPage } from "../pages";

// Regression coverage: when the CLI streams partial deltas AND then emits a
// final `assistant` message with the same cumulative text, the frontend
// output log must show that text exactly once — not twice as it did before
// (both the partial and the finalized message were being forwarded).
test.use({ scenarioName: "streaming-dedup", autoMode: "manual" });

test("streamed assistant text is not duplicated in the output log", async ({
	page,
	server,
	sandbox,
}) => {
	test.setTimeout(120_000);

	const app = new AppPage(page);
	await app.goto(server.baseUrl);
	await app.waitConnected();

	await createSpecification(app, {
		specification: "Add a dark mode toggle to the application settings.",
		repo: sandbox.targetRepo,
	});

	const card = new WorkflowCardPage(page);
	await waitForStep(card, "specify", "completed", { timeoutMs: 60_000 });
	// Wait until the pipeline advances past specify so all streamed output for
	// the specify step has been rendered into the log before we sample it.
	await waitForStep(card, "clarify", "waiting", { timeoutMs: 60_000 });

	const logContent = await page.evaluate(() => {
		const log = document.getElementById("output-log");
		if (!log) return "";
		return Array.from(log.querySelectorAll(".output-line"))
			.map((el) => el.textContent ?? "")
			.join("\n");
	});

	// Markers are unique and only appear in the streamed specify text — they
	// must appear once and only once even though the scenario emitted them
	// first as `content_block_delta` events and then in a finalized `assistant`
	// message.
	const countAaa = logContent.split("UNIQUE_STREAM_MARKER_AAA").length - 1;
	const countBbb = logContent.split("UNIQUE_STREAM_MARKER_BBB").length - 1;
	expect(countAaa, "AAA marker should appear exactly once in the output log").toBe(1);
	expect(countBbb, "BBB marker should appear exactly once in the output log").toBe(1);
});
