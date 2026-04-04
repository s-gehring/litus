import { randomUUID } from "node:crypto";
import { configStore } from "./config-store";
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
	private pendingClassification = false;

	/**
	 * Pre-filter: checks if text is a plausible question candidate.
	 * Returns a Question object if the text passes exclusion filters,
	 * or null if it's clearly not a question. The actual classification
	 * is done by classifyWithHaiku().
	 */
	detect(text: string): Question | null {
		const now = Date.now();

		if (now - this.lastQuestionTime < configStore.get().timing.questionDetectionCooldownMs) {
			return null;
		}

		const trimmed = text.trim();
		if (!trimmed || trimmed.length < 10) return null;

		// Extract the last meaningful block (final paragraph/section) for analysis
		// Questions appear at the END of agent output, not the beginning
		const lastBlock = this.extractLastBlock(trimmed);
		if (!lastBlock || lastBlock.length < 10) return null;

		// Exclude agent narration — apply only to the last block
		for (const pattern of EXCLUSION_PATTERNS) {
			if (pattern.test(lastBlock)) return null;
		}

		this.lastQuestionTime = now;
		return {
			id: randomUUID(),
			content: lastBlock,
			detectedAt: new Date().toISOString(),
		};
	}

	private extractLastBlock(text: string): string {
		// Split by double newlines (paragraph boundaries) or single newlines with blank lines
		const blocks = text.split(/\n\s*\n/).filter((b) => b.trim().length > 0);
		if (blocks.length === 0) return text.trim();
		// Take the last block, capped at 2000 chars
		return blocks[blocks.length - 1].trim().slice(0, 2000);
	}

	async classifyWithHaiku(text: string): Promise<boolean> {
		if (this.pendingClassification) return false;
		this.pendingClassification = true;

		try {
			const promptTemplate = configStore.get().prompts.questionDetection;
			// biome-ignore lint/suspicious/noTemplateCurlyInString: template variable placeholder
			const prompt = promptTemplate.replaceAll("${text}", text);

			const proc = Bun.spawn(
				[
					"claude",
					"-p",
					prompt,
					"--model",
					configStore.get().models.questionDetection,
					"--output-format",
					"text",
				],
				{ stdout: "pipe", stderr: "pipe" },
			);

			const code = await proc.exited;
			if (code !== 0) return false;

			const result = await new Response(proc.stdout as ReadableStream).text();
			return result.trim().toLowerCase().startsWith("yes");
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
