import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appSource = readFileSync(resolve(import.meta.dir, "../../src/client/app.ts"), "utf-8");
const serverSource = readFileSync(resolve(import.meta.dir, "../../src/server.ts"), "utf-8");

describe("modal creation flow — spec modal", () => {
	test("openSpecModal creates a modal with title 'New Specification'", () => {
		expect(appSource).toContain('createModal("New Specification"');
	});

	test("spec modal has target repository field with folder picker", () => {
		expect(appSource).toContain('createFolderPicker("~/git")');
	});

	test("spec modal has a textarea for specification input", () => {
		expect(appSource).toContain('specInput.placeholder = "Describe the feature');
	});

	test("spec modal validates non-empty specification before submit", () => {
		expect(appSource).toContain("Specification is required");
	});

	test("spec modal sends workflow:start via WebSocket on submit", () => {
		expect(appSource).toContain('type: "workflow:start"');
	});

	test("spec modal supports Ctrl+Enter shortcut to submit", () => {
		expect(appSource).toContain("e.ctrlKey || e.metaKey");
	});

	test("spec modal pre-fills target repo from last workflow", () => {
		expect(appSource).toContain("repoPicker.setValue(getLastTargetRepo())");
	});

	test("spec modal does not use innerHTML for labels", () => {
		// openSpecModal should use createElement, not innerHTML
		const specModalSection = appSource.slice(
			appSource.indexOf("function openSpecModal"),
			appSource.indexOf("function openEpicModal"),
		);
		expect(specModalSection).not.toContain("innerHTML");
	});
});

describe("modal creation flow — epic modal", () => {
	test("openEpicModal creates a modal with title 'New Epic'", () => {
		expect(appSource).toContain('createModal("New Epic"');
	});

	test("epic modal validates minimum 10 character description", () => {
		expect(appSource).toContain("desc.length < 10");
		expect(appSource).toContain("Description must be at least 10 characters");
	});

	test("epic modal has two submit buttons: Create + Start and Create", () => {
		expect(appSource).toContain('"Create + Start"');
		expect(appSource).toContain('"Create"');
	});

	test("epic modal sends epic:start with autoStart flag", () => {
		expect(appSource).toContain('type: "epic:start"');
		expect(appSource).toContain("autoStart");
	});

	test("epic modal does not use innerHTML for labels", () => {
		const epicModalSection = appSource.slice(
			appSource.indexOf("function openEpicModal"),
			appSource.indexOf("// Wire up UI events"),
		);
		expect(epicModalSection).not.toContain("innerHTML");
	});
});

describe("header button wiring", () => {
	test("btn-new-spec wired to openSpecModal", () => {
		expect(appSource).toContain('"btn-new-spec"');
		expect(appSource).toContain("openSpecModal");
	});

	test("btn-new-epic wired to openEpicModal", () => {
		expect(appSource).toContain('"btn-new-epic"');
		expect(appSource).toContain("openEpicModal");
	});
});

describe("getLastTargetRepo logic", () => {
	test("function exists and returns a string", () => {
		expect(appSource).toContain("function getLastTargetRepo(): string");
	});

	test("returns empty string when no workflows have targetRepository", () => {
		expect(appSource).toContain('latest?.repo ?? ""');
	});
});

describe("server-side /api/browse-folder endpoint", () => {
	test("endpoint registered at /api/browse-folder", () => {
		expect(serverSource).toContain('url.pathname === "/api/browse-folder"');
	});

	test("endpoint only responds to GET requests", () => {
		expect(serverSource).toContain('req.method === "GET"');
	});

	test("returns JSON with path property on success", () => {
		expect(serverSource).toContain("Response.json({ path })");
	});

	test("returns HTTP 500 on error", () => {
		expect(serverSource).toContain("status: 500");
	});

	test("uses platform-specific folder picker commands", () => {
		expect(serverSource).toContain("process.platform");
		expect(serverSource).toContain("win32");
		expect(serverSource).toContain("darwin");
		expect(serverSource).toContain("FolderBrowserDialog");
		expect(serverSource).toContain("osascript");
		expect(serverSource).toContain("zenity");
	});

	test("handles user cancellation by returning null path", () => {
		expect(serverSource).toContain("CANCELLED");
		expect(serverSource).toContain("return null");
	});

	test("handles zenity cancel (exit code 1)", () => {
		expect(serverSource).toContain("exitCode === 1");
	});

	test("osascript uses multiple -e flags instead of multiline single arg", () => {
		const darwinSection = serverSource.slice(
			serverSource.indexOf('"darwin"'),
			serverSource.indexOf("zenity"),
		);
		// Count occurrences of "-e" — should be multiple separate flags
		const eFlags = darwinSection.match(/"-e"/g) || [];
		expect(eFlags.length).toBeGreaterThanOrEqual(4);
	});
});

describe("dead code removal", () => {
	test("epic-form.ts is not imported in app.ts", () => {
		expect(appSource).not.toContain("epic-form");
	});

	test("no references to removed #input-area elements", () => {
		expect(appSource).not.toContain("#input-area");
		expect(appSource).not.toContain("#specification");
		expect(appSource).not.toContain("#target-repo");
	});

	test("no references to removed #btn-start in app.ts", () => {
		expect(appSource).not.toContain("#btn-start");
	});
});
