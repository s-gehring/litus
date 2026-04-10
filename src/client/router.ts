export interface RouteHandler {
	mount(container: HTMLElement): void;
	unmount(): void;
}

export interface NavigateOptions {
	replace?: boolean;
}

export class Router {
	private routes = new Map<string, RouteHandler>();
	private currentHandler: RouteHandler | null = null;
	private _currentPath: string | null = null;
	private container: HTMLElement;
	private fallbackPath: string;
	private popstateHandler: (() => void) | null = null;

	get currentPath(): string | null {
		return this._currentPath;
	}

	constructor(container: HTMLElement, fallbackPath = "/") {
		this.container = container;
		this.fallbackPath = fallbackPath;
	}

	register(path: string, handler: RouteHandler): void {
		if (!path.startsWith("/")) {
			throw new Error(`Route path must start with /: ${path}`);
		}
		if (this.routes.has(path)) {
			throw new Error(`Route already registered: ${path}`);
		}
		this.routes.set(path, handler);
	}

	navigate(path: string, opts?: NavigateOptions): void {
		let handler = this.routes.get(path);
		if (!handler) {
			path = this.fallbackPath;
			handler = this.routes.get(path);
		}
		if (!handler) return;

		// Skip if already on this path
		if (path === this._currentPath) return;

		// Unmount previous
		if (this.currentHandler) {
			this.currentHandler.unmount();
		}

		// Update history
		if (opts?.replace) {
			history.replaceState(null, "", path);
		} else {
			history.pushState(null, "", path);
		}

		// Mount new
		this._currentPath = path;
		this.currentHandler = handler;
		handler.mount(this.container);
	}

	start(): void {
		const path = this.getPathname();
		this.navigate(path, { replace: true });

		this.popstateHandler = () => {
			const newPath = this.getPathname();
			// Reset current path so navigate doesn't skip
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
		if (this.popstateHandler) {
			window.removeEventListener("popstate", this.popstateHandler);
			this.popstateHandler = null;
		}
	}
}
