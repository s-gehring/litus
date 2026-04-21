import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RouteHandler, RouteMatch } from "../../src/client/router";
import { Router } from "../../src/client/router";
import type { ServerMessage } from "../../src/types";

// Minimal DOM container
function makeContainer(): HTMLElement {
	const el = document.createElement("div");
	el.id = "app-content";
	document.body.appendChild(el);
	return el;
}

// Stub route handler that tracks mount/unmount calls and captures the match.
function makeHandler(): RouteHandler & {
	mounted: number;
	unmounted: number;
	lastContainer: HTMLElement | null;
	lastMatch: RouteMatch | null;
	messages: ServerMessage[];
} {
	return {
		mounted: 0,
		unmounted: 0,
		lastContainer: null,
		lastMatch: null,
		messages: [],
		mount(container: HTMLElement, match: RouteMatch) {
			this.mounted++;
			this.lastContainer = container;
			this.lastMatch = match;
		},
		unmount() {
			this.unmounted++;
		},
		onMessage(msg: ServerMessage) {
			this.messages.push(msg);
		},
	};
}

function makeSilentHandler(): RouteHandler & { mounted: number; unmounted: number } {
	return {
		mounted: 0,
		unmounted: 0,
		mount() {
			this.mounted++;
		},
		unmount() {
			this.unmounted++;
		},
		// no onMessage
	};
}

// Testable router subclass that lets us control the pathname
class TestRouter extends Router {
	private _testPathname = "/";

	setTestPathname(path: string) {
		this._testPathname = path;
	}

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
		test("registers a route without throwing", () => {
			const router = new Router(container);
			const handler = makeHandler();
			expect(() => router.register("/test", handler)).not.toThrow();
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
			expect(handler.lastMatch).toEqual({ params: {} });
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

	describe("parametric routes", () => {
		test("captures :id from /workflow/:id", () => {
			const router = new Router(container);
			const handler = makeHandler();
			router.register("/workflow/:id", handler);
			router.navigate("/workflow/abc123");
			expect(handler.mounted).toBe(1);
			expect(handler.lastMatch).toEqual({ params: { id: "abc123" } });
		});

		test("rejects /workflow/ (empty param)", () => {
			const router = new Router(container, "/");
			const fallback = makeHandler();
			const handler = makeHandler();
			router.register("/", fallback);
			router.register("/workflow/:id", handler);
			router.navigate("/workflow/");
			expect(fallback.mounted).toBe(1);
			expect(handler.mounted).toBe(0);
		});

		test("rejects /workflow/a/b (extra segment)", () => {
			const router = new Router(container, "/");
			const fallback = makeHandler();
			const handler = makeHandler();
			router.register("/", fallback);
			router.register("/workflow/:id", handler);
			router.navigate("/workflow/a/b");
			expect(fallback.mounted).toBe(1);
			expect(handler.mounted).toBe(0);
		});

		test("literal wins over parametric (even when registered after)", () => {
			const router = new Router(container);
			const paramHandler = makeHandler();
			const literalHandler = makeHandler();
			router.register("/workflow/:id", paramHandler);
			router.register("/workflow/new", literalHandler);

			router.navigate("/workflow/new");
			expect(literalHandler.mounted).toBe(1);
			expect(paramHandler.mounted).toBe(0);
		});

		test("insertion order within parametric class wins", () => {
			const router = new Router(container);
			const first = makeHandler();
			const second = makeHandler();
			router.register("/workflow/:id", first);
			router.register("/epic/:id", second);

			router.navigate("/workflow/abc");
			expect(first.mounted).toBe(1);
			expect(second.mounted).toBe(0);

			router.navigate("/epic/xyz");
			expect(second.mounted).toBe(1);
		});

		test("decodes percent-encoded params", () => {
			const router = new Router(container);
			const handler = makeHandler();
			router.register("/workflow/:id", handler);
			router.navigate("/workflow/abc%20def");
			expect(handler.lastMatch?.params.id).toBe("abc def");
		});

		test("rapid navigate → only one handler is mounted", () => {
			const router = new Router(container);
			const a = makeHandler();
			const b = makeHandler();
			const c = makeHandler();
			router.register("/a", a);
			router.register("/b", b);
			router.register("/c", c);
			router.navigate("/a");
			router.navigate("/b");
			router.navigate("/c");
			expect(a.unmounted).toBe(1);
			expect(b.mounted).toBe(1);
			expect(b.unmounted).toBe(1);
			expect(c.mounted).toBe(1);
			expect(c.unmounted).toBe(0);
		});

		test("currentMatch exposes the active params", () => {
			const router = new Router(container);
			router.register("/workflow/:id", makeHandler());
			router.navigate("/workflow/xyz");
			expect(router.currentMatch).toEqual({ params: { id: "xyz" } });
		});

		test("navigating between different params on the same pattern remounts", () => {
			const router = new Router(container);
			const handler = makeHandler();
			router.register("/workflow/:id", handler);
			router.navigate("/workflow/abc");
			router.navigate("/workflow/xyz");
			expect(handler.mounted).toBe(2);
			expect(handler.unmounted).toBe(1);
			expect(handler.lastMatch?.params.id).toBe("xyz");
		});
	});

	describe("forwardMessage", () => {
		test("dispatches to currentHandler.onMessage when defined", () => {
			const router = new Router(container);
			const handler = makeHandler();
			router.register("/page", handler);
			router.navigate("/page");

			const msg: ServerMessage = { type: "alert:list", alerts: [] };
			router.forwardMessage(msg);
			expect(handler.messages).toEqual([msg]);
		});

		test("no-op when current handler has no onMessage", () => {
			const router = new Router(container);
			const handler = makeSilentHandler();
			router.register("/page", handler);
			router.navigate("/page");

			expect(() => router.forwardMessage({ type: "alert:list", alerts: [] })).not.toThrow();
		});

		test("no-op when no handler is mounted", () => {
			const router = new Router(container);
			expect(() => router.forwardMessage({ type: "alert:list", alerts: [] })).not.toThrow();
		});
	});

	describe("start", () => {
		test("mounts route matching current URL", () => {
			const router = new TestRouter(container, "/page");
			router.setTestPathname("/page");
			const handler = makeHandler();
			router.register("/page", handler);
			router.start();
			expect(handler.mounted).toBe(1);
		});

		test("uses replaceState (no duplicate history entry)", () => {
			const router = new TestRouter(container, "/page");
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

		test("start mounts exactly one handler (no double-mount)", () => {
			const router = new TestRouter(container);
			router.setTestPathname("/workflow/abc");
			const wf = makeHandler();
			const dash = makeHandler();
			router.register("/", dash);
			router.register("/workflow/:id", wf);
			router.start();
			expect(wf.mounted).toBe(1);
			expect(dash.mounted).toBe(0);
		});
	});

	describe("popstate", () => {
		test("mounts correct handler on popstate event", () => {
			const router = new TestRouter(container, "/a");
			const handlerA = makeHandler();
			const handlerB = makeHandler();
			router.register("/a", handlerA);
			router.register("/b", handlerB);

			router.setTestPathname("/a");
			router.start();
			expect(handlerA.mounted).toBe(1);

			router.navigate("/b");
			expect(handlerA.unmounted).toBe(1);
			expect(handlerB.mounted).toBe(1);

			router.setTestPathname("/a");
			window.dispatchEvent(new PopStateEvent("popstate"));

			expect(handlerB.unmounted).toBe(1);
			expect(handlerA.mounted).toBe(2);
		});

		test("same-path popstate remounts the current handler", () => {
			// Contract: browser back/forward means "re-enter this view" even when
			// the pathname happens to match currentPath. navigate()'s normal
			// same-path no-op is intentionally bypassed for popstate by resetting
			// _currentPath inside the popstate handler.
			const router = new TestRouter(container, "/a");
			const handler = makeHandler();
			router.register("/a", handler);

			router.setTestPathname("/a");
			router.start();
			expect(handler.mounted).toBe(1);
			expect(handler.unmounted).toBe(0);

			// Pop back to the same path we are already on.
			router.setTestPathname("/a");
			window.dispatchEvent(new PopStateEvent("popstate"));

			expect(handler.unmounted).toBe(1);
			expect(handler.mounted).toBe(2);
		});
	});

	describe("start() fallback validation", () => {
		test("throws when fallbackPath is not registered", () => {
			const router = new TestRouter(container, "/");
			router.setTestPathname("/anything");
			expect(() => router.start()).toThrow(/fallbackPath/);
		});

		test("does not throw when the default fallbackPath is registered", () => {
			const router = new TestRouter(container, "/");
			router.register("/", makeHandler());
			router.setTestPathname("/");
			expect(() => router.start()).not.toThrow();
		});

		test("does not throw when a custom fallbackPath is registered", () => {
			const router = new TestRouter(container, "/home");
			router.register("/home", makeHandler());
			router.setTestPathname("/home");
			expect(() => router.start()).not.toThrow();
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

			router.setTestPathname("/");
			router.start();
			router.navigate("/page");
			expect(handler.mounted).toBe(1);

			router.destroy();
			expect(handler.unmounted).toBe(1);

			router.setTestPathname("/page");
			window.dispatchEvent(new PopStateEvent("popstate"));

			expect(handler.mounted).toBe(1);
		});
	});

	describe("setNavigateListener", () => {
		test("fires on every successful navigate with the target path", () => {
			const router = new Router(container);
			router.register("/a", makeHandler());
			router.register("/b", makeHandler());
			const calls: string[] = [];
			router.setNavigateListener((p) => calls.push(p));
			router.navigate("/a");
			router.navigate("/b");
			expect(calls).toEqual(["/a", "/b"]);
		});

		test("fires after mount (listener sees the new currentPath)", () => {
			const router = new Router(container);
			router.register("/a", makeHandler());
			const observed: Array<string | null> = [];
			router.setNavigateListener(() => {
				observed.push(router.currentPath);
			});
			router.navigate("/a");
			expect(observed).toEqual(["/a"]);
		});

		test("fires on start()'s initial replace-navigate", () => {
			const router = new TestRouter(container, "/page");
			router.setTestPathname("/page");
			router.register("/page", makeHandler());
			const calls: string[] = [];
			router.setNavigateListener((p) => calls.push(p));
			router.start();
			expect(calls).toEqual(["/page"]);
		});

		test("does not fire on same-path early-return", () => {
			const router = new Router(container);
			router.register("/a", makeHandler());
			router.navigate("/a");
			const calls: string[] = [];
			router.setNavigateListener((p) => calls.push(p));
			router.navigate("/a");
			expect(calls).toEqual([]);
		});

		test("second setNavigateListener call replaces the previous listener", () => {
			const router = new Router(container);
			router.register("/a", makeHandler());
			const first: string[] = [];
			const second: string[] = [];
			router.setNavigateListener((p) => first.push(p));
			router.setNavigateListener((p) => second.push(p));
			router.navigate("/a");
			expect(first).toEqual([]);
			expect(second).toEqual(["/a"]);
		});
	});

	describe("sibling non-interference (registration-after-boot)", () => {
		test("registering a new route does not mount or affect siblings", () => {
			const router = new Router(container);
			const a = makeHandler();
			const b = makeHandler();
			router.register("/a", a);
			router.register("/b", b);
			router.navigate("/a");

			const c = makeHandler();
			router.register("/c", c);

			expect(a.mounted).toBe(1);
			expect(a.unmounted).toBe(0);
			expect(b.mounted).toBe(0);
			expect(c.mounted).toBe(0);
		});
	});
});
