import { tmpdir } from "node:os";
import { configStore } from "./config-store";
import { cleanEnv } from "./spawn-utils";

export class Summarizer {
	private charCount: Map<string, number> = new Map();
	private recentChunks: Map<string, string[]> = new Map();
	private lastSummaryTime: Map<string, number> = new Map();
	private pendingSummary: Map<string, boolean> = new Map();

	private readonly MIN_CHARS = 200;
	private readonly MAX_RECENT_CHUNKS = 10;

	maybeSummarize(workflowId: string, text: string, callback: (summary: string) => void): void {
		// Track character count without joining the full buffer
		this.charCount.set(workflowId, (this.charCount.get(workflowId) ?? 0) + text.length);

		// Keep only the most recent chunks (sliding window)
		let recent = this.recentChunks.get(workflowId);
		if (!recent) {
			recent = [];
			this.recentChunks.set(workflowId, recent);
		}
		recent.push(text);
		if (recent.length > this.MAX_RECENT_CHUNKS) {
			recent.splice(0, recent.length - this.MAX_RECENT_CHUNKS);
		}

		const now = Date.now();
		const lastTime = this.lastSummaryTime.get(workflowId) || 0;
		const totalChars = this.charCount.get(workflowId) ?? 0;

		if (
			totalChars >= this.MIN_CHARS &&
			now - lastTime >= configStore.get().timing.activitySummaryIntervalMs &&
			!this.pendingSummary.get(workflowId)
		) {
			this.pendingSummary.set(workflowId, true);
			this.lastSummaryTime.set(workflowId, now);

			const recentText = recent.join("\n").slice(-1000);

			this.generateSummary(recentText)
				.then((summary) => {
					// Only deliver if workflow hasn't been cleaned up while we were generating
					if (!this.pendingSummary.has(workflowId)) return;
					this.pendingSummary.set(workflowId, false);
					if (summary) {
						callback(summary);
					}
				})
				.catch(() => {
					if (this.pendingSummary.has(workflowId)) {
						this.pendingSummary.set(workflowId, false);
					}
				});
		}
	}

	/** Reset the activity buffer (e.g. between steps) without removing tracking state. */
	resetBuffer(workflowId: string): void {
		this.charCount.set(workflowId, 0);
		this.recentChunks.delete(workflowId);
	}

	private async generateSummary(text: string): Promise<string | null> {
		try {
			const config = configStore.get();
			const promptTemplate = config.prompts.activitySummarization;
			const prompt = promptTemplate.replaceAll("${text}", text);

			const args = [
				"claude",
				"-p",
				prompt,
				"--model",
				config.models.activitySummarization,
				"--output-format",
				"text",
				"--effort",
				config.efforts.activitySummarization,
			];
			const proc = Bun.spawn(args, {
				cwd: tmpdir(),
				stdout: "pipe",
				stderr: "pipe",
				env: cleanEnv(),
			});

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
			const config = configStore.get();
			const promptTemplate = config.prompts.specSummarization;
			const prompt = promptTemplate.replaceAll("${specification}", specification);

			const args = [
				"claude",
				"-p",
				prompt,
				"--model",
				config.models.specSummarization,
				"--output-format",
				"text",
				"--effort",
				config.efforts.specSummarization,
			];
			const proc = Bun.spawn(args, {
				cwd: tmpdir(),
				stdout: "pipe",
				stderr: "pipe",
				env: cleanEnv(),
			});

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
		this.charCount.delete(workflowId);
		this.recentChunks.delete(workflowId);
		this.lastSummaryTime.delete(workflowId);
		this.pendingSummary.delete(workflowId);
	}
}
