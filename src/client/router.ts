import type { ServerMessage } from "../types";

export interface RouteMatch {
	params: Record<string, string>;
}

export interface RouteHandler {
	mount(container: HTMLElement, match: RouteMatch): void;
	unmount(): void;
	onMessage?(msg: ServerMessage): void;
}

export interface NavigateOptions {
	replace?: boolean;
}

interface ParsedRoute {
	pattern: string;
	segments: Array<{ kind: "literal"; value: string } | { kind: "param"; name: string }>;
	hasParams: boolean;
	handler: RouteHandler;
}

function normalizePath(path: string): string {
	if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
	return path;
}

function parsePattern(pattern: string): ParsedRoute["segments"] {
	if (pattern === "/") return [];
	const raw = pattern.slice(1).split("/");
	return raw.map((seg) =>
		seg.startsWith(":")
			? ({ kind: "param", name: seg.slice(1) } as const)
			: ({ kind: "literal", value: seg } as const),
	);
}

function matchRoute(route: ParsedRoute, path: string): RouteMatch | null {
	const normalized = normalizePath(path);
	if (normalized === "/") {
		return route.segments.length === 0 ? { params: {} } : null;
	}
	const parts = normalized.slice(1).split("/");
	if (parts.length !== route.segments.length) return null;
	const params: Record<string, string> = {};
	for (let i = 0; i < parts.length; i++) {
		const seg = route.segments[i];
		const part = parts[i];
		if (seg.kind === "literal") {
			if (seg.value !== part) return null;
		} else {
			if (part === "") return null;
			try {
				params[seg.name] = decodeURIComponent(part);
			} catch {
				params[seg.name] = part;
			}
		}
	}
	return { params };
}

export class Router {
	private routes: ParsedRoute[] = [];
	private currentHandler: RouteHandler | null = null;
	private _currentPath: string | null = null;
	private _currentMatch: RouteMatch | null = null;
	private container: HTMLElement;
	private fallbackPath: string;
	private popstateHandler: (() => void) | null = null;

	get currentPath(): string | null {
		return this._currentPath;
	}

	get currentMatch(): RouteMatch | null {
		return this._currentMatch;
	}

	/**
	 * @param container  The element route handlers mount their content into.
	 * @param fallbackPath  Path used when `navigate()` is called with an
	 * unresolved path. The route for this pattern must be registered before
	 * `start()` is called — otherwise `start()` throws. If you need a different
	 * default, register a handler for it first, then pass that path here.
	 */
	constructor(container: HTMLElement, fallbackPath = "/") {
		this.container = container;
		this.fallbackPath = fallbackPath;
	}

	/**
	 * Register a handler for a path pattern. Literal segments match verbatim;
	 * `:name` segments capture one URL segment into `match.params.name`. Throws
	 * if the pattern does not start with `/` or if it was already registered.
	 */
	register(pattern: string, handler: RouteHandler): void {
		if (!pattern.startsWith("/")) {
			throw new Error(`Route path must start with /: ${pattern}`);
		}
		if (this.routes.some((r) => r.pattern === pattern)) {
			throw new Error(`Route already registered: ${pattern}`);
		}
		const segments = parsePattern(pattern);
		const hasParams = segments.some((s) => s.kind === "param");
		this.routes.push({ pattern, segments, hasParams, handler });
	}

	/**
	 * Transition to `path`, unmounting the current handler and mounting the one
	 * whose pattern resolves the path (literal > parametric > fallback). Calling
	 * with the current path is a no-op. `opts.replace` swaps `pushState` for
	 * `replaceState` so the current history entry is overwritten.
	 *
	 * If `path` does not resolve to any registered route, the router falls back
	 * to `fallbackPath`. `start()` throws up-front when `fallbackPath` is not
	 * registered, so this method never silently drops a navigation in practice.
	 */
	navigate(path: string, opts?: NavigateOptions): void {
		const resolved = this.resolve(path);
		let targetPath: string;
		let route: ParsedRoute;
		let match: RouteMatch;

		if (resolved) {
			targetPath = normalizePath(path);
			route = resolved.route;
			match = resolved.match;
		} else {
			const fallback = this.resolve(this.fallbackPath);
			if (!fallback) return;
			targetPath = normalizePath(this.fallbackPath);
			route = fallback.route;
			match = fallback.match;
		}

		if (targetPath === this._currentPath) return;

		if (this.currentHandler) {
			this.currentHandler.unmount();
		}

		if (opts?.replace) {
			history.replaceState(null, "", targetPath + window.location.search + window.location.hash);
		} else {
			history.pushState(null, "", targetPath);
		}

		this._currentPath = targetPath;
		this._currentMatch = match;
		this.currentHandler = route.handler;
		route.handler.mount(this.container, match);
	}

	/**
	 * Forward a server message to the currently mounted handler's optional
	 * `onMessage` hook. Silently drops the message when no handler is mounted
	 * or the handler does not implement `onMessage`.
	 */
	forwardMessage(msg: ServerMessage): void {
		this.currentHandler?.onMessage?.(msg);
	}

	/**
	 * Resolve the current pathname, mount the matching handler, and subscribe
	 * to `popstate` so browser back/forward re-resolves against the same table.
	 * Throws if `fallbackPath` is not a registered route: that rule keeps
	 * `navigate()` from silently no-op-ing on unknown paths later.
	 */
	start(): void {
		if (!this.resolve(this.fallbackPath)) {
			throw new Error(
				`Router.start() called before fallbackPath was registered: ${this.fallbackPath}`,
			);
		}
		const path = this.getPathname();
		this.navigate(path, { replace: true });

		this.popstateHandler = () => {
			const newPath = this.getPathname();
			// Reset `_currentPath` so same-path popstate (e.g. manual history
			// manipulation that lands back on the current pathname) remounts the
			// handler instead of no-op-ing. Browser back/forward means
			// "re-enter this view", even when the path happens to match.
			this._currentPath = null;
			this.navigate(newPath, { replace: true });
		};
		window.addEventListener("popstate", this.popstateHandler);
	}

	/** Reads the current pathname. Protected for testability with happy-dom. */
	protected getPathname(): string {
		return window.location.pathname;
	}

	destroy(): void {
		if (this.currentHandler) {
			this.currentHandler.unmount();
			this.currentHandler = null;
		}
		this._currentPath = null;
		this._currentMatch = null;
		if (this.popstateHandler) {
			window.removeEventListener("popstate", this.popstateHandler);
			this.popstateHandler = null;
		}
	}

	private resolve(path: string): { route: ParsedRoute; match: RouteMatch } | null {
		// First pass: exact-literal routes (no params) — literal wins over parametric.
		for (const route of this.routes) {
			if (route.hasParams) continue;
			const match = matchRoute(route, path);
			if (match) return { route, match };
		}
		// Second pass: parametric routes in insertion order.
		for (const route of this.routes) {
			if (!route.hasParams) continue;
			const match = matchRoute(route, path);
			if (match) return { route, match };
		}
		return null;
	}
}
