import { describe, expect, it } from "bun:test";
import { serverAutoModeFor, topBarAutoMode } from "../../../src/client/components/top-bar-model";

describe("topBarAutoMode", () => {
	it("collapses the server tri-state onto the bar's binary toggle", () => {
		expect(topBarAutoMode("manual")).toBe("manual");
		expect(topBarAutoMode("normal")).toBe("auto");
		expect(topBarAutoMode("full-auto")).toBe("auto");
	});
});

describe("serverAutoModeFor", () => {
	it("maps the bar's binary toggle back to a server enum value", () => {
		expect(serverAutoModeFor("manual")).toBe("manual");
		expect(serverAutoModeFor("auto")).toBe("normal");
	});

	it("round-trips manual unambiguously", () => {
		expect(topBarAutoMode(serverAutoModeFor("manual"))).toBe("manual");
		expect(topBarAutoMode(serverAutoModeFor("auto"))).toBe("auto");
	});

	it("full-auto is indistinguishable from normal after the round-trip (documented lossy collapse)", () => {
		// Intentional: the top bar UI has no 3rd option, so round-tripping
		// `full-auto` through the bar state downgrades to `normal`. Config page
		// retains the full tri-state surface.
		expect(serverAutoModeFor(topBarAutoMode("full-auto"))).toBe("normal");
	});
});
