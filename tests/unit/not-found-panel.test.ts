// Relies on Bun's built-in happy-dom DOM shim. Round-8 review #6: exercises
// the module-scope state (`panel`, `hiddenByPanel`) across repeated
// show/hide cycles in a single DOM — the E2E routing test cannot cover this
// because Playwright spawns a fresh page per test.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { hideNotFoundPanel, showNotFoundPanel } from "../../src/client/components/not-found-panel";

function mountHost(): void {
	document.body.innerHTML =
		'<div id="app-content"></div><div id="welcome-area"></div><div id="pipeline-steps"></div>';
}

describe("not-found-panel", () => {
	beforeEach(() => {
		mountHost();
	});

	afterEach(() => {
		hideNotFoundPanel();
		document.body.innerHTML = "";
	});

	test("renders a panel with kind-specific heading and message", () => {
		showNotFoundPanel("workflow", "wf_missing");
		const panel = document.querySelector('[data-testid="not-found"]');
		expect(panel).not.toBeNull();
		expect(panel?.querySelector(".not-found-heading")?.textContent).toBe("Workflow not found");
		expect(panel?.querySelector(".not-found-message")?.textContent).toContain(
			'No workflow with id "wf_missing"',
		);
	});

	test("hide restores welcome area visibility", () => {
		const welcome = document.getElementById("welcome-area");
		expect(welcome?.classList.contains("hidden")).toBe(false);
		showNotFoundPanel("epic", "ep_missing");
		expect(welcome?.classList.contains("hidden")).toBe(true);
		hideNotFoundPanel();
		expect(welcome?.classList.contains("hidden")).toBe(false);
		expect(document.querySelector('[data-testid="not-found"]')).toBeNull();
	});

	test("re-showing after hide does not leak state across cycles", () => {
		showNotFoundPanel("workflow", "a");
		hideNotFoundPanel();
		// Reset DOM to simulate a full re-mount (e.g., a test tearing down
		// and rebuilding the document). The module-scope `panel` reference
		// now points at a detached node from the previous cycle; the next
		// show must not crash on it and must render a fresh panel.
		mountHost();
		showNotFoundPanel("epic", "b");
		const panels = document.querySelectorAll('[data-testid="not-found"]');
		expect(panels.length).toBe(1);
		expect(panels[0]?.querySelector(".not-found-heading")?.textContent).toBe("Epic not found");
	});

	test("hide after DOM reset is idempotent (does not throw)", () => {
		showNotFoundPanel("workflow", "a");
		// Detach the panel via a DOM reset, then call hide. The `isConnected`
		// guard should make this a no-op rather than throwing.
		document.body.innerHTML = "";
		expect(() => hideNotFoundPanel()).not.toThrow();
	});
});
