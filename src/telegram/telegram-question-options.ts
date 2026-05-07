import type { ForwardedQuestionOption } from "./telegram-question-store";

/**
 * Detect a markdown option table inside the question body and return its rows
 * as ordered `{ key, description }` records. Returns `null` for free-form
 * questions (no detectable table). The detection rule is intentionally narrow:
 *
 * - The table must contain a header row whose first cell is `Option`,
 *   `Choice`, `Key`, `ID`, or similar — the parser is liberal here. Any
 *   header row works as long as the next row is a markdown separator
 *   (`| --- | --- |`).
 * - Each subsequent row's first column (after trim) must be a short
 *   identifier of ≤ 24 ASCII letters/digits. Telegram's `callback_data`
 *   budget after the `q:<UUID36>:` prefix is 25 bytes, so a 24-char key
 *   leaves headroom for the colon separator and any future prefix bumps.
 * - Rows that do not match are rejected; if no rows match, the whole table
 *   counts as no-options-found and we return null (free-form).
 */
export function parseOptionsFromQuestion(content: string): ForwardedQuestionOption[] | null {
	const lines = content.split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		const header = lines[i];
		if (!isTableRow(header)) continue;
		const next = lines[i + 1];
		if (!next || !isSeparatorRow(next)) continue;

		const options: ForwardedQuestionOption[] = [];
		for (let j = i + 2; j < lines.length; j++) {
			const row = lines[j];
			if (!isTableRow(row)) break;
			const cells = parseRow(row);
			if (cells.length < 2) break;
			const key = cells[0].trim();
			if (!isValidKey(key)) break;
			const description = cells.slice(1).join(" | ").trim();
			options.push({ key, description });
		}

		if (options.length > 0) return options;
	}

	return null;
}

function isTableRow(line: string): boolean {
	const t = line.trimStart();
	return t.startsWith("|");
}

function isSeparatorRow(line: string): boolean {
	const cells = parseRow(line);
	if (cells.length < 2) return false;
	return cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

function parseRow(line: string): string[] {
	const trimmed = line.trim();
	const stripped = trimmed.replace(/^\|/, "").replace(/\|$/, "");
	return stripped.split("|");
}

function isValidKey(key: string): boolean {
	if (key.length === 0 || key.length > 24) return false;
	return /^[A-Za-z0-9]+$/.test(key);
}
