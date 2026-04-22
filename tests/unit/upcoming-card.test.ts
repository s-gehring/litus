import { afterEach, describe, expect, it } from "bun:test";
import { createUpcomingCard } from "../../src/client/components/run-screen/upcoming-card";

describe("upcoming-card", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("renders `Pipeline complete.` when the upcoming list is empty", () => {
		const { element } = createUpcomingCard([]);
		document.body.appendChild(element);
		expect(element.textContent).toContain("Pipeline complete.");
	});

	it("renders one mono bullet row per step with the arrow prefix", () => {
		const { element } = createUpcomingCard(["Plan", "Implement", "Commit"]);
		document.body.appendChild(element);
		// The body is the last child of the host (section label comes first).
		const body = element.lastElementChild as HTMLElement;
		expect(body.classList.contains("mono")).toBe(true);
		const rows = Array.from(body.querySelectorAll("div")).map((d) => d.textContent);
		expect(rows).toEqual(["→ Plan", "→ Implement", "→ Commit"]);
	});

	it("update replaces prior rows rather than appending", () => {
		const { element, update } = createUpcomingCard(["a", "b"]);
		document.body.appendChild(element);
		update(["c"]);
		// The body is the last child of the host (section label comes first).
		const body = element.lastElementChild as HTMLElement;
		expect(body.classList.contains("mono")).toBe(true);
		const rows = Array.from(body.querySelectorAll("div")).map((d) => d.textContent);
		expect(rows).toEqual(["→ c"]);
	});

	it("update back to empty returns the Pipeline-complete placeholder", () => {
		const { element, update } = createUpcomingCard(["a"]);
		document.body.appendChild(element);
		update([]);
		expect(element.textContent).toContain("Pipeline complete.");
	});
});
