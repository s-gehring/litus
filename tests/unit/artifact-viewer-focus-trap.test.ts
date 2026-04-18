// Relies on Bun's built-in happy-dom DOM shim; the openArtifactViewer builds
// real DOM and installs a document-level keydown listener used to trap focus.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openArtifactViewer } from "../../src/client/components/artifact-viewer";
import type { ArtifactDescriptor } from "../../src/types";

const descriptor: ArtifactDescriptor = {
	id: "a_test",
	step: "specify",
	displayLabel: "spec.md",
	affordanceLabel: "View spec",
	relPath: "spec.md",
	sizeBytes: 1,
	lastModified: new Date().toISOString(),
	exists: true,
	runOrdinal: null,
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
	// Prevent the viewer's content fetch from populating the DOM during the
	// keyboard-behaviour tests — keep a pending promise so the body stays
	// "Loading…" and tabbable elements are stable.
	globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
	document.body.innerHTML = "";
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	document.body.innerHTML = "";
	document.body.className = "";
});

function press(key: string, opts: { shiftKey?: boolean } = {}): void {
	const ev = new KeyboardEvent("keydown", {
		key,
		bubbles: true,
		cancelable: true,
		shiftKey: opts.shiftKey ?? false,
	});
	document.dispatchEvent(ev);
}

describe("artifact-viewer focus trap (T017)", () => {
	test("Tab from last focusable element cycles back to the first", () => {
		const trigger = document.createElement("button");
		document.body.appendChild(trigger);
		openArtifactViewer({ workflowId: "wf-1", descriptor, triggerEl: trigger });

		const dialog = document.querySelector<HTMLElement>(".artifact-modal");
		if (!dialog) throw new Error("dialog not rendered");
		const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("a[href], button"));
		expect(focusable.length).toBeGreaterThanOrEqual(2);
		const first = focusable[0];
		const last = focusable[focusable.length - 1];

		last.focus();
		expect(document.activeElement).toBe(last);
		press("Tab");
		expect(dialog.contains(document.activeElement)).toBe(true);
		expect(document.activeElement).toBe(first);
	});

	test("Shift+Tab from first focusable element cycles to the last", () => {
		const trigger = document.createElement("button");
		document.body.appendChild(trigger);
		openArtifactViewer({ workflowId: "wf-1", descriptor, triggerEl: trigger });

		const dialog = document.querySelector<HTMLElement>(".artifact-modal");
		if (!dialog) throw new Error("dialog not rendered");
		const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("a[href], button"));
		const first = focusable[0];
		const last = focusable[focusable.length - 1];

		first.focus();
		press("Tab", { shiftKey: true });
		expect(document.activeElement).toBe(last);
	});

	test("Escape closes the modal and returns focus to trigger", () => {
		const trigger = document.createElement("button");
		document.body.appendChild(trigger);
		openArtifactViewer({ workflowId: "wf-1", descriptor, triggerEl: trigger });
		expect(document.querySelector(".artifact-modal")).not.toBeNull();
		press("Escape");
		expect(document.querySelector(".artifact-modal")).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});
});
