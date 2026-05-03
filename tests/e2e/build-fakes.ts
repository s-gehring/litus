// Compile the fake CLI shims to platform-native `.exe` files on Windows.
//
// Why: the existing `.cmd` shims forward args via `%*`, which cmd.exe parses
// before re-exec'ing. cmd.exe's tokenizer splits on newlines, so any multi-line
// argument (e.g. the `fix-implement` or `artifacts` step prompts) gets
// truncated at the first newline AND every argument after it is dropped.
// A `.exe` produced by `bun build --compile` has no shell layer, so libuv's
// `CreateProcess` argv flows through unmodified — newlines and all.
//
// On Linux/macOS the existing extensionless shell shims (`#!/usr/bin/env bash`
// + `exec bun run … "$@"`) preserve args correctly via `"$@"`, so this script
// is a no-op there. The `.cmd` files remain in the tree as a fallback for any
// environment that hasn't run this build, but `PATHEXT` defaults to
// `.COM;.EXE;.BAT;.CMD;…` so a present `.exe` always wins over the `.cmd`.

import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKES_DIR = resolve(HERE, "fakes");

const FAKES = ["claude", "gh", "git", "uv", "uvx"] as const;

if (process.platform !== "win32") {
	console.log(`[build-fakes] skip — platform=${process.platform}, only Windows needs the .exe shim`);
	process.exit(0);
}

let built = 0;
let upToDate = 0;
for (const name of FAKES) {
	const src = resolve(FAKES_DIR, `${name}.ts`);
	const out = resolve(FAKES_DIR, `${name}.exe`);
	if (!existsSync(src)) {
		console.error(`[build-fakes] missing source: ${src}`);
		process.exit(1);
	}
	if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) {
		upToDate++;
		continue;
	}
	const proc = Bun.spawnSync(
		[
			"bun",
			"build",
			"--compile",
			"--target=bun-windows-x64",
			`--outfile=${out}`,
			src,
		],
		{ stdout: "inherit", stderr: "inherit" },
	);
	if (proc.exitCode !== 0) {
		console.error(`[build-fakes] failed to compile ${name}.ts`);
		process.exit(proc.exitCode ?? 1);
	}
	built++;
}
console.log(`[build-fakes] done — built ${built}, up-to-date ${upToDate} (of ${FAKES.length})`);
