#!/usr/bin/env bun
// Minimal fake for `uv`. The setup checker only probes `uv --version`; the
// full `uvx specify init` flow is avoided by pre-populating speckit skills in
// the sandbox target repo (see tests/e2e/harness/sandbox.ts).
const FAKE = "uv";
const argv = process.argv.slice(2);

if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V")) {
	process.stdout.write("uv 0.5.0 (litus-e2e-fake)\n");
	process.exit(0);
}

process.stderr.write(
	`[litus-e2e-fake:${FAKE}] no scripted response for argv=${JSON.stringify(argv)}\n`,
);
process.exit(2);
