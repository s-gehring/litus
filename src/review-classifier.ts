import { runClaude } from "./claude-spawn";
import { configStore } from "./config-store";
import { logger } from "./logger";
import type { ReviewSeverity } from "./types";

const VALID_SEVERITIES: ReviewSeverity[] = ["critical", "major", "minor", "trivial", "nit"];

export class ReviewClassifier {
	async classify(reviewOutput: string): Promise<ReviewSeverity> {
		try {
			const config = configStore.get();
			const promptTemplate = config.prompts.reviewClassification;
			const prompt = promptTemplate.replaceAll("${reviewOutput}", reviewOutput);

			const { ok, stdout } = await runClaude({
				prompt,
				model: config.models.reviewClassification,
				effort: config.efforts.reviewClassification,
				callerLabel: "review-classifier",
				timeoutMs: 30_000,
			});
			if (!ok) return "major";

			const severity = stdout.trim().toLowerCase() as ReviewSeverity;
			if (VALID_SEVERITIES.includes(severity)) {
				return severity;
			}
			return "minor";
		} catch (err) {
			logger.warn("[review-classifier] classify failed:", err);
			return "major";
		}
	}
}
