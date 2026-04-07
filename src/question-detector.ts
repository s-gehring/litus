import { randomUUID } from "node:crypto";
import { configStore } from "./config-store";
import { runClaude } from "./spawn-utils";
import type { Question } from "./types";

// Positive indicators that text likely contains a question for the user
const QUESTION_INDICATORS = [
	/\?/, // Question mark anywhere
	/\|.*\|/s, // Markdown table (option tables)
	/\breply with\b/i,
	/\bchoose\b/i,
	/\bselect\b/i,
	/\bwhich option\b/i,
	/\blet me know\b/i,
	/\bplease provide\b/i,
];

export class QuestionDetector {
	private pendingClassification = false;

	/**
	 * Pre-filter: checks if text contains positive question indicators.
	 * Returns a Question object if indicators are found, null otherwise.
	 * The actual classification is done by classifyWithHaiku().
	 */
	detect(text: string): Question | null {
		const trimmed = text.trim();
		if (!trimmed || trimmed.length < 10) return null;

		// Extract the last meaningful section for analysis
		const lastBlock = this.extractLastBlock(trimmed);
		if (!lastBlock || lastBlock.length < 10) return null;

		// Positive-case pre-filter: only proceed if question indicators are present
		const hasIndicator = QUESTION_INDICATORS.some((pattern) => pattern.test(lastBlock));
		if (!hasIndicator) return null;

		return {
			id: randomUUID(),
			content: lastBlock,
			detectedAt: new Date().toISOString(),
		};
	}

	private extractLastBlock(text: string): string {
		// Split on heading or horizontal rule boundaries
		const blocks = text.split(/^(?=# )|^(?:---+|___+|\*\*\*+)\s*$/m);
		const lastBlock = blocks[blocks.length - 1]?.trim();
		if (!lastBlock) return text.trim();
		return lastBlock.slice(0, 2000);
	}

	async classifyWithHaiku(text: string): Promise<boolean> {
		if (this.pendingClassification) return false;
		this.pendingClassification = true;

		try {
			const config = configStore.get();
			const promptTemplate = config.prompts.questionDetection;
			const prompt = promptTemplate.replaceAll("${text}", text);

			const { ok, stdout } = await runClaude({
				prompt,
				model: config.models.questionDetection,
				effort: config.efforts.questionDetection,
				callerLabel: "question-detector",
			});
			if (!ok) return false;
			return stdout.trim().toLowerCase().startsWith("yes");
		} catch (err) {
			console.warn("[question-detector] classifyWithHaiku failed:", err);
			return false;
		} finally {
			this.pendingClassification = false;
		}
	}

	reset(): void {
		this.pendingClassification = false;
	}
}
