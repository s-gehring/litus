import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// ── Dashboard route handler tests (US2) ──────────────────

describe("Dashboard route handler", () => {
	let appContent: HTMLElement;

	beforeEach(() => {
		// Set up the DOM structure matching index.html
		document.body.innerHTML = `
			<div id="app">
				<header></header>
				<div id="app-content">
					<div id="card-strip" class="card-strip"></div>
					<div id="welcome-area" class="welcome-area"></div>
					<div id="detail-area" class="workflow-window hidden"></div>
				</div>
			</div>
		`;
		appContent = document.getElementById("app-content") as HTMLElement;
	});

	afterEach(() => {
		document.body.innerHTML = "";
	});

	test("mount shows dashboard elements", async () => {
		const { createDashboardHandler } = await import("../../src/client/app");
		const handler = createDashboardHandler();

		// Hide elements first (simulating coming from another route)
		document.getElementById("card-strip")!.classList.add("hidden");
		document.getElementById("welcome-area")!.classList.add("hidden");
		document.getElementById("detail-area")!.classList.add("hidden");

		handler.mount(appContent);

		expect(document.getElementById("card-strip")!.classList.contains("hidden")).toBe(false);
		expect(document.getElementById("welcome-area")!.classList.contains("hidden")).toBe(false);
		// detail-area stays hidden until a workflow is expanded
	});

	test("unmount hides dashboard elements", async () => {
		const { createDashboardHandler } = await import("../../src/client/app");
		const handler = createDashboardHandler();

		handler.mount(appContent);
		handler.unmount();

		expect(document.getElementById("card-strip")!.classList.contains("hidden")).toBe(true);
		expect(document.getElementById("welcome-area")!.classList.contains("hidden")).toBe(true);
		expect(document.getElementById("detail-area")!.classList.contains("hidden")).toBe(true);
	});
});
