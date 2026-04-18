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
	const proc = Bun.spawn([cmd, ...args], {
		cwd,
		env: { ...process.env, ...extraEnv } as Record<string, string>,
		stdout: "pipe",
		stderr: "pipe",
	});
	const code = await proc.exited;
	if (code !== 0) {
		const err = await new Response(proc.stderr as ReadableStream).text();
		throw new Error(`${cmd} ${args.join(" ")} failed (${code}): ${err}`);
	}
}

async function initTargetRepo(dir: string): Promise<void> {
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
	await runCmd("git", ["add", "README.md"], dir, env);
	await runCmd("git", ["commit", "-m", "chore: initial commit"], dir, env);
}

export async function createSandbox(opts: CreateSandboxOptions = {}): Promise<Sandbox> {
	const homeDir = await mkdtemp(join(tmpdir(), "litus-e2e-"));
	const counterFile = join(homeDir, ".litus-e2e-claude-counter.json");
	const serverLogPath = join(homeDir, "server.log");
	const targetRepo = join(homeDir, "target-repo");
	const litusDir = join(homeDir, ".litus");
	const configPath = join(litusDir, "config.json");
	await initTargetRepo(targetRepo);
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
				// best-effort
			}
		},
	};
}
