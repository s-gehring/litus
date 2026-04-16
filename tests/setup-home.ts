// Redirect $HOME / $USERPROFILE to a throwaway tmpdir for the whole test run so
// that any code path resolving `join(homedir(), ".litus", ...)` cannot touch the
// user's real ~/.litus folder. This preload MUST run before any src/ module is
// imported — see bunfig.toml.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testHome = mkdtempSync(join(tmpdir(), "litus-test-home-"));

process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

process.on("exit", () => {
	try {
		rmSync(testHome, { recursive: true, force: true });
	} catch {
		// best-effort — tmpdir OS cleanup will reap it
	}
});
