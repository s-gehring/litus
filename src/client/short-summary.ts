/**
 * Shortens a raw prompt/specification for use as a fallback when the proper
 * summary hasn't been generated yet. Caps to 10 words and 80 characters and
 * collapses to the first non-empty line so the card/title doesn't render an
 * entire multi-paragraph spec.
 */
export function shortenSummary(text: string): string {
	const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
	const collapsed = firstLine.trim().replace(/\s+/g, " ");
	if (!collapsed) return "";

	const MAX_WORDS = 10;
	const MAX_CHARS = 80;

	const words = collapsed.split(" ");
	let truncated = words.length > MAX_WORDS;
	let result = truncated ? words.slice(0, MAX_WORDS).join(" ") : collapsed;

	if (result.length > MAX_CHARS) {
		result = result.slice(0, MAX_CHARS - 1).trimEnd();
		truncated = true;
	}

	return truncated ? `${result}…` : result;
}
