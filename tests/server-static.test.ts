import { describe, test, expect } from "bun:test";
import { resolve, normalize } from "path";

// Test the path traversal prevention logic directly (extracted from server.ts)
const publicDir = resolve(process.cwd(), "public");

function resolveStaticPath(pathname: string): string | null {
  const filePath = pathname === "/" ? "/index.html" : pathname;
  const resolved = resolve(publicDir, "." + filePath);
  const normalized = normalize(resolved);
  if (!normalized.startsWith(publicDir)) return null;
  return normalized;
}

describe("resolveStaticPath (path traversal prevention)", () => {
  test("resolves / to index.html", () => {
    const result = resolveStaticPath("/");
    expect(result).toBe(resolve(publicDir, "index.html"));
  });

  test("resolves /style.css to public/style.css", () => {
    const result = resolveStaticPath("/style.css");
    expect(result).toBe(resolve(publicDir, "style.css"));
  });

  test("resolves /app.js to public/app.js", () => {
    const result = resolveStaticPath("/app.js");
    expect(result).toBe(resolve(publicDir, "app.js"));
  });

  test("rejects path traversal with ../", () => {
    const result = resolveStaticPath("/../../../etc/passwd");
    expect(result).toBeNull();
  });

  test("rejects path traversal with encoded dots", () => {
    const result = resolveStaticPath("/..\\..\\..\\etc\\passwd");
    expect(result).toBeNull();
  });

  test("rejects direct parent traversal", () => {
    const result = resolveStaticPath("/../package.json");
    expect(result).toBeNull();
  });

  test("allows nested paths within public", () => {
    const result = resolveStaticPath("/subdir/file.js");
    expect(result).toBe(resolve(publicDir, "subdir", "file.js"));
  });
});
