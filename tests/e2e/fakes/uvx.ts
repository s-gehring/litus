#!/usr/bin/env bun
// Minimal fake for `uvx`. The orchestrator calls
//   uvx --from git+https://github.com/github/spec-kit.git@<ver> specify init --here ...
// from within the newly-created worktree to install speckit skill stubs. We
// emulate that by writing the SKILL.md files directly so the workflow can
// proceed without network access or real uv.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FAKE = "uvx";
const argv = process.argv.slice(2);

if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V")) {
	process.stdout.write("uvx 0.5.0 (litus-e2e-fake)\n");
	process.exit(0);
}

// Recognise `specify init --here` invocations regardless of surrounding flags.
const hasSpecifyInit = argv.includes("specify") && argv.includes("init") && argv.includes("--here");
if (!hasSpecifyInit) {
	process.stderr.write(
		`[litus-e2e-fake:${FAKE}] no scripted response for argv=${JSON.stringify(argv)}\n`,
	);
	process.exit(2);
}

const SPECKIT_INIT_NAMES = ["clarify", "implement", "plan", "specify", "tasks"];
const skillsDir = join(process.cwd(), ".claude", "skills");
for (const name of SPECKIT_INIT_NAMES) {
	const dir = join(skillsDir, `speckit-${name}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`# speckit-${name} (e2e stub)\n\nInstalled by the E2E uvx fake.\n`,
		"utf8",
	);
}
// Emulate the real `uvx specify init --here` which writes a top-level
// CLAUDE.md. Written with a distinctive marker so tests can assert the
// speckit prefix is preserved after the project-CLAUDE.md append step.
writeFileSync(
	join(process.cwd(), "CLAUDE.md"),
	"# Speckit-generated CLAUDE.md (litus-e2e-fake)\n",
	"utf8",
);
process.stdout.write("Initialized speckit skills (litus-e2e-fake)\n");
process.exit(0);
