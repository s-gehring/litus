import { configStore } from "./config-store";
import type { ReviewSeverity } from "./types";

const VALID_SEVERITIES: ReviewSeverity[] = ["critical", "major", "minor", "trivial", "nit"];

export class ReviewClassifier {
	async classify(reviewOutput: string): Promise<ReviewSeverity> {
		const promptTemplate = configStore.get().prompts.reviewClassification;
		// biome-ignore lint/suspicious/noTemplateCurlyInString: template variable placeholder
		const prompt = promptTemplate.replaceAll("${reviewOutput}", reviewOutput);

		const proc = Bun.spawn(
			[
				"claude",
				"-p",
				prompt,
				"--model",
				configStore.get().models.reviewClassification,
				"--output-format",
				"text",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);

		const code = await proc.exited;
		if (code !== 0) return "major";

		const text = await new Response(proc.stdout as ReadableStream).text();
		const severity = text.trim().toLowerCase() as ReviewSeverity;
		if (VALID_SEVERITIES.includes(severity)) {
			return severity;
		}
		return "minor";
	}
}
