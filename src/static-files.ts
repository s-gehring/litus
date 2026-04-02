import { normalize, resolve } from "node:path";

const publicDir = resolve(process.cwd(), "public");

export { publicDir };

export function resolveStaticPath(pathname: string): string | null {
	const filePath = pathname === "/" ? "/index.html" : pathname;
	const resolved = resolve(publicDir, `.${filePath}`);
	const normalized = normalize(resolved);
	if (!normalized.startsWith(publicDir)) return null;
	return normalized;
}

export function getMimeType(path: string): string {
	if (path.endsWith(".html")) return "text/html";
	if (path.endsWith(".css")) return "text/css";
	if (path.endsWith(".js")) return "application/javascript";
	if (path.endsWith(".json")) return "application/json";
	if (path.endsWith(".svg")) return "image/svg+xml";
	if (path.endsWith(".png")) return "image/png";
	if (path.endsWith(".ico")) return "image/x-icon";
	return "application/octet-stream";
}
