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
