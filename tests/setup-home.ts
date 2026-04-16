// Redirect the user's home directory to a throwaway tmpdir for the whole test
// run so that any code path resolving `join(homedir(), ".litus", ...)` cannot
// touch the user's real ~/.litus folder. This preload MUST run before any
// src/ module is imported — see bunfig.toml.
//
// We do three things:
//   1. Use bun:test's mock.module to replace node:os so every source module
//      that imports `{ homedir }` gets the redirected value. This is
//      load-bearing on Linux: Bun's os.homedir() there does not honour $HOME.
//   2. Set $HOME and $USERPROFILE so any child process / library reading the
//      env directly also points at the sandbox.
//   3. Clean up the tmpdir on process exit.
import { mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as realOs from "node:os";
import { join } from "node:path";

const testHome = mkdtempSync(join(realOs.tmpdir(), "litus-test-home-"));

process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

mock.module("node:os", () => ({
	...realOs,
	default: realOs,
	homedir: () => testHome,
}));

process.on("exit", () => {
	try {
		rmSync(testHome, { recursive: true, force: true });
	} catch {
		// best-effort — tmpdir OS cleanup will reap it
	}
});
