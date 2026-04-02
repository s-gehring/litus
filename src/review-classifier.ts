import Anthropic from "@anthropic-ai/sdk";
import type { ReviewSeverity } from "./types";

export class ReviewClassifier {
	private client: Anthropic | null = null;

	private getClient(): Anthropic {
		if (!this.client) {
			this.client = new Anthropic();
		}
		return this.client;
	}

	async classify(_reviewOutput: string): Promise<ReviewSeverity> {
		// TODO: Implement in T006
		throw new Error("Not implemented");
	}
}
