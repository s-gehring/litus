import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { buildPathWithFakes, discoverRealGit } from "./fakes-path";

/**
 * Backwards-compatible shape consumed by existing tests. New fields
 * (`restart`) are additive; existing consumers that only read
 * `baseUrl`/`logPath`/`stop` continue to work unchanged.
 */
export interface ServerProcess {
	baseUrl: string;
	logPath: string;
	stop: () => Promise<void>;
}

export interface ServerHandle extends ServerProcess {
	/**
	 * Kill the current Bun server process (SIGTERM then SIGKILL after 5s),
	 * then respawn against the same `homeDir`/`scenarioPath`/`counterFile`.
	 * `baseUrl` is updated in place to the new port. Callers MUST NOT
	 * destructure `baseUrl`; use property access so they see the new value.
	 */
	restart: () => Promise<void>;
}

export interface SpawnServerOptions {
	homeDir: string;
	scenarioPath: string;
	counterFile: string;
	logPath: string;
	repoRoot: string;
	/** Absolute path to the prebuilt working tree used as source for
	 * `clone.useTemplate` side-effect in the `git` fake. Exposed via
	 * `LITUS_E2E_CLONE_TEMPLATE` to the spawned server. */
	cloneTemplate: string;
}

const READY_MARKER = "Litus running at http://localhost:";
// 30s covers cold bun start + client bundle resolve on a loaded CI runner;
// overridable via env for slower sandboxes / debugging.
const READY_TIMEOUT_MS = Number(process.env.LITUS_E2E_SERVER_READY_MS ?? 30_000);

interface RawSpawn {
	baseUrl: string;
	stop: () => Promise<void>;
}

async function spawnOnce(opts: SpawnServerOptions): Promise<RawSpawn> {
	const logFile = await open(opts.logPath, "a");
	const logStream = logFile.createWriteStream();
	// The log is opened in append mode so post-restart lifetimes accumulate
	// (valuable for post-mortem when a test fails after restarting the
	// server). Mark lifetime boundaries so log triage isn't ambiguous.
	logStream.write(`=== litus-e2e server lifetime start at ${new Date().toISOString()} ===\n`);

	// Strip any inherited `Path` (Windows casing) so only our `PATH` wins;
	// otherwise on Windows the child may pick up a pre-existing `Path` that
	// lacks our fakes prefix.
	const parentEnv = Object.fromEntries(
		Object.entries(process.env).filter(
			([k, v]) => typeof v === "string" && k !== "Path" && k !== "PATH",
		),
	) as Record<string, string>;

	const env: Record<string, string> = {
		...parentEnv,
		HOME: opts.homeDir,
		USERPROFILE: opts.homeDir,
		PATH: buildPathWithFakes(process.env.PATH ?? process.env.Path),
		LITUS_E2E_SCENARIO: opts.scenarioPath,
		LITUS_E2E_COUNTER: opts.counterFile,
		LITUS_E2E_REAL_GIT: discoverRealGit(process.env.PATH ?? process.env.Path),
		LITUS_E2E_CLONE_TEMPLATE: opts.cloneTemplate,
		PORT: "0",
	};

	const proc = spawn("bun", ["run", resolve(opts.repoRoot, "src/server.ts")], {
		cwd: opts.repoRoot,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		shell: false,
	});
	const exitedPromise = new Promise<number>((resolveExit) => {
		proc.on("close", (c) => resolveExit(c ?? 0));
	});

	let baseUrl = "";
	let resolved = false;

	const readyPromise = new Promise<string>((resolveReady, rejectReady) => {
		const timer = setTimeout(() => {
			if (!resolved) {
				rejectReady(new Error(`server did not become ready within ${READY_TIMEOUT_MS}ms`));
			}
		}, READY_TIMEOUT_MS);

		const tryMatch = (chunk: string) => {
			if (resolved) return;
			const idx = chunk.indexOf(READY_MARKER);
			if (idx >= 0) {
				const rest = chunk.slice(idx + READY_MARKER.length);
				const port = rest.match(/^(\d+)/)?.[1];
				if (port) {
					resolved = true;
					clearTimeout(timer);
					baseUrl = `http://localhost:${port}`;
					resolveReady(baseUrl);
				}
			}
		};

		const pipe = (stream: NodeJS.ReadableStream) => {
			let pending = "";
			stream.on("data", (chunk: Buffer | string) => {
				const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
				logStream.write(text);
				if (resolved) return;
				pending += text;
				let nl = pending.indexOf("\n");
				while (nl >= 0) {
					tryMatch(pending.slice(0, nl));
					pending = pending.slice(nl + 1);
					nl = pending.indexOf("\n");
				}
				// Also try whatever's buffered — the marker may land before a newline.
				tryMatch(pending);
			});
		};

		pipe(proc.stdout);
		pipe(proc.stderr);
	});

	const url = await readyPromise;

	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		try {
			proc.kill("SIGTERM");
		} catch {
			// ignore
		}
		// Race SIGTERM's exit against a 5s ladder; if the ladder wins,
		// escalate to SIGKILL. The final `await exitedPromise` below is
		// unconditional so we always observe the real process exit,
		// regardless of which branch of the race fired.
		const killTimer = new Promise<void>((r) => setTimeout(r, 5000)).then(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				// ignore
			}
		});
		await Promise.race([exitedPromise, killTimer]);
		await exitedPromise;
		try {
			await logStream.end();
			await logFile.close();
		} catch {
			// ignore
		}
	};

	return { baseUrl: url, stop };
}

export async function spawnServer(opts: SpawnServerOptions): Promise<ServerHandle> {
	let current = await spawnOnce(opts);

	const handle: ServerHandle = {
		baseUrl: current.baseUrl,
		logPath: opts.logPath,
		stop: async () => {
			await current.stop();
		},
		restart: async () => {
			await current.stop();
			current = await spawnOnce(opts);
			handle.baseUrl = current.baseUrl;
		},
	};

	return handle;
}
