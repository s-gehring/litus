import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { handleFolderExists } from "../../src/server";

const root = join(homedir(), `.litus-folder-exists-test-${Date.now()}`);
const subdir = join(root, "sub");
const filePath = join(root, "file.txt");

beforeAll(() => {
	mkdirSync(subdir, { recursive: true });
	writeFileSync(filePath, "hi");
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

async function body(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

describe("/api/folder-exists handler", () => {
	test("400 on missing path param", async () => {
		const res = await handleFolderExists(null);
		expect(res.status).toBe(400);
	});

	test("400 on empty path", async () => {
		const res = await handleFolderExists("   ");
		expect(res.status).toBe(400);
	});

	test("happy path: existing directory under home → usable", async () => {
		const res = await handleFolderExists(subdir);
		expect(res.status).toBe(200);
		expect(await body(res)).toEqual({ exists: true, usable: true });
	});

	test("not_a_directory: existing file → usable=false with not_a_directory", async () => {
		const res = await handleFolderExists(filePath);
		expect(await body(res)).toEqual({
			exists: true,
			usable: false,
			reason: "not_a_directory",
		});
	});

	test("not_found: path under home that does not exist", async () => {
		const missing = join(root, "does-not-exist");
		const res = await handleFolderExists(missing);
		expect(await body(res)).toEqual({
			exists: false,
			usable: false,
			reason: "not_found",
		});
	});

	test("permission_denied: path outside home is uniformly reported without leaking existence", async () => {
		// `dirname(homedir())` is definitionally outside home (home's parent).
		// We don't care whether it exists on disk — the allow-list must
		// short-circuit before stat.
		const outside = join(dirname(homedir()), "definitely-not-under-home");
		const res = await handleFolderExists(outside);
		expect(await body(res)).toEqual({
			exists: false,
			usable: false,
			reason: "permission_denied",
		});
	});
});
