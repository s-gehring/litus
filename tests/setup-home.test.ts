import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { basename } from "node:path";

describe("test HOME isolation", () => {
	test("homedir() resolves to the preload sandbox so ~/.litus defaults cannot touch real user data", () => {
		// The preload (tests/setup-home.ts) creates a dir named
		// `litus-test-home-<random>` inside the OS tmpdir and points
		// $HOME / $USERPROFILE at it. We only check the folder name
		// segment because CI tmpdirs can be symlinked (e.g. /tmp vs
		// /private/tmp) so full-path prefix checks are fragile.
		expect(basename(homedir())).toMatch(/^litus-test-home-/);
	});
});
