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

	test("creates a dropdown for suggestions", () => {
		expect(pickerSource).toContain("folder-picker-dropdown");
	});

	test("calls /api/suggest-folders endpoint for suggestions", () => {
		expect(pickerSource).toContain("/api/suggest-folders");
	});

	test("supports keyboard navigation (ArrowDown/ArrowUp/Enter/Escape)", () => {
		expect(pickerSource).toContain("ArrowDown");
		expect(pickerSource).toContain("ArrowUp");
		expect(pickerSource).toContain("Escape");
	});

	test("dispatches input event after selection for form reactivity", () => {
		expect(pickerSource).toContain('new Event("input"');
		expect(pickerSource).toContain("bubbles: true");
	});

	test("getValue trims whitespace from input", () => {
		expect(pickerSource).toContain("input.value.trim()");
	});

	test("hides dropdown on blur", () => {
		expect(pickerSource).toContain("blur");
		expect(pickerSource).toContain("hideDropdown");
	});

	test("shows dropdown on focus when suggestions exist", () => {
		expect(pickerSource).toContain("focus");
		expect(pickerSource).toContain("showDropdown");
	});

	test("extracts parent directory from path for suggestions", () => {
		expect(pickerSource).toContain("getParentDir");
	});

	test("pre-fetches suggestions when setValue is called", () => {
		expect(pickerSource).toContain("fetchSuggestions");
	});
});
