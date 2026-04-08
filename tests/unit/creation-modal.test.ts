import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const modalSource = readFileSync(
	resolve(import.meta.dir, "../../src/client/components/creation-modal.ts"),
	"utf-8",
);

describe("creation-modal component contract", () => {
	test("exports createModal function", () => {
		expect(modalSource).toContain("export function createModal(");
	});

	test("exports Modal interface with show/hide/element", () => {
		expect(modalSource).toContain("export interface Modal");
		expect(modalSource).toContain("show: () => void");
		expect(modalSource).toContain("hide: () => void");
		expect(modalSource).toContain("element: HTMLElement");
	});

	test("sets ARIA attributes for accessibility", () => {
		expect(modalSource).toContain('role", "dialog"');
		expect(modalSource).toContain('aria-modal", "true"');
		expect(modalSource).toContain("aria-label");
	});

	test("implements focus trap with Tab key cycling", () => {
		expect(modalSource).toContain('"Tab"');
		expect(modalSource).toContain("e.shiftKey");
		expect(modalSource).toContain("first.focus()");
		expect(modalSource).toContain("last.focus()");
	});

	test("implements Escape key to close", () => {
		expect(modalSource).toContain('"Escape"');
		expect(modalSource).toContain("hide()");
	});

	test("implements click-outside-to-close on overlay", () => {
		expect(modalSource).toContain("mousedown");
		expect(modalSource).toContain("mouseup");
		expect(modalSource).toContain("mousedownOnOverlay");
	});

	test("enforces only one modal at a time", () => {
		expect(modalSource).toContain("activeModal");
		expect(modalSource).toContain("if (activeModal) activeModal.hide()");
	});

	test("cleans up keydown listener on hide", () => {
		expect(modalSource).toContain("document.removeEventListener");
	});

	test("has transition fallback timeout to prevent orphaned overlays", () => {
		expect(modalSource).toContain("transitionend");
		expect(modalSource).toContain("setTimeout");
		expect(modalSource).toContain("300");
	});

	test("focuses first focusable element on show", () => {
		expect(modalSource).toContain("first.focus()");
		// Uses requestAnimationFrame for focus timing
		expect(modalSource).toContain("requestAnimationFrame");
	});

	test("modal-visible class is toggled for CSS transitions", () => {
		expect(modalSource).toContain("modal-visible");
		expect(modalSource).toContain('classList.add("modal-visible")');
		expect(modalSource).toContain('classList.remove("modal-visible")');
	});
});
