import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { FolderPicker } from "../../src/client/components/folder-picker";
import { attachFolderValidation, probeFolder } from "../../src/client/folder-validation";

type FetchFn = typeof globalThis.fetch;
const originalFetch: FetchFn = globalThis.fetch;

function stubPicker(value: string): FolderPicker & { triggerBlur: (v: string) => void } {
	let blurHandler: ((v: string) => void) | null = null;
	const el = document.createElement("div");
	return {
		element: el,
		getValue: () => value,
		setValue: (v: string) => {
			value = v;
		},
		focus: () => {},
		onBlurValidate: (h) => {
			blurHandler = h;
		},
		triggerBlur: (v: string) => {
			if (blurHandler) blurHandler(v);
		},
	} as FolderPicker & { triggerBlur: (v: string) => void };
}

describe("folder-validation: submitCheck does not bail silently on hung probe", () => {
	let field: HTMLDivElement;

	beforeEach(() => {
		field = document.createElement("div");
		document.body.appendChild(field);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		field.remove();
	});

	test("probeFolder aborts a hung request via its internal timeout and surfaces a retry error", async () => {
		// Resolve only when the request is aborted — simulating a server that never answers.
		globalThis.fetch = ((_url: string, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(new DOMException("aborted", "AbortError"));
				});
			});
		}) as FetchFn;

		const result = await probeFolder("/some/path");
		expect(result).toBe("Could not validate folder — please try again.");
	}, 15000);

	test("submitCheck with an in-flight blur probe does not silently return false", async () => {
		// Probe timeout is ~5s; give the whole test a generous budget.
		// First call (the blur probe) hangs until aborted; second call (the submit probe)
		// resolves cleanly so we can assert submitCheck actually proceeded.
		let call = 0;
		globalThis.fetch = ((_url: string, init?: RequestInit) => {
			call++;
			if (call === 1) {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new DOMException("aborted", "AbortError"));
					});
				});
			}
			return Promise.resolve(
				new Response(JSON.stringify({ exists: true, usable: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		}) as FetchFn;

		const picker = stubPicker("/some/path");
		const validation = attachFolderValidation(picker, field);
		// Kick off a blur probe that will hang until its AbortController fires.
		picker.triggerBlur("/some/path");

		const ok = await validation.submitCheck();
		// Either the blur probe timed out (surfacing an error) or the submit probe
		// ran after it settled and returned a real answer. Crucially: not a silent false
		// from a simulated hung request — `ok` is true here because the submit-time
		// probe returned usable:true.
		expect(ok).toBe(true);
		expect(call).toBeGreaterThanOrEqual(2);
	}, 15000);
});
