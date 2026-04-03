import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { Question } from "./types";

// Patterns that indicate the text is NOT a question to the user (agent narration)
// Note: "let me (?!know\b)" uses negative lookahead — excludes "let me read/create/..."
// but allows "let me know" to pass through as a potential question indicator.
const EXCLUSION_PATTERNS = [
	/^(here'?s?|this is|i('ll| will)|let me (?!know\b)|now i|i('m| am))\b/i, // Agent narrating its actions
	/^\[tool:/i, // Tool use output
	/^(reading|writing|creating|updating|deleting|installing)\b/i, // Agent action descriptions
];

export class QuestionDetector {
	private lastQuestionTime = 0;
	private client: Anthropic | null = null;
	private pendingClassification = false;
	private readonly COOLDOWN_MS = 15_000;

	/**
	 * Pre-filter: checks if text is a plausible question candidate.
	 * Returns a Question object if the text passes exclusion filters,
	 * or null if it's clearly not a question. The actual classification
	 * is done by classifyWithHaiku().
	 */
	detect(text: string): Question | null {
		const now = Date.now();

		if (now - this.lastQuestionTime < this.COOLDOWN_MS) {
			return null;
		}

		const trimmed = text.trim();
		if (!trimmed || trimmed.length < 10) return null;

		// Exclude agent narration
		for (const pattern of EXCLUSION_PATTERNS) {
			if (pattern.test(trimmed)) return null;
		}

		this.lastQuestionTime = now;
		return {
			id: randomUUID(),
			content: trimmed,
			detectedAt: new Date().toISOString(),
		};
	}

	async classifyWithHaiku(text: string): Promise<boolean> {
		if (this.pendingClassification) return false;
		this.pendingClassification = true;

		try {
			if (!this.client) {
				this.client = new Anthropic();
			}

			const response = await this.client.messages.create({
				model: "claude-haiku-4-5-20251001",
				max_tokens: 10,
				messages: [
					{
						role: "user",
						content: `Is this text a question directed at the user that requires their input to proceed? Answer only "yes" or "no".\n\nText: "${text}"`,
					},
				],
			});

			const block = response.content[0];
			if (block.type === "text") {
				return block.text.trim().toLowerCase().startsWith("yes");
			}
			return false;
		} catch {
			return false;
		} finally {
			this.pendingClassification = false;
		}
	}

	reset(): void {
		this.lastQuestionTime = 0;
		this.pendingClassification = false;
	}
}
