import { afterEach, describe, expect, it } from "bun:test";
import { mountAmbientBackground } from "../../src/client/components/ambient-background";

describe("ambient-background", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("mounts a single host element under the parent", () => {
		mountAmbientBackground(document.body);
		const hosts = document.querySelectorAll("#litus-ambient-bg");
		expect(hosts.length).toBe(1);
	});

	it("re-invocation is a no-op (does not duplicate)", () => {
		mountAmbientBackground(document.body);
		mountAmbientBackground(document.body);
		mountAmbientBackground(document.body);
		expect(document.querySelectorAll("#litus-ambient-bg").length).toBe(1);
	});

	it("survives a simulated route change that swaps siblings", () => {
		mountAmbientBackground(document.body);
		const detail = document.createElement("div");
		detail.id = "detail-area";
		document.body.appendChild(detail);
		// Simulate the router swapping the detail region's contents.
		detail.innerHTML = "<div>view A</div>";
		detail.innerHTML = "<div>view B</div>";
		expect(document.getElementById("litus-ambient-bg")).not.toBeNull();
	});

	it("renders three radial-gradient blob layers + base fill + svg overlay", () => {
		mountAmbientBackground(document.body);
		const host = document.getElementById("litus-ambient-bg");
		expect(host).not.toBeNull();
		const divs = host?.querySelectorAll(":scope > div") ?? [];
		// 1 base fill + 3 blobs
		expect(divs.length).toBe(4);
		expect(host?.querySelector(":scope > svg")).not.toBeNull();
	});
});
