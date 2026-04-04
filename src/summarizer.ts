import { configStore } from "./config-store";

export class Summarizer {
	private outputBuffer: Map<string, string[]> = new Map();
	private lastSummaryTime: Map<string, number> = new Map();
	private pendingSummary: Map<string, boolean> = new Map();

	private readonly MIN_CHARS = 200;

	maybeSummarize(workflowId: string, text: string, callback: (summary: string) => void): void {
		if (!this.outputBuffer.has(workflowId)) {
			this.outputBuffer.set(workflowId, []);
		}
		this.outputBuffer.get(workflowId)?.push(text);

		const now = Date.now();
		const lastTime = this.lastSummaryTime.get(workflowId) || 0;
		const chunks = this.outputBuffer.get(workflowId) ?? [];
		const totalChars = chunks.join("").length;

		if (
			totalChars >= this.MIN_CHARS &&
			now - lastTime >= configStore.get().timing.activitySummaryIntervalMs &&
			!this.pendingSummary.get(workflowId)
		) {
			this.pendingSummary.set(workflowId, true);
			this.lastSummaryTime.set(workflowId, now);

			const recentText = chunks.slice(-10).join("\n").slice(-1000);

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
			const promptTemplate = configStore.get().prompts.activitySummarization;
			const prompt = promptTemplate.replace("${text}", text);

			const proc = Bun.spawn(
				["claude", "-p", prompt, "--model", configStore.get().models.activitySummarization, "--output-format", "text"],
				{ stdout: "pipe", stderr: "pipe" },
			);

			const code = await proc.exited;
			if (code !== 0) return null;

			const result = await new Response(proc.stdout as ReadableStream).text();
			return result.trim() || null;
		} catch {
			return null;
		}
	}

	async generateSpecSummary(specification: string): Promise<{ summary: string; flavor: string }> {
		try {
			const promptTemplate = configStore.get().prompts.specSummarization;
			const prompt = promptTemplate.replace("${specification}", specification);

			const proc = Bun.spawn(
				["claude", "-p", prompt, "--model", configStore.get().models.specSummarization, "--output-format", "text"],
				{ stdout: "pipe", stderr: "pipe" },
			);

			const code = await proc.exited;
			if (code !== 0) return { summary: "", flavor: "" };

			const result = await new Response(proc.stdout as ReadableStream).text();
			const cleaned = result
				.trim()
				.replace(/^```(?:json)?\s*\n?/i, "")
				.replace(/\n?```\s*$/, "");
			const parsed = JSON.parse(cleaned);
			return {
				summary: String(parsed.summary ?? "").slice(0, 50),
				flavor: String(parsed.flavor ?? "").slice(0, 100),
			};
		} catch {
			return { summary: "", flavor: "" };
		}
	}

	cleanup(workflowId: string): void {
		this.outputBuffer.delete(workflowId);
		this.lastSummaryTime.delete(workflowId);
		this.pendingSummary.delete(workflowId);
	}
}
