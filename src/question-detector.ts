import { randomUUID } from "node:crypto";
import { configStore } from "./config-store";
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
			const promptTemplate = configStore.get().prompts.questionDetection;
			const prompt = promptTemplate.replaceAll("${text}", text);

			const config = configStore.get();
			const args = [
				"claude",
				"-p",
				prompt,
				"--model",
				config.models.questionDetection,
				"--output-format",
				"text",
				"--effort",
				config.efforts.questionDetection,
			];
			const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });

			const code = await proc.exited;
			if (code !== 0) return false;

			const result = await new Response(proc.stdout as ReadableStream).text();
			return result.trim().toLowerCase().startsWith("yes");
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
