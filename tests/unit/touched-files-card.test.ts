import { afterEach, describe, expect, it } from "bun:test";
import { createTouchedFilesCard } from "../../src/client/components/run-screen/touched-files-card";

describe("touched-files-card", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("renders the empty-state placeholder when the file list is empty", () => {
		const { element } = createTouchedFilesCard([]);
		document.body.appendChild(element);
		expect(element.textContent).toContain("No files touched yet.");
	});

	it("replaces the empty state with rows on update", () => {
		const { element, update } = createTouchedFilesCard([]);
		document.body.appendChild(element);
		update([
			{ path: "src/a.ts", kind: "edit" },
			{ path: "src/b.ts", kind: "new" },
			{ path: "src/c.ts", kind: "read" },
		]);
		expect(element.textContent).not.toContain("No files touched");
		expect(element.textContent).toContain("src/a.ts");
		expect(element.textContent).toContain("src/b.ts");
		expect(element.textContent).toContain("src/c.ts");
	});

	it("renders distinct glyphs per kind (edit ✎ / new + / read ·)", () => {
		const { element } = createTouchedFilesCard([
			{ path: "x.ts", kind: "edit" },
			{ path: "y.ts", kind: "new" },
			{ path: "z.ts", kind: "read" },
		]);
		document.body.appendChild(element);
		expect(element.textContent).toContain("✎");
		expect(element.textContent).toContain("+");
		expect(element.textContent).toContain("·");
	});

	it("long paths get browser-driven middle-ellipsis via CSS text-overflow", () => {
		const longPath = "src/very/deeply/nested/directory/tree/structure/with/many/segments/file.ts";
		const { element } = createTouchedFilesCard([{ path: longPath, kind: "edit" }]);
		document.body.appendChild(element);
		// The path span is the flex-1 text holder — look it up by its full-path title.
		const span = Array.from(element.querySelectorAll("span")).find(
			(s) => (s as HTMLElement).title === longPath,
		) as HTMLElement | undefined;
		expect(span).toBeDefined();
		expect(span?.style.overflow).toBe("hidden");
		expect(span?.style.textOverflow).toBe("ellipsis");
		expect(span?.style.whiteSpace).toBe("nowrap");
		// Title carries the full path for hover tooltip (accessibility).
		expect(span?.textContent).toBe(longPath);
	});
});
