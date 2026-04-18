import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { buildPathWithFakes } from "./fakes-path";

export interface ServerProcess {
	baseUrl: string;
	logPath: string;
	stop: () => Promise<void>;
}

export interface SpawnServerOptions {
	homeDir: string;
	scenarioPath: string;
	counterFile: string;
	logPath: string;
	repoRoot: string;
}

const READY_MARKER = "Litus running at http://localhost:";
const READY_TIMEOUT_MS = 30_000;

export async function spawnServer(opts: SpawnServerOptions): Promise<ServerProcess> {
	const logFile = await open(opts.logPath, "w");
	const logStream = logFile.createWriteStream();

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
		PORT: "0",
	};

	const proc = Bun.spawn(["bun", "run", resolve(opts.repoRoot, "src/server.ts")], {
		cwd: opts.repoRoot,
		env,
		stdout: "pipe",
		stderr: "pipe",
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

		const pipe = async (stream: ReadableStream<Uint8Array>) => {
			const reader = stream.getReader();
			const decoder = new TextDecoder();
			let pending = "";
			while (true) {
				const { value, done } = await reader.read();
				if (done) return;
				const text = decoder.decode(value, { stream: true });
				logStream.write(text);
				if (resolved) continue;
				pending += text;
				let nl = pending.indexOf("\n");
				while (nl >= 0) {
					tryMatch(pending.slice(0, nl));
					pending = pending.slice(nl + 1);
					nl = pending.indexOf("\n");
				}
				// Also try whatever's buffered — the marker may land before a newline.
				tryMatch(pending);
			}
		};

		void pipe(proc.stdout);
		void pipe(proc.stderr);
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
		const exited = Promise.race([
			proc.exited,
			new Promise<void>((r) => setTimeout(r, 5000)).then(() => {
				try {
					proc.kill("SIGKILL");
				} catch {
					// ignore
				}
			}),
		]);
		await exited;
		try {
			await logStream.end();
			await logFile.close();
		} catch {
			// ignore
		}
	};

	return {
		baseUrl: url,
		logPath: opts.logPath,
		stop,
	};
}
