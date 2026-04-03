import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { Question } from "./types";

// Patterns that strongly indicate a direct question to the user
const CERTAIN_PATTERNS = [
	/^(should|would|could|can|do|does|shall)\s+(I|we)\b.*\?\s*$/im, // "Should I use X?"
	/\bplease (choose|select|pick|decide|confirm)\b/i, // Request for decision
	/\b(option [a-d]|choice \d|alternative \d)\b.*\?\s*$/im, // Multiple choice ending with ?
	/^(which|what|where|how)\b.*\b(prefer|want|like|should|would)\b.*\?\s*$/im, // "Which do you prefer?"
	/\breply with\b.*\b(option|choice|letter|number)\b/i, // "reply with the option letter"
	/\| [A-D] \|/m, // Markdown table with option letters like "| A |"
];

// Patterns that suggest a possible question (less certain) — sent to Haiku for verification
const UNCERTAIN_PATTERNS = [
	/\?\s*$/m, // Ends with question mark (too broad on its own)
	/\blet me know\b/i,
	/\bwhat do you think\b/i,
	/\bany preference\b/i,
	/\byour (thoughts|opinion|preference)\b/i,
];

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

		// Check for certain question patterns
		for (const pattern of CERTAIN_PATTERNS) {
			if (pattern.test(trimmed)) {
				this.lastQuestionTime = now;
				return {
					id: randomUUID(),
					content: trimmed,
					confidence: "certain",
					detectedAt: new Date().toISOString(),
				};
			}
		}

		// Check for uncertain patterns — these get surfaced as "uncertain"
		for (const pattern of UNCERTAIN_PATTERNS) {
			if (pattern.test(trimmed)) {
				this.lastQuestionTime = now;
				return {
					id: randomUUID(),
					content: trimmed,
					confidence: "uncertain",
					detectedAt: new Date().toISOString(),
				};
			}
		}

		return null;
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
