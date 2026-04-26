import { runConfiguredHelper } from "./claude-helper";
import type { ReviewSeverity } from "./types";

const VALID_SEVERITIES: ReviewSeverity[] = ["critical", "major", "minor", "trivial", "nit"];

export class ReviewClassifier {
	async classify(reviewOutput: string): Promise<ReviewSeverity> {
		return runConfiguredHelper<ReviewSeverity>({
			selector: (config) => ({
				promptTemplate: config.prompts.reviewClassification,
				model: config.models.reviewClassification,
				effort: config.efforts.reviewClassification,
			}),
			vars: { reviewOutput },
			parser: (stdout) => {
				const severity = stdout.trim().toLowerCase() as ReviewSeverity;
				return VALID_SEVERITIES.includes(severity) ? severity : "minor";
			},
			fallback: "major",
			callerLabel: "review-classifier",
		});
	}
}
