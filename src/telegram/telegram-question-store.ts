import { existsSync, readFileSync, renameSync } from "node:fs";
import { AsyncLock } from "../async-lock";
import { atomicWrite } from "../atomic-write";
import { telegramQuestionsFile } from "../litus-paths";
import { logger } from "../logger";

export interface ForwardedQuestionOption {
	/** Short identifier rendered on the inline button (e.g. "A", "1", "yes"). */
	key: string;
	/** Full description of the option, kept for reconstruction / debugging. */
	description: string;
}

export interface ForwardedQuestion {
	/** Pending application question id. */
	questionId: string;
	/** Owning workflow id. */
	workflowId: string;
	/** Chat id snapshot at forward time. */
	chatId: string;
	/** Ordered Telegram message ids that compose this question's representation
	 *  (length ≥ 1; split groups have len > 1). */
	messageIds: number[];
	/** Parsed option list, or null for free-form. */
	options: ForwardedQuestionOption[] | null;
	/** ISO-8601 timestamp at which the first message was successfully sent. */
	forwardedAt: string;
}

interface StoreFile {
	version: 1;
	questions: ForwardedQuestion[];
}

const STORE_VERSION = 1;

export class TelegramQuestionStore {
	private filePath: string;
	private byQuestionId = new Map<string, ForwardedQuestion>();
	private byMessageId = new Map<number, ForwardedQuestion>();
	private lock = new AsyncLock();

	constructor(filePath?: string) {
		this.filePath = filePath ?? telegramQuestionsFile();
	}

	// Sync I/O is intentional: the server bootstrap blocks on this so the
	// forwarder is fully indexed before the poller binds to it. Don't
	// "fix" it to async — the runtime mutators below use atomicWrite.
	loadOnStartup(): void {
		this.byQuestionId.clear();
		this.byMessageId.clear();
		if (!existsSync(this.filePath)) return;

		let text: string;
		try {
			text = readFileSync(this.filePath, "utf-8");
		} catch (err) {
			logger.warn(`[telegram-question-store] failed to read store: ${err}`);
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (err) {
			logger.warn(`[telegram-question-store] malformed store file, treating as empty: ${err}`);
			const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
			try {
				renameSync(this.filePath, corruptPath);
			} catch (renameErr) {
				logger.warn(`[telegram-question-store] failed to rename corrupt store: ${renameErr}`);
			}
			return;
		}

		if (typeof parsed !== "object" || parsed === null) return;
		const file = parsed as Partial<StoreFile>;
		if (file.version !== STORE_VERSION) {
			logger.warn(
				`[telegram-question-store] unknown store version ${String(file.version)}, treating as empty`,
			);
			return;
		}
		const questions = Array.isArray(file.questions) ? file.questions : [];
		for (const q of questions) {
			if (!isValidEntry(q)) continue;
			this.byQuestionId.set(q.questionId, q);
			for (const mid of q.messageIds) {
				this.byMessageId.set(mid, q);
			}
		}
	}

	getByQuestionId(questionId: string): ForwardedQuestion | null {
		return this.byQuestionId.get(questionId) ?? null;
	}

	getByMessageId(messageId: number): ForwardedQuestion | null {
		return this.byMessageId.get(messageId) ?? null;
	}

	getByCallbackData(callbackData: string): ForwardedQuestion | null {
		const parts = callbackData.split(":");
		if (parts.length < 3 || parts[0] !== "q") return null;
		// questionId may itself contain colons in theory; only the first two
		// segments are fixed (`q:<questionId>:<key>`); to keep parsing robust
		// the questionId is the second segment and key is the rest joined.
		const questionId = parts[1];
		return this.getByQuestionId(questionId);
	}

	parseCallbackKey(callbackData: string): string | null {
		const parts = callbackData.split(":");
		if (parts.length < 3 || parts[0] !== "q") return null;
		return parts.slice(2).join(":");
	}

	all(): ForwardedQuestion[] {
		return [...this.byQuestionId.values()];
	}

	hasPending(): boolean {
		return this.byQuestionId.size > 0;
	}

	add(entry: ForwardedQuestion): Promise<void> {
		return this.lock.run(async () => {
			// Persist FIRST so a write failure cannot leave a phantom in-memory
			// entry — see contracts/persisted-store.md §3 (FR-016).
			const next = [
				...[...this.byQuestionId.values()].filter((q) => q.questionId !== entry.questionId),
				entry,
			];
			await this.persistSnapshot(next);
			this.byQuestionId.set(entry.questionId, entry);
			for (const mid of entry.messageIds) {
				this.byMessageId.set(mid, entry);
			}
		});
	}

	removeByQuestionId(questionId: string): Promise<ForwardedQuestion | null> {
		return this.lock.run(async () => {
			const entry = this.byQuestionId.get(questionId);
			if (!entry) return null;
			const next = [...this.byQuestionId.values()].filter((q) => q.questionId !== questionId);
			await this.persistSnapshot(next);
			this.byQuestionId.delete(questionId);
			for (const mid of entry.messageIds) {
				const found = this.byMessageId.get(mid);
				if (found && found.questionId === questionId) {
					this.byMessageId.delete(mid);
				}
			}
			return entry;
		});
	}

	private async persistSnapshot(questions: ForwardedQuestion[]): Promise<void> {
		const data: StoreFile = {
			version: STORE_VERSION,
			questions,
		};
		try {
			await atomicWrite(this.filePath, JSON.stringify(data, null, 2));
		} catch (err) {
			logger.warn(`[telegram-question-store] persist failed: ${err}`);
			throw err;
		}
	}
}

function isValidEntry(value: unknown): value is ForwardedQuestion {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	if (typeof v.questionId !== "string" || v.questionId.length === 0) return false;
	if (typeof v.workflowId !== "string") return false;
	if (typeof v.chatId !== "string") return false;
	if (!Array.isArray(v.messageIds) || v.messageIds.length === 0) return false;
	if (!v.messageIds.every((m) => typeof m === "number")) return false;
	if (v.options !== null && !Array.isArray(v.options)) return false;
	if (typeof v.forwardedAt !== "string") return false;
	return true;
}
