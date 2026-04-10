import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RouteHandler } from "../../src/client/router";
import { Router } from "../../src/client/router";

// Minimal DOM container
function makeContainer(): HTMLElement {
	const el = document.createElement("div");
	el.id = "app-content";
	document.body.appendChild(el);
	return el;
}

// Stub route handler that tracks mount/unmount calls
function makeHandler(): RouteHandler & {
	mounted: number;
	unmounted: number;
	lastContainer: HTMLElement | null;
} {
	return {
		mounted: 0,
		unmounted: 0,
		lastContainer: null,
		mount(container: HTMLElement) {
			this.mounted++;
			this.lastContainer = container;
		},
		unmount() {
			this.unmounted++;
		},
	};
}

// Testable router subclass that lets us control the pathname
class TestRouter extends Router {
	private _testPathname = "/";

	setTestPathname(path: string) {
		this._testPathname = path;
	}

	// Override the private getPathname via prototype trick
	protected getPathname(): string {
		return this._testPathname;
	}
}

describe("Router", () => {
	let container: HTMLElement;
	let pushStateSpy: ReturnType<typeof mock>;
	let replaceStateSpy: ReturnType<typeof mock>;

	beforeEach(() => {
		container = makeContainer();

		pushStateSpy = mock(() => {});
		replaceStateSpy = mock(() => {});
		history.pushState = pushStateSpy as unknown as typeof history.pushState;
		history.replaceState = replaceStateSpy as unknown as typeof history.replaceState;
	});

	afterEach(() => {
		container.remove();
	});

	describe("register", () => {
		test("registers a route", () => {
			const router = new Router(container);
			const handler = makeHandler();
			router.register("/test", handler);
			// No error thrown = success
		});

		test("throws on duplicate path", () => {
			const router = new Router(container);
			const handler = makeHandler();
			router.register("/test", handler);
			expect(() => router.register("/test", makeHandler())).toThrow();
		});

		test("throws if path does not start with /", () => {
			const router = new Router(container);
			expect(() => router.register("test", makeHandler())).toThrow();
		});
	});

	describe("navigate", () => {
		test("mounts the matching handler", () => {
			const router = new Router(container);
			const handler = makeHandler();
			router.register("/page", handler);
			router.navigate("/page");
			expect(handler.mounted).toBe(1);
			expect(handler.lastContainer).toBe(container);
		});

		test("calls pushState", () => {
			const router = new Router(container);
			router.register("/page", makeHandler());
			router.navigate("/page");
			expect(pushStateSpy).toHaveBeenCalledWith(null, "", "/page");
		});

		test("uses replaceState when replace option is true", () => {
			const router = new Router(container);
			router.register("/page", makeHandler());
			router.navigate("/page", { replace: true });
			expect(replaceStateSpy).toHaveBeenCalledWith(null, "", "/page");
			expect(pushStateSpy).not.toHaveBeenCalled();
		});

		test("unmounts previous handler before mounting new one", () => {
			const router = new Router(container);
			const handlerA = makeHandler();
			const handlerB = makeHandler();
			router.register("/a", handlerA);
			router.register("/b", handlerB);

			router.navigate("/a");
			expect(handlerA.mounted).toBe(1);

			router.navigate("/b");
			expect(handlerA.unmounted).toBe(1);
			expect(handlerB.mounted).toBe(1);
		});

		test("navigates to fallback for unknown routes", () => {
			const router = new Router(container, "/");
			const dashHandler = makeHandler();
			router.register("/", dashHandler);
			router.navigate("/nonexistent");
			expect(dashHandler.mounted).toBe(1);
		});

		test("does not re-mount if navigating to current path", () => {
			const router = new Router(container);
			const handler = makeHandler();
			router.register("/page", handler);
			router.navigate("/page");
			router.navigate("/page");
			expect(handler.mounted).toBe(1);
			expect(handler.unmounted).toBe(0);
		});

		test("updates currentPath", () => {
			const router = new Router(container);
			router.register("/page", makeHandler());
			expect(router.currentPath).toBeNull();
			router.navigate("/page");
			expect(router.currentPath).toBe("/page");
		});
	});

	describe("start", () => {
		test("mounts route matching current URL", () => {
			const router = new TestRouter(container);
			router.setTestPathname("/page");
			const handler = makeHandler();
			router.register("/page", handler);
			router.start();
			expect(handler.mounted).toBe(1);
		});

		test("uses replaceState (no duplicate history entry)", () => {
			const router = new TestRouter(container);
			router.setTestPathname("/page");
			router.register("/page", makeHandler());
			router.start();
			expect(replaceStateSpy).toHaveBeenCalled();
			expect(pushStateSpy).not.toHaveBeenCalled();
		});

		test("falls back to fallbackPath for unknown initial URL", () => {
			const router = new TestRouter(container, "/");
			router.setTestPathname("/unknown");
			const dashHandler = makeHandler();
			router.register("/", dashHandler);
			router.start();
			expect(dashHandler.mounted).toBe(1);
		});
	});

	describe("popstate", () => {
		test("mounts correct handler on popstate event", () => {
			const router = new TestRouter(container);
			const handlerA = makeHandler();
			const handlerB = makeHandler();
			router.register("/a", handlerA);
			router.register("/b", handlerB);

			// start() attaches popstate listener
			router.setTestPathname("/a");
			router.start();
			expect(handlerA.mounted).toBe(1);

			router.navigate("/b");
			expect(handlerA.unmounted).toBe(1);
			expect(handlerB.mounted).toBe(1);

			// Simulate browser back to /a
			router.setTestPathname("/a");
			window.dispatchEvent(new PopStateEvent("popstate"));

			expect(handlerB.unmounted).toBe(1);
			expect(handlerA.mounted).toBe(2); // once from start, once from popstate
		});
	});

	describe("destroy", () => {
		test("unmounts current handler", () => {
			const router = new Router(container);
			const handler = makeHandler();
			router.register("/page", handler);
			router.navigate("/page");
			router.destroy();
			expect(handler.unmounted).toBe(1);
		});

		test("resets currentPath to null", () => {
			const router = new Router(container);
			router.register("/page", makeHandler());
			router.navigate("/page");
			router.destroy();
			expect(router.currentPath).toBeNull();
		});

		test("removes popstate listener", () => {
			const router = new TestRouter(container);
			const handler = makeHandler();
			const otherHandler = makeHandler();
			router.register("/", otherHandler);
			router.register("/page", handler);

			// start() attaches popstate listener
			router.setTestPathname("/");
			router.start();
			router.navigate("/page");
			expect(handler.mounted).toBe(1);

			router.destroy();
			expect(handler.unmounted).toBe(1);

			// Simulate popstate — handler should NOT be re-mounted
			router.setTestPathname("/page");
			window.dispatchEvent(new PopStateEvent("popstate"));

			// If listener is removed, no additional mount
			expect(handler.mounted).toBe(1);
		});
	});
});
