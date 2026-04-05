import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pickerSource = readFileSync(
	resolve(import.meta.dir, "../../src/client/components/folder-picker.ts"),
	"utf-8",
);

describe("folder-picker component contract", () => {
	test("exports createFolderPicker function", () => {
		expect(pickerSource).toContain("export function createFolderPicker(");
	});

	test("exports FolderPicker interface with element/getValue/setValue", () => {
		expect(pickerSource).toContain("export interface FolderPicker");
		expect(pickerSource).toContain("element: HTMLElement");
		expect(pickerSource).toContain("getValue: () => string");
		expect(pickerSource).toContain("setValue: (value: string) => void");
	});

	test("has default placeholder of ~/git", () => {
		expect(pickerSource).toContain('placeholder = "~/git"');
	});

	test("creates a browse button", () => {
		expect(pickerSource).toContain("Browse");
		expect(pickerSource).toContain("folder-picker-btn");
	});

	test("calls /api/browse-folder endpoint on browse click", () => {
		expect(pickerSource).toContain('fetch("/api/browse-folder")');
	});

	test("hides browse button on endpoint failure (graceful degradation)", () => {
		expect(pickerSource).toContain("endpointAvailable = false");
		expect(pickerSource).toContain('browseBtn.classList.add("hidden")');
	});

	test("disables button during browse request to prevent double-clicks", () => {
		expect(pickerSource).toContain("browseBtn.disabled = true");
		expect(pickerSource).toContain("browseBtn.disabled = false");
	});

	test("dispatches input event after path selection for form reactivity", () => {
		expect(pickerSource).toContain('new Event("input"');
		expect(pickerSource).toContain("bubbles: true");
	});

	test("getValue trims whitespace from input", () => {
		expect(pickerSource).toContain("input.value.trim()");
	});

	test("populates input when server returns a path", () => {
		expect(pickerSource).toContain("if (data.path)");
		expect(pickerSource).toContain("input.value = data.path");
	});

	test("handles non-ok response by hiding browse button", () => {
		expect(pickerSource).toContain("if (!res.ok)");
	});
});
