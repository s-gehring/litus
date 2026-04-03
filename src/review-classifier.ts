import type { ReviewSeverity } from "./types";

const VALID_SEVERITIES: ReviewSeverity[] = ["critical", "major", "minor", "trivial", "nit"];

export class ReviewClassifier {
	async classify(reviewOutput: string): Promise<ReviewSeverity> {
		const prompt = `Classify the highest severity of issues found in this code review. Answer with exactly one word: critical, major, minor, trivial, or nit.

- critical: Security vulnerabilities, data loss, crashes
- major: Missing error handling, broken functionality, logic errors
- minor: Code style issues, missing tests, small improvements
- trivial: Whitespace, formatting, naming preferences
- nit: Suggestions, opinions, optional improvements

Review output:
${reviewOutput}`;

		const proc = Bun.spawn(
			["claude", "-p", prompt, "--model", "claude-haiku-4-5-20251001", "--output-format", "text"],
			{ stdout: "pipe", stderr: "pipe" },
		);

		const code = await proc.exited;
		if (code !== 0) return "minor";

		const text = await new Response(proc.stdout as ReadableStream).text();
		const severity = text.trim().toLowerCase() as ReviewSeverity;
		if (VALID_SEVERITIES.includes(severity)) {
			return severity;
		}
		return "minor";
	}
}
