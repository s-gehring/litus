import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

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

// ── Config page tests (US1) ──────────────────────────────

describe("Config page", () => {
	let container: HTMLElement;
	let sendSpy: ReturnType<typeof mock>;

	beforeEach(() => {
		document.body.innerHTML = `<div id="app"><div id="app-content"></div></div>`;
		container = document.getElementById("app-content") as HTMLElement;
		sendSpy = mock(() => {});
	});

	afterEach(() => {
		document.body.innerHTML = "";
	});

	test("mount renders all config sections", async () => {
		const { createConfigPageHandler } = await import(
			"../../src/client/components/config-page"
		);
		const handler = createConfigPageHandler(sendSpy);

		handler.mount(container);

		const page = container.querySelector(".config-page") as HTMLElement;
		expect(page).toBeTruthy();

		// Should have Models, Limits, Timing, Prompts sections
		const sectionHeaders = page.querySelectorAll(".cfg-section-header");
		const headerTexts = Array.from(sectionHeaders).map((h) =>
			h.querySelector(".cfg-section-title")?.textContent?.trim(),
		);
		expect(headerTexts).toContain("Models");
		expect(headerTexts).toContain("Limits");
		expect(headerTexts).toContain("Timing");
		expect(headerTexts).toContain("Prompts");
	});

	test("mount renders Reset and Purge buttons", async () => {
		const { createConfigPageHandler } = await import(
			"../../src/client/components/config-page"
		);
		const handler = createConfigPageHandler(sendSpy);

		handler.mount(container);

		const resetBtn = container.querySelector(".cfg-reset-all-btn");
		expect(resetBtn).toBeTruthy();
		expect(resetBtn!.textContent).toContain("Reset");

		const purgeBtn = container.querySelector(".cfg-purge-btn");
		expect(purgeBtn).toBeTruthy();
		expect(purgeBtn!.textContent).toContain("Purge");
	});

	test("mount renders Back link", async () => {
		const { createConfigPageHandler } = await import(
			"../../src/client/components/config-page"
		);
		const handler = createConfigPageHandler(sendSpy);

		handler.mount(container);

		const backLink = container.querySelector(".config-page-back");
		expect(backLink).toBeTruthy();
		expect(backLink!.textContent).toContain("Back");
	});

	test("mount sends config:get", async () => {
		const { createConfigPageHandler } = await import(
			"../../src/client/components/config-page"
		);
		const handler = createConfigPageHandler(sendSpy);

		handler.mount(container);

		expect(sendSpy).toHaveBeenCalledWith({ type: "config:get" });
	});

	test("unmount removes config page from container", async () => {
		const { createConfigPageHandler } = await import(
			"../../src/client/components/config-page"
		);
		const handler = createConfigPageHandler(sendSpy);

		handler.mount(container);
		expect(container.querySelector(".config-page")).toBeTruthy();

		handler.unmount();
		expect(container.querySelector(".config-page")).toBeNull();
	});
});
