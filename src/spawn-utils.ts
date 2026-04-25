/** Build an env object with CLAUDE* vars stripped to prevent child CLI from inheriting parent session state. */
export function cleanEnv(extra?: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined && !k.startsWith("CLAUDE")) {
			env[k] = v;
		}
	}
	if (extra) Object.assign(env, extra);
	return env;
}

export interface SpawnLike {
	spawn: (
		args: string[],
		opts?: Record<string, unknown>,
	) => {
		exited: Promise<number>;
		stdout: ReadableStream | null;
		stderr: ReadableStream | null;
	};
}

/** Create the default Bun.spawn wrapper used when no test runner is injected. */
export function defaultSpawn(): SpawnLike["spawn"] {
	return ((args: string[], opts?: Record<string, unknown>) =>
		Bun.spawn(args, {
			...opts,
			windowsHide: true,
		} as Parameters<typeof Bun.spawn>[1])) as SpawnLike["spawn"];
}

/**
 * Reads a stream to string. Accepts `number` because Bun.spawn may return
 * a file descriptor (number) when stdio is set to "inherit" or a fd index;
 * callers always pass `"pipe"` but the Bun type signature is a union.
 */
export async function readStream(
	stream: ReadableStream | number | null | undefined,
): Promise<string> {
	if (!stream || typeof stream === "number") return "";
	return new Response(stream as ReadableStream).text();
}
