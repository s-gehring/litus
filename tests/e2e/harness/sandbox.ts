import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Sandbox {
	homeDir: string;
	/** A fully-initialised git repository inside the sandbox, suitable for
	 * passing as `targetRepository` to `workflow:start`. */
	targetRepo: string;
	counterFile: string;
	serverLogPath: string;
	configPath: string;
	cleanup: () => Promise<void>;
}

export interface CreateSandboxOptions {
	/** When set, writes a minimal `~/.litus/config.json` with `autoMode` set
	 * to this value before the server spawns. */
	autoMode?: "manual" | "normal" | "full-auto";
}

async function runCmd(
	cmd: string,
	args: string[],
	cwd: string,
	extraEnv: Record<string, string> = {},
): Promise<void> {
	const proc = spawn(cmd, args, {
		cwd,
		env: { ...process.env, ...extraEnv } as NodeJS.ProcessEnv,
		stdio: ["ignore", "pipe", "pipe"],
		shell: false,
	});
	let stderr = "";
	proc.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const code: number = await new Promise((resolveExit, rejectExit) => {
		proc.on("error", rejectExit);
		proc.on("close", (c) => resolveExit(c ?? 0));
	});
	if (code !== 0) {
		throw new Error(`${cmd} ${args.join(" ")} failed (${code}): ${stderr}`);
	}
}

const SPECKIT_INIT_NAMES = ["clarify", "implement", "plan", "specify", "tasks"];

async function populateSpeckitSkills(targetDir: string): Promise<void> {
	// Pre-populate the skill stubs that `ensureSpeckitSkills` looks for so
	// `hasSpeckitSkills` returns true and the orchestrator never shells out
	// to `uvx specify init` (which would require network access and violate
	// hermetic isolation — SC-004).
	const skillsDir = join(targetDir, ".claude", "skills");
	await mkdir(skillsDir, { recursive: true });
	for (const name of SPECKIT_INIT_NAMES) {
		const dir = join(skillsDir, `speckit-${name}`);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "SKILL.md"),
			`# speckit-${name} (e2e stub)\n\nPlaceholder installed by the E2E harness.\n`,
			"utf8",
		);
	}
}

async function initTargetRepo(dir: string, originDir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	// Use a neutral identity so `git commit` works without relying on user config.
	const env = {
		GIT_AUTHOR_NAME: "Litus E2E",
		GIT_AUTHOR_EMAIL: "e2e@litus.local",
		GIT_COMMITTER_NAME: "Litus E2E",
		GIT_COMMITTER_EMAIL: "e2e@litus.local",
	};
	await runCmd("git", ["init", "-b", "master"], dir, env);
	await writeFile(join(dir, "README.md"), "# E2E Target Repo\n", "utf8");
	await populateSpeckitSkills(dir);
	await runCmd("git", ["add", "-A"], dir, env);
	await runCmd("git", ["commit", "-m", "chore: initial commit"], dir, env);

	// Bootstrap a bare origin alongside the target repo so `git fetch origin
	// master` and the GitHub-origin setup check both succeed. The origin path
	// contains "github" so `checkGitHubOrigin`'s substring check passes — we
	// can't use a real github URL with `insteadOf` rewrite because
	// `git remote get-url` applies the rewrite and would expose the local path.
	await mkdir(originDir, { recursive: true });
	await runCmd("git", ["init", "--bare", "-b", "master"], originDir, env);
	await runCmd("git", ["remote", "add", "origin", originDir], dir, env);
	await runCmd("git", ["push", "origin", "master"], dir, env);
}

export async function createSandbox(opts: CreateSandboxOptions = {}): Promise<Sandbox> {
	const homeDir = await mkdtemp(join(tmpdir(), "litus-e2e-"));
	const counterFile = join(homeDir, ".litus-e2e-claude-counter.json");
	const serverLogPath = join(homeDir, "server.log");
	const targetRepo = join(homeDir, "target-repo");
	// Path includes "github" so setup-checker's checkGitHubOrigin passes when
	// it inspects the configured origin URL.
	const originRepo = join(homeDir, "github-origin.git");
	const litusDir = join(homeDir, ".litus");
	const configPath = join(litusDir, "config.json");
	await initTargetRepo(targetRepo, originRepo);
	if (opts.autoMode) {
		await mkdir(litusDir, { recursive: true });
		await writeFile(configPath, JSON.stringify({ autoMode: opts.autoMode }, null, 2), "utf8");
	}
	let disposed = false;
	return {
		homeDir,
		targetRepo,
		counterFile,
		serverLogPath,
		configPath,
		async cleanup() {
			if (disposed) return;
			disposed = true;
			try {
				await rm(homeDir, { recursive: true, force: true });
			} catch {
				// Best-effort: on Windows, antivirus scanners or bun subprocess
				// handles can briefly hold files open and produce ENOTEMPTY.
				// A stale sandbox in $TMPDIR is preferable to a failing teardown
				// that masks the real test result.
			}
		},
	};
}
