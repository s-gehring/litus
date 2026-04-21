import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Sandbox {
	homeDir: string;
	/** A fully-initialised git repository inside the sandbox, suitable for
	 * passing as `targetRepository` to `workflow:start`. */
	targetRepo: string;
	/**
	 * Absolute path to a prebuilt, real-git working tree used as the source
	 * for the `clone.useTemplate` side-effect in `tests/e2e/fakes/git.ts`.
	 * Exposed via the `LITUS_E2E_CLONE_TEMPLATE` env var so the fake can copy
	 * it into a scripted clone's destination.
	 */
	cloneTemplate: string;
	counterFile: string;
	serverLogPath: string;
	configPath: string;
	cleanup: () => Promise<void>;
}

export interface CreateSandboxOptions {
	/** When set, writes a minimal `~/.litus/config.json` with `autoMode` set
	 * to this value before the server spawns. */
	autoMode?: "manual" | "normal" | "full-auto";
	/**
	 * Arbitrary partial-config overrides merged into the written
	 * `~/.litus/config.json` before the server spawns. Shallow merged at the
	 * top level; nested objects are replaced wholesale.
	 *
	 * Used by the epic E2E tests to:
	 *   - Replace the multi-line `prompts.epicDecomposition` template with a
	 *     single-line version so Windows `.cmd` argument passing (which drops
	 *     newlines in args via `%*`) doesn't truncate the prompt.
	 *   - Force `limits.maxJsonRetries` to 1 so the malformed-JSON edge-case
	 *     scenario terminates quickly.
	 */
	configOverrides?: Record<string, unknown>;
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
	// Satisfy optional gitignore setup checks so the orchestrator doesn't
	// pause on warnings in manual autoMode. Entries must match
	// GITIGNORE_ENTRIES in src/setup-checker.ts. `.claude` must be present
	// AND untracked, so we write .gitignore before anything that would
	// create .claude/ contents.
	await writeFile(join(dir, ".gitignore"), "specs/\n.worktrees\n.claude\n.specify\n", "utf8");
	// The speckit skills are installed into the worktree at runtime by the
	// `uvx` fake (tests/e2e/fakes/uvx.ts); we don't seed them in the target
	// repo because `.claude` must remain untracked to satisfy the gitignore
	// check above.
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

/**
 * Build a minimal real-git working tree with a single commit on `master`.
 * The tree is used as the source of the `clone.useTemplate` side-effect in
 * the `git` fake: the fake recursively copies it to the scripted clone's
 * destination and rewrites `origin` to the scripted URL. At least one
 * commit is required so `git worktree add` (invoked downstream by the
 * server's managed-repo flow) succeeds against the cloned copy.
 */
async function initCloneTemplate(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	const env = {
		GIT_AUTHOR_NAME: "Litus E2E",
		GIT_AUTHOR_EMAIL: "e2e@litus.local",
		GIT_COMMITTER_NAME: "Litus E2E",
		GIT_COMMITTER_EMAIL: "e2e@litus.local",
	};
	await runCmd("git", ["init", "-b", "master"], dir, env);
	await writeFile(join(dir, "README.md"), "# E2E Clone Template\n", "utf8");
	await runCmd("git", ["add", "-A"], dir, env);
	await runCmd("git", ["commit", "-m", "chore: template initial commit"], dir, env);
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
	const cloneTemplate = join(homeDir, "clone-template");
	await initTargetRepo(targetRepo, originRepo);
	await initCloneTemplate(cloneTemplate);
	if (opts.autoMode || opts.configOverrides) {
		await mkdir(litusDir, { recursive: true });
		const merged: Record<string, unknown> = {
			...(opts.autoMode ? { autoMode: opts.autoMode } : {}),
			...(opts.configOverrides ?? {}),
		};
		await writeFile(configPath, JSON.stringify(merged, null, 2), "utf8");
	}
	let disposed = false;
	return {
		homeDir,
		targetRepo,
		cloneTemplate,
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
