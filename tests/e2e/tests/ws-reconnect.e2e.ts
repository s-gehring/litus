import { expect, test } from "../harness/fixtures";
import { createSpecification, dropWebSocket, waitForStep } from "../helpers";
import { AlertsPage, AppPage, WorkflowCardPage } from "../pages";

// E2E coverage for the client reconnect loop: drop the active WebSocket mid-run
// (while the specify step is running under a scripted delay), then assert the
// UI observes the disconnected state, reconnects within 30 s, and re-hydrates
// workflow state, pipeline step indicators, card-strip selection, and the
// alert bell from the post-reconnect `workflow:list` broadcast plus a
// scripted post-reconnect `alert:created`.
test.use({ scenarioName: "ws-reconnect" });

test("ws-reconnect: UI recovers from a mid-run WebSocket drop", async ({
	page,
	server,
	sandbox,
}) => {
	test.setTimeout(120_000);

	const app = new AppPage(page);
	const card = new WorkflowCardPage(page);
	const alerts = new AlertsPage(page);

	await app.goto(server.baseUrl);
	await app.waitConnected();

	await createSpecification(app, {
		specification: "Exercise WebSocket reconnect resilience end-to-end.",
		repo: sandbox.targetRepo,
	});

	// AC-5: the drop must happen while specify is actually running, otherwise
	// the test wouldn't prove mid-run recovery. The scripted delayMs on the
	// first claude invocation parks the step in this state long enough to
	// issue the drop.
	await waitForStep(card, "specify", "running", { timeoutMs: 30_000 });

	// SC-004 requires that we observe a *fresh* post-reconnect `workflow:list`
	// broadcast. The client cache retains state across a drop, so asserting on
	// rendered state alone cannot distinguish "re-hydrated" from "stale". The
	// client bumps `document.body.dataset.workflowListRevision` each time
	// `handleMessage` sees a `workflow:list` — capture it before the drop and
	// assert it increments after reconnect.
	const revisionBeforeDrop = await page.evaluate(() =>
		Number(document.body.dataset.workflowListRevision ?? "0"),
	);

	const dropAt = Date.now();
	await dropWebSocket({ server });

	// FR-005 / AC-1: the client must surface the disconnected state within 10 s.
	await expect(
		page.locator("#connection-status.disconnected"),
		"connection-status did not transition to disconnected after drop",
	).toBeAttached({ timeout: 10_000 });

	// FR-006 / AC-3: within 30 s of the drop the client reconnects AND
	// re-hydrates workflow state, pipeline step indicators, and card-strip
	// selection from the post-reconnect `workflow:list` broadcast.
	// Subtract the elapsed-from-drop from the 30s budget so the inner timeout
	// is a true wall-clock bound (not a fresh 30s clock starting at assertion).
	const elapsedSinceDrop = Date.now() - dropAt;
	const remainingBudget = Math.max(0, 30_000 - elapsedSinceDrop);
	await expect(
		page.locator("#connection-status.connected"),
		`connection-status did not return to connected within 30 s of drop (remaining budget: ${remainingBudget}ms)`,
	).toBeAttached({ timeout: remainingBudget });

	// SC-004: the post-reconnect `workflow:list` broadcast MUST have been
	// received. Without this assertion, the test passes against cached state
	// and cannot detect a regression that suppresses the reconnect broadcast.
	await expect
		.poll(() => page.evaluate(() => Number(document.body.dataset.workflowListRevision ?? "0")), {
			message:
				"workflow:list revision did not advance after reconnect — post-reconnect broadcast was not received (SC-004 regression)",
			timeout: 10_000,
		})
		.toBeGreaterThan(revisionBeforeDrop);

	// AC-5 post-condition: the 15s delay guarantees specify is still running at
	// reconnect time, so the subsequent rendered-state assertions corroborate
	// that the step didn't spuriously complete during the drop window. SC-004
	// re-hydration is covered by the revision counter above; these assertions
	// cannot independently distinguish cached from fresh state (the state
	// manager re-populates within one synchronous call and does not reset
	// expandedId on workflow:list).
	await waitForStep(card, "specify", "running", { timeoutMs: 10_000 });

	await expect(
		card.stepIndicator("specify"),
		"pipeline step indicator (specify) missing after reconnect",
	).toBeVisible({ timeout: 10_000 });

	await expect(
		app.cardStrip().locator(".workflow-card.card-expanded"),
		"card-strip selection missing after reconnect",
	).toHaveCount(1, { timeout: 10_000 });

	// FR-006: the top-level workflow-status surface must reflect the re-hydrated
	// "running" status. The revision counter above proves the broadcast landed;
	// this assertion names the workflow-state surface explicitly (SC-003).
	await expect(
		card.statusBadge(),
		"workflow-status badge did not re-render after reconnect (FR-006 regression: workflow state surface)",
	).toContainText(/running/i, { timeout: 10_000 });

	// FR-007 / AC-4: the scripted clarify failure fires AFTER reconnect (the
	// 15s specify delay ensures clarify starts post-reconnect) and surfaces as
	// an alert row in the bell panel — we verify identity, not just count, so
	// a spurious alert from elsewhere cannot mask a missing scripted one.
	await expect
		.poll(() => alerts.currentBellCount(), {
			message: "alert bell did not register post-reconnect alert:created",
			timeout: 30_000,
		})
		.toBeGreaterThan(0);

	await alerts.openList();
	await expect(
		alerts.listRows().first(),
		"alert bell row missing the scripted clarify failure text (FR-007 regression: post-reconnect alert:created not surfaced)",
	).toContainText(/Workflow error/i, { timeout: 5_000 });
});
