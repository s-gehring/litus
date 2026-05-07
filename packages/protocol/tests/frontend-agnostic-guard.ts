// FR-017 lock-in. Imported as a side-effect from every test file in
// `packages/protocol/tests/`: throws at module-load if a DOM preload
// leaked into the suite, regardless of which subset of test files Bun
// discovered. A single-file `bun test path/to/foo.test.ts` therefore
// still trips the guard.

if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
	throw new Error(
		"Frontend-agnostic protocol suite must not run with a DOM preload (FR-017). " +
			"Check `packages/protocol/bunfig.toml` for an accidental happy-dom preload.",
	);
}
