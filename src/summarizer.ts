import Anthropic from "@anthropic-ai/sdk";

export class Summarizer {
	private client: Anthropic | null = null;
	private outputBuffer: Map<string, string[]> = new Map();
	private lastSummaryTime: Map<string, number> = new Map();
	private pendingSummary: Map<string, boolean> = new Map();

	private readonly INTERVAL_MS = 15_000; // Summarize at most every 15 seconds
	private readonly MIN_CHARS = 200; // Need some content before summarizing

	private getClient(): Anthropic {
		if (!this.client) {
			this.client = new Anthropic();
		}
		return this.client;
	}

	maybeSummarize(workflowId: string, text: string, callback: (summary: string) => void): void {
		// Accumulate output
		if (!this.outputBuffer.has(workflowId)) {
			this.outputBuffer.set(workflowId, []);
		}
		this.outputBuffer.get(workflowId)?.push(text);

		const now = Date.now();
		const lastTime = this.lastSummaryTime.get(workflowId) || 0;
		const chunks = this.outputBuffer.get(workflowId) ?? [];
		const totalChars = chunks.join("").length;

		// Check if we should generate a summary
		if (
			totalChars >= this.MIN_CHARS &&
			now - lastTime >= this.INTERVAL_MS &&
			!this.pendingSummary.get(workflowId)
		) {
			this.pendingSummary.set(workflowId, true);
			this.lastSummaryTime.set(workflowId, now);

			const recentText = chunks
				.slice(-10) // Last 10 chunks
				.join("\n")
				.slice(-1000); // Cap at 1000 chars

			this.generateSummary(recentText)
				.then((summary) => {
					this.pendingSummary.set(workflowId, false);
					if (summary) {
						callback(summary);
					}
				})
				.catch(() => {
					this.pendingSummary.set(workflowId, false);
				});
		}
	}

	private async generateSummary(text: string): Promise<string | null> {
		try {
			const response = await this.getClient().messages.create({
				model: "claude-haiku-4-5-20251001",
				max_tokens: 50,
				messages: [
					{
						role: "user",
						content: `Summarize what this coding agent is currently doing in 3-6 words. Output only the summary, nothing else.\n\n${text}`,
					},
				],
			});

			const block = response.content[0];
			if (block.type === "text") {
				return block.text.trim();
			}
			return null;
		} catch {
			return null;
		}
	}

	cleanup(workflowId: string): void {
		this.outputBuffer.delete(workflowId);
		this.lastSummaryTime.delete(workflowId);
		this.pendingSummary.delete(workflowId);
	}
}
