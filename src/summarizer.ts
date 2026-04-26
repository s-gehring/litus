import { runConfiguredHelper } from "./claude-helper";
import { configStore } from "./config-store";
import { logger } from "./logger";

// When the E2E harness is driving the server, summarizer spawns race the
// pipeline-step claude spawns against a shared FIFO scenario counter. Skip
// cosmetic summaries entirely in that mode so scenario authoring stays
// deterministic per pipeline step.
const SUMMARIZER_DISABLED = Boolean(process.env.LITUS_E2E_SCENARIO);

export class Summarizer {
	private charCount: Map<string, number> = new Map();
	private recentChunks: Map<string, string[]> = new Map();
	private lastSummaryTime: Map<string, number> = new Map();
	private pendingSummary: Map<string, boolean> = new Map();

	private readonly MIN_CHARS = 200;
	private readonly MAX_RECENT_CHUNKS = 10;

	maybeSummarize(workflowId: string, text: string, callback: (summary: string) => void): void {
		if (SUMMARIZER_DISABLED) return;
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

			// If the recent window is whitespace-only (spinners, blank lines), there is
			// nothing meaningful to summarize. Sending an empty ${text} to Haiku has
			// been observed to produce clarification-question responses rather than a
			// status label, so skip the spawn entirely in that case.
			if (!recentText.trim()) {
				this.pendingSummary.set(workflowId, false);
				return;
			}

			this.generateSummary(recentText)
				.then((summary) => {
					// Only deliver if workflow hasn't been cleaned up while we were generating
					if (!this.pendingSummary.has(workflowId)) return;
					this.pendingSummary.set(workflowId, false);
					if (summary) {
						callback(summary);
					}
				})
				.catch((err) => {
					logger.warn("[summarizer] Activity summary failed:", err);
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
		return runConfiguredHelper<string | null>({
			selector: (config) => ({
				promptTemplate: config.prompts.activitySummarization,
				model: config.models.activitySummarization,
				effort: config.efforts.activitySummarization,
			}),
			vars: { text },
			parser: (stdout) => stdout.trim() || null,
			fallback: null,
			callerLabel: "summarizer:activity",
		});
	}

	async generateSpecSummary(specification: string): Promise<{ summary: string; flavor: string }> {
		if (SUMMARIZER_DISABLED) return { summary: "", flavor: "" };
		return runConfiguredHelper<{ summary: string; flavor: string }>({
			selector: (config) => ({
				promptTemplate: config.prompts.specSummarization,
				model: config.models.specSummarization,
				effort: config.efforts.specSummarization,
			}),
			vars: { specification },
			parser: (stdout) => {
				const cleaned = stdout
					.trim()
					.replace(/^```(?:json)?\s*\n?/i, "")
					.replace(/\n?```\s*$/, "");
				const parsed = JSON.parse(cleaned);
				return {
					summary: String(parsed.summary ?? "").slice(0, 50),
					flavor: String(parsed.flavor ?? "").slice(0, 100),
				};
			},
			fallback: { summary: "", flavor: "" },
			callerLabel: "summarizer:spec",
			timeoutMs: 60_000,
		});
	}

	cleanup(workflowId: string): void {
		this.charCount.delete(workflowId);
		this.recentChunks.delete(workflowId);
		this.lastSummaryTime.delete(workflowId);
		this.pendingSummary.delete(workflowId);
	}
}
