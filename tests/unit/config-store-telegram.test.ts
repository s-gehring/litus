import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, TELEGRAM_TOKEN_SENTINEL } from "../../src/config-store";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "config-store-telegram-test-"));
}

function configPath(dir: string): string {
	return join(dir, "config.json");
}

describe("ConfigStore — telegram validation (V1)", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("V1 rejects active=true with empty botToken", () => {
		const store = new ConfigStore(configPath(dir));
		const { errors } = store.save({
			telegram: { active: true, botToken: "", chatId: "@x" },
		});
		expect(errors.find((e) => e.path === "telegram.botToken")).toBeDefined();
	});

	test("V1 rejects active=true with empty chatId", () => {
		const store = new ConfigStore(configPath(dir));
		const { errors } = store.save({
			telegram: { active: true, botToken: "abc", chatId: "" },
		});
		expect(errors.find((e) => e.path === "telegram.chatId")).toBeDefined();
	});

	test("V1 rejects active=true with whitespace-only botToken/chatId", () => {
		const store = new ConfigStore(configPath(dir));
		const { errors } = store.save({
			telegram: { active: true, botToken: "   ", chatId: "   " },
		});
		expect(errors.find((e) => e.path === "telegram.botToken")).toBeDefined();
		expect(errors.find((e) => e.path === "telegram.chatId")).toBeDefined();
	});

	test("V1 accepts active=false with empty creds", () => {
		const store = new ConfigStore(configPath(dir));
		const { errors } = store.save({
			telegram: { active: false, botToken: "", chatId: "" },
		});
		expect(errors).toHaveLength(0);
	});

	test("V1 accepts active=true with both creds present", () => {
		const store = new ConfigStore(configPath(dir));
		const { errors } = store.save({
			telegram: { active: true, botToken: "tok", chatId: "@x" },
		});
		expect(errors).toHaveLength(0);
	});
});

describe("ConfigStore — telegram sentinel substitution (V4)", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("sentinel preserves stored botToken (and V1 sees it)", () => {
		const store = new ConfigStore(configPath(dir));
		// Initial save: store the real token while inactive.
		expect(
			store.save({ telegram: { botToken: "real-token", chatId: "@chat", active: false } }).errors,
		).toHaveLength(0);
		// Re-save with the sentinel: token must NOT be overwritten,
		// and V1 must accept the activation because the effective token is non-empty.
		const { errors } = store.save({
			telegram: { botToken: TELEGRAM_TOKEN_SENTINEL, chatId: "@chat", active: true },
		});
		expect(errors).toHaveLength(0);
		expect(store.get().telegram.botToken).toBe("real-token");
		expect(store.get().telegram.active).toBe(true);
	});

	test("empty string clears the stored botToken (and V1 rejects activation)", () => {
		const store = new ConfigStore(configPath(dir));
		expect(
			store.save({ telegram: { botToken: "real-token", chatId: "@chat", active: false } }).errors,
		).toHaveLength(0);
		// Empty string overwrites, then activate=true should fail V1.
		const { errors } = store.save({
			telegram: { botToken: "", chatId: "@chat", active: true },
		});
		expect(errors.find((e) => e.path === "telegram.botToken")).toBeDefined();

		// Save active=false + empty token to actually clear and verify.
		const cleared = store.save({
			telegram: { botToken: "", chatId: "@chat", active: false },
		});
		expect(cleared.errors).toHaveLength(0);
		expect(store.get().telegram.botToken).toBe("");
	});

	test("trims botToken/chatId on storage", () => {
		const store = new ConfigStore(configPath(dir));
		const { errors } = store.save({
			telegram: { botToken: "  abc  ", chatId: "  @chat  ", active: false },
		});
		expect(errors).toHaveLength(0);
		expect(store.get().telegram.botToken).toBe("abc");
		expect(store.get().telegram.chatId).toBe("@chat");
	});
});

describe("ConfigStore — telegram defaults", () => {
	test("default telegram section is dormant with empty creds", () => {
		const store = new ConfigStore(join(makeTempDir(), "nonexistent", "config.json"));
		expect(store.get().telegram).toEqual({
			botToken: "",
			chatId: "",
			active: false,
			forwardQuestions: false,
		});
	});

	test("telegram section round-trips through disk via a fresh store", () => {
		const dir = makeTempDir();
		try {
			const path = configPath(dir);
			const writer = new ConfigStore(path);
			expect(
				writer.save({
					telegram: { botToken: "real-token", chatId: "@chat", active: true },
				}).errors,
			).toHaveLength(0);

			// New ConfigStore reads the persisted JSON from disk.
			const reader = new ConfigStore(path);
			expect(reader.get().telegram).toEqual({
				botToken: "real-token",
				chatId: "@chat",
				active: true,
				forwardQuestions: false,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("ConfigStore — forwardQuestions field", () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("default is false", () => {
		const store = new ConfigStore(configPath(dir));
		expect(store.get().telegram.forwardQuestions).toBe(false);
	});

	test("forwardQuestions=true persists and round-trips through disk", () => {
		const path = configPath(dir);
		const writer = new ConfigStore(path);
		expect(
			writer.save({
				telegram: { forwardQuestions: true },
			}).errors,
		).toHaveLength(0);
		expect(writer.get().telegram.forwardQuestions).toBe(true);

		const reader = new ConfigStore(path);
		expect(reader.get().telegram.forwardQuestions).toBe(true);
	});

	test("forwardQuestions can be enabled while parent active is off (no cross-field rule)", () => {
		const store = new ConfigStore(configPath(dir));
		const { errors } = store.save({
			telegram: { active: false, forwardQuestions: true },
		});
		expect(errors).toHaveLength(0);
		expect(store.get().telegram).toEqual({
			botToken: "",
			chatId: "",
			active: false,
			forwardQuestions: true,
		});
	});

	test("non-boolean forwardQuestions is rejected with telegram.forwardQuestions error", () => {
		const store = new ConfigStore(configPath(dir));
		const { errors } = store.save({
			telegram: { forwardQuestions: "yes" as unknown as boolean },
		});
		expect(errors.find((e) => e.path === "telegram.forwardQuestions")).toBeDefined();
	});
});
