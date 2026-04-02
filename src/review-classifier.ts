import Anthropic from "@anthropic-ai/sdk";
import type { ReviewSeverity } from "./types";

const VALID_SEVERITIES: ReviewSeverity[] = ["critical", "major", "minor", "trivial", "nit"];

export class ReviewClassifier {
	private client: Anthropic | null = null;

	private getClient(): Anthropic {
		if (!this.client) {
			this.client = new Anthropic();
		}
		return this.client;
	}

	async classify(reviewOutput: string): Promise<ReviewSeverity> {
		const response = await this.getClient().messages.create({
			model: "claude-haiku-4-5-20251001",
			max_tokens: 10,
			messages: [
				{
					role: "user",
					content: `Classify the highest severity of issues found in this code review. Answer with exactly one word: critical, major, minor, trivial, or nit.

- critical: Security vulnerabilities, data loss, crashes
- major: Missing error handling, broken functionality, logic errors
- minor: Code style issues, missing tests, small improvements
- trivial: Whitespace, formatting, naming preferences
- nit: Suggestions, opinions, optional improvements

Review output:
${reviewOutput}`,
				},
			],
		});

		const block = response.content[0];
		if (block.type === "text") {
			const severity = block.text.trim().toLowerCase() as ReviewSeverity;
			if (VALID_SEVERITIES.includes(severity)) {
				return severity;
			}
		}
		return "minor";
	}
}
