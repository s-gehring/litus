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
		expect(appSource).toContain("repoPicker.setValue(stateManager.getLastTargetRepo())");
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
	test("delegates to stateManager.getLastTargetRepo()", () => {
		expect(appSource).toContain("stateManager.getLastTargetRepo()");
	});
});

describe("folder validation: success indicator + git-repo check", () => {
	test("client maps not_a_git_repo response to a user-facing error", () => {
		expect(appSource).toContain('reason === "not_a_git_repo"');
		expect(appSource).toContain("Folder is not a git repository.");
	});

	test("FolderExistsResponse type includes not_a_git_repo reason", () => {
		expect(appSource).toContain("not_a_git_repo");
	});

	test("attachFolderValidation appends a success indicator element", () => {
		expect(appSource).toContain('"modal-field-success hidden"');
		// Checkmark glyph is the visible affordance — keep it stable for e2e selectors.
		expect(appSource).toContain("✓ Valid git repository");
	});

	test("server checks for .git presence in handleFolderExists", () => {
		expect(serverSource).toContain('reason: "not_a_git_repo"');
		expect(serverSource).toContain('".git"');
	});
});

describe("alert clear-all wiring", () => {
	test("client sends alert:clear-all when the panel button fires", () => {
		expect(appSource).toContain('type: "alert:clear-all"');
		expect(appSource).toContain("onClearAll");
	});

	test("server registers alert:clear-all handler", () => {
		expect(serverSource).toContain('router.register("alert:clear-all"');
		expect(serverSource).toContain("handleAlertClearAll");
	});
});

describe("server-side /api/suggest-folders endpoint", () => {
	test("endpoint registered at /api/suggest-folders", () => {
		expect(serverSource).toContain('url.pathname === "/api/suggest-folders"');
	});

	test("endpoint only responds to GET requests", () => {
		expect(serverSource).toContain('req.method === "GET"');
	});

	test("requires parent query parameter", () => {
		expect(serverSource).toContain('url.searchParams.get("parent")');
		expect(serverSource).toContain("parent parameter required");
	});

	test("returns HTTP 400 when parent is missing", () => {
		expect(serverSource).toContain("status: 400");
	});

	test("returns JSON with folders array", () => {
		expect(serverSource).toContain("Response.json({ folders })");
	});

	test("listSubdirectories reads directory entries", () => {
		expect(serverSource).toContain("readdirSync(parentDir)");
		expect(serverSource).toContain("isDirectory()");
	});

	test("skips hidden directories (dotfiles)", () => {
		expect(serverSource).toContain('entry.startsWith(".")');
	});

	test("sorts results alphabetically", () => {
		expect(serverSource).toContain("folders.sort");
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
