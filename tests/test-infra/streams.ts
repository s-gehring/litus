const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Create a ReadableStream<Uint8Array> from an array of strings */
export function createReadableStream(lines: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const line of lines) {
				controller.enqueue(encoder.encode(line));
			}
			controller.close();
		},
	});
}

/** Create a ReadableStream that emits chunks with a delay between each */
export function createDelayedStream(lines: string[], delayMs: number): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream({
		async pull(controller) {
			if (index < lines.length) {
				if (index > 0) {
					await new Promise((r) => setTimeout(r, delayMs));
				}
				controller.enqueue(encoder.encode(lines[index]));
				index++;
			} else {
				controller.close();
			}
		},
	});
}

/** Collect all chunks from a ReadableStream into a single string */
export async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
	const merged = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.length;
	}
	return decoder.decode(merged);
}
