import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ForwardedQuestion,
	TelegramQuestionStore,
} from "../../src/telegram/telegram-question-store";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "telegram-question-store-test-"));
}

function makeEntry(over: Partial<ForwardedQuestion> = {}): ForwardedQuestion {
	return {
		questionId: "q-1",
		workflowId: "wf-1",
		chatId: "@chat",
		messageIds: [100, 101],
		options: [
			{ key: "A", description: "Option A" },
			{ key: "B", description: "Option B" },
		],
		forwardedAt: "2026-05-07T12:34:56.789Z",
		...over,
	};
}

describe("TelegramQuestionStore", () => {
	let dir: string;
	let storePath: string;

	beforeEach(() => {
		dir = makeTempDir();
		storePath = join(dir, "telegram-questions.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("missing-file load returns empty state without throwing", () => {
		const store = new TelegramQuestionStore(storePath);
		store.loadOnStartup();
		expect(store.all()).toHaveLength(0);
		expect(store.hasPending()).toBe(false);
	});

	test("malformed file is logged, renamed to *.corrupt-*, and treated as empty", () => {
		writeFileSync(storePath, "{not json");
		const store = new TelegramQuestionStore(storePath);
		store.loadOnStartup();
		expect(store.all()).toHaveLength(0);
		expect(existsSync(storePath)).toBe(false);
		const remaining = readdirSync(dir);
		expect(remaining.some((f) => f.startsWith("telegram-questions.json.corrupt-"))).toBe(true);
	});

	test("unknown version returns empty state without renaming", () => {
		writeFileSync(storePath, JSON.stringify({ version: 999, questions: [] }));
		const store = new TelegramQuestionStore(storePath);
		store.loadOnStartup();
		expect(store.all()).toHaveLength(0);
		expect(existsSync(storePath)).toBe(true);
	});

	test("add then re-instantiate roundtrips entry and rebuilds reverse index", async () => {
		const writer = new TelegramQuestionStore(storePath);
		writer.loadOnStartup();
		await writer.add(makeEntry());

		const reader = new TelegramQuestionStore(storePath);
		reader.loadOnStartup();
		expect(reader.getByQuestionId("q-1")).toEqual(makeEntry());
		expect(reader.getByMessageId(100)?.questionId).toBe("q-1");
		expect(reader.getByMessageId(101)?.questionId).toBe("q-1");
	});

	test("removeByQuestionId clears entry and persists", async () => {
		const store = new TelegramQuestionStore(storePath);
		store.loadOnStartup();
		await store.add(makeEntry());
		const removed = await store.removeByQuestionId("q-1");
		expect(removed?.questionId).toBe("q-1");
		expect(store.all()).toHaveLength(0);
		expect(store.getByMessageId(100)).toBeNull();

		const persisted = JSON.parse(readFileSync(storePath, "utf-8")) as { questions: unknown[] };
		expect(persisted.questions).toHaveLength(0);
	});

	test("multiple adds keep both entries; reverse-index lookups by message id work", async () => {
		const store = new TelegramQuestionStore(storePath);
		store.loadOnStartup();
		await store.add(makeEntry({ questionId: "q-a", messageIds: [1, 2] }));
		await store.add(makeEntry({ questionId: "q-b", messageIds: [3] }));
		expect(store.getByMessageId(2)?.questionId).toBe("q-a");
		expect(store.getByMessageId(3)?.questionId).toBe("q-b");
		expect(store.all()).toHaveLength(2);
	});

	test("getByCallbackData parses q:<id>:<key> form", async () => {
		const store = new TelegramQuestionStore(storePath);
		store.loadOnStartup();
		await store.add(makeEntry({ questionId: "uuid-1" }));
		expect(store.getByCallbackData("q:uuid-1:A")?.questionId).toBe("uuid-1");
		expect(store.parseCallbackKey("q:uuid-1:A")).toBe("A");
		expect(store.getByCallbackData("garbage")).toBeNull();
	});

	test("add rolls back in-memory state when persist fails (FR-016)", async () => {
		// Create a regular file where the store's parent directory should be —
		// this makes atomicWrite's mkdirSync(parent) throw ENOTDIR.
		const blockerFile = join(dir, "blocker-file");
		writeFileSync(blockerFile, "x");
		const blockedPath = join(blockerFile, "telegram-questions.json");
		const blocked = new TelegramQuestionStore(blockedPath);
		blocked.loadOnStartup();
		await expect(blocked.add(makeEntry({ questionId: "q-fail" }))).rejects.toBeDefined();
		expect(blocked.getByQuestionId("q-fail")).toBeNull();
		expect(blocked.all()).toHaveLength(0);
	});

	test("removeByQuestionId rolls back in-memory state when persist fails (FR-016)", async () => {
		const store = new TelegramQuestionStore(storePath);
		store.loadOnStartup();
		await store.add(makeEntry({ questionId: "q-keep" }));
		// Replace the store's file path with one whose parent is a file so
		// the next persist throws.
		const blockerFile = join(dir, "remove-blocker");
		writeFileSync(blockerFile, "x");
		(store as unknown as { filePath: string }).filePath = join(blockerFile, "x.json");
		await expect(store.removeByQuestionId("q-keep")).rejects.toBeDefined();
		expect(store.getByQuestionId("q-keep")).not.toBeNull();
	});

	test("concurrent add operations resolve in submission order", async () => {
		const store = new TelegramQuestionStore(storePath);
		store.loadOnStartup();
		const ops = [
			store.add(makeEntry({ questionId: "q1", messageIds: [1] })),
			store.add(makeEntry({ questionId: "q2", messageIds: [2] })),
			store.add(makeEntry({ questionId: "q3", messageIds: [3] })),
		];
		await Promise.all(ops);

		const reader = new TelegramQuestionStore(storePath);
		reader.loadOnStartup();
		expect(reader.all()).toHaveLength(3);
		expect(reader.getByQuestionId("q1")).not.toBeNull();
		expect(reader.getByQuestionId("q2")).not.toBeNull();
		expect(reader.getByQuestionId("q3")).not.toBeNull();
	});
});
