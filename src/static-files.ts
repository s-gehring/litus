import { normalize, resolve } from "node:path";

const publicDir = resolve(process.cwd(), "public");

export { publicDir };

export function resolveStaticPath(pathname: string): string | null {
	// Normalize backslashes to forward slashes to prevent traversal on all platforms
	const sanitized = pathname.replaceAll("\\", "/");
	const filePath = sanitized === "/" ? "/index.html" : sanitized;
	const resolved = resolve(publicDir, `.${filePath}`);
	const normalized = normalize(resolved);
	if (!normalized.startsWith(publicDir)) return null;
	return normalized;
}

export function getMimeType(path: string): string {
	const lower = path.toLowerCase();
	if (lower.endsWith(".html")) return "text/html";
	if (lower.endsWith(".css")) return "text/css";
	if (lower.endsWith(".js")) return "application/javascript";
	if (lower.endsWith(".json")) return "application/json";
	if (lower.endsWith(".svg")) return "image/svg+xml";
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".ico")) return "image/x-icon";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".gif")) return "image/gif";
	if (lower.endsWith(".md")) return "text/markdown; charset=utf-8";
	if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
	if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "application/yaml; charset=utf-8";
	return "application/octet-stream";
}
