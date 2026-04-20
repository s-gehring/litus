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
		// Contract's discriminated union only allows `reason: "permission_denied"`
		// with `exists: true`. This also ensures the client's
		// `folderErrorMessageFor` routes the response to the right message
		// (it checks `reason` only when `exists: true`).
		expect(await body(res)).toEqual({
			exists: true,
			usable: false,
			reason: "permission_denied",
		});
	});

	test("relative input stays confined to home — does not leak CWD existence", async () => {
		// If the handler stat'd the raw `resolved` (not the absolute form), a
		// relative path like "does-not-exist-anywhere" would be resolved by the
		// OS against the server's CWD, which may be outside home — and could
		// return `not_found` based on the CWD tree, leaking information.
		// The allow-list must short-circuit relative paths that resolve under
		// home to be treated as paths under home, and the stat must operate on
		// the absolute form.
		const res = await handleFolderExists("definitely-not-in-home-or-cwd-xyz-42");
		// The relative path resolves under home (by the allow-list fallback),
		// so the result must be `not_found` relative to home — never anything
		// derived from the server's CWD.
		expect(await body(res)).toEqual({
			exists: false,
			usable: false,
			reason: "not_found",
		});
	});
});
