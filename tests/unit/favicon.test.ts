import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetFaviconState, updateFavicon } from "../../src/client/components/favicon";

// Shared MockImage that fires onload synchronously via microtask
class MockImage extends EventTarget {
	width = 64;
	height = 64;
	_src = "";
	onload: (() => void) | null = null;
	onerror: ((e: unknown) => void) | null = null;

	get src() {
		return this._src;
	}
	set src(val: string) {
		this._src = val;
		queueMicrotask(() => {
			if (this.onload) this.onload();
		});
	}
}

describe("favicon", () => {
	let arcCalls: unknown[][];
	let drawImageCalls: unknown[][];
	let fakeDataURL: string;
	let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
	let originalToDataURL: typeof HTMLCanvasElement.prototype.toDataURL;
	let OriginalImage: typeof Image;

	beforeEach(() => {
		resetFaviconState();

		fakeDataURL = "data:image/png;base64,fakefavicon";
		arcCalls = [];
		drawImageCalls = [];

		const fakeCtx = {
			drawImage: (...args: unknown[]) => {
				drawImageCalls.push(args);
			},
			beginPath: () => {},
			arc: (...args: unknown[]) => {
				arcCalls.push(args);
			},
			fill: () => {},
			fillStyle: "",
		};

		originalGetContext = HTMLCanvasElement.prototype.getContext;
		originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
		HTMLCanvasElement.prototype.getContext = (() =>
			fakeCtx) as unknown as typeof HTMLCanvasElement.prototype.getContext;
		HTMLCanvasElement.prototype.toDataURL = () => fakeDataURL;

		OriginalImage = globalThis.Image;
		globalThis.Image = MockImage as unknown as typeof Image;

		// Set up a favicon link element in head (matching index.html)
		document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/logo.svg">';
		document.body.innerHTML = "";
	});

	afterEach(() => {
		HTMLCanvasElement.prototype.getContext = originalGetContext;
		HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
		globalThis.Image = OriginalImage;
		document.head.innerHTML = "";
		document.body.innerHTML = "";
	});

	// T015: updateFavicon(true) updates link href with attention indicator
	test("updateFavicon(true) updates link href when logo loads", async () => {
		updateFavicon(true);
		await new Promise((r) => setTimeout(r, 10));

		const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
		expect(link).not.toBeNull();
		expect(link?.type).toBe("image/png");
		expect(link?.href).toContain(fakeDataURL);

		// arc should have been called (attention dot)
		expect(arcCalls.length).toBeGreaterThan(0);
		expect(drawImageCalls.length).toBeGreaterThan(0);
	});

	// T017: updateFavicon(false) reverts favicon without attention dot
	test("updateFavicon(false) updates link href without attention dot", async () => {
		updateFavicon(false);
		await new Promise((r) => setTimeout(r, 10));

		const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
		expect(link).not.toBeNull();
		expect(link?.href).toContain(fakeDataURL);

		// No arc calls — no attention dot for false
		expect(arcCalls.length).toBe(0);
		// But drawImage should have been called (logo drawn)
		expect(drawImageCalls.length).toBeGreaterThan(0);
	});

	// T016: State deduplication — second call with same value produces no extra draws
	test("updateFavicon(true) then same value deduplicates (no extra draw calls)", async () => {
		updateFavicon(true);
		await new Promise((r) => setTimeout(r, 10));

		const callsAfterFirst = drawImageCalls.length;

		// Second call with same value — dedup
		updateFavicon(true);
		await new Promise((r) => setTimeout(r, 10));

		expect(drawImageCalls.length).toBe(callsAfterFirst);
	});

	test("updateFavicon alternating values does not skip (no dedup)", async () => {
		updateFavicon(true);
		await new Promise((r) => setTimeout(r, 10));
		const callsAfterFirst = drawImageCalls.length;

		updateFavicon(false);
		await new Promise((r) => setTimeout(r, 10));

		// Second call with different value should produce additional draws
		expect(drawImageCalls.length).toBeGreaterThan(callsAfterFirst);
	});

	// T018: Initial state transition from null to false
	test("initial updateFavicon(false) transitions from null state", async () => {
		updateFavicon(false);
		await new Promise((r) => setTimeout(r, 10));

		// null !== false, so it passes dedup gate and draws
		expect(drawImageCalls.length).toBeGreaterThan(0);
		expect(arcCalls.length).toBe(0); // no attention dot
	});

	test("updateFavicon(false) then updateFavicon(false) deduplicates", async () => {
		updateFavicon(false);
		await new Promise((r) => setTimeout(r, 10));
		const callsAfterFirst = drawImageCalls.length;

		updateFavicon(false);
		await new Promise((r) => setTimeout(r, 10));

		// Second call exits early due to deduplication
		expect(drawImageCalls.length).toBe(callsAfterFirst);
	});
});
