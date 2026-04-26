import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { runConfiguredHelper } from "../../src/claude-helper";
import type { AppConfig, EffortLevel } from "../../src/types";

type WarnArgs = [
	string,
	{ callerLabel: string; err: unknown; failureMode: "spawn" | "parse" },
	string,
];

const originalSpawn = Bun.spawn;
const originalSetTimeout = globalThis.setTimeout;
const originalWarn = console.warn;

function mockSpawnResponse(stdout: string, stderr = "", exitCode = 0) {
	return {
		stdout: new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new TextEncoder().encode(stdout));
				c.close();
			},
		}),
		stderr: new ReadableStream<Uint8Array>({
			start(c) {
				if (stderr) c.enqueue(new TextEncoder().encode(stderr));
				c.close();
			},
		}),
		exited: Promise.resolve(exitCode),
		pid: 1,
		kill: () => {},
	};
}

function getPrompt(args: string[]): string {
	const idx = args.indexOf("-p");
	expect(idx).toBeGreaterThanOrEqual(0);
	return args[idx + 1];
}

function defaultSelector(
	overrides: Partial<{ promptTemplate: string; model: string; effort: EffortLevel }> = {},
) {
	return (_config: AppConfig) =>
		({
			promptTemplate: "hello ${foo}",
			model: "claude-haiku-4-5-20251001",
			effort: "low" as EffortLevel,
			...overrides,
		}) as { promptTemplate: string; model: string; effort: EffortLevel };
}

describe("runConfiguredHelper", () => {
	let spawnMock: ReturnType<typeof mock>;
	let warnMock: ReturnType<typeof mock>;
	let setTimeoutMock: ReturnType<typeof mock>;

	beforeEach(() => {
		spawnMock = mock(() => mockSpawnResponse(""));
		warnMock = mock(() => {});
		setTimeoutMock = mock((fn: (...a: unknown[]) => void, delay: number) =>
			originalSetTimeout(fn, delay),
		);
		Bun.spawn = spawnMock as typeof Bun.spawn;
		console.warn = warnMock as typeof console.warn;
		globalThis.setTimeout = setTimeoutMock as unknown as typeof setTimeout;
	});

	afterEach(() => {
		Bun.spawn = originalSpawn;
		console.warn = originalWarn;
		globalThis.setTimeout = originalSetTimeout;
	});

	test("substitutes ${foo} in prompt sent to runClaude", async () => {
		await runConfiguredHelper<string>({
			selector: defaultSelector(),
			vars: { foo: "bar" },
			parser: (s) => s,
			fallback: "fb",
			callerLabel: "test",
		});

		expect(spawnMock).toHaveBeenCalledTimes(1);
		const args = (spawnMock.mock.calls as unknown[][])[0][0] as string[];
		expect(getPrompt(args)).toBe("hello bar");
	});

	test("parser receives raw stdout verbatim", async () => {
		spawnMock = mock(() => mockSpawnResponse("abc"));
		Bun.spawn = spawnMock as typeof Bun.spawn;

		const seen: string[] = [];
		const result = await runConfiguredHelper<string>({
			selector: defaultSelector(),
			vars: {},
			parser: (s) => {
				seen.push(s);
				return s;
			},
			fallback: "fb",
			callerLabel: "test",
		});

		expect(seen).toEqual(["abc"]);
		expect(result).toBe("abc");
	});

	test("runClaude non-ok → fallback + warn failureMode 'spawn'", async () => {
		spawnMock = mock(() => mockSpawnResponse("", "boom", 1));
		Bun.spawn = spawnMock as typeof Bun.spawn;

		const result = await runConfiguredHelper<string>({
			selector: defaultSelector(),
			vars: {},
			parser: (s) => s,
			fallback: "FB",
			callerLabel: "test-caller",
		});

		expect(result).toBe("FB");
		// runClaude itself emits one warn for the non-zero exit; our helper emits another.
		// Find the structured one.
		const helperWarns = (warnMock.mock.calls as unknown[][]).filter(
			(c) => typeof c[1] === "object" && c[1] !== null,
		) as WarnArgs[];
		expect(helperWarns.length).toBe(1);
		const [, meta, msg] = helperWarns[0];
		expect(meta.callerLabel).toBe("test-caller");
		expect(meta.failureMode).toBe("spawn");
		expect(msg).toBe("claude helper failed");
	});

	test("parser throw → fallback + warn failureMode 'parse'", async () => {
		spawnMock = mock(() => mockSpawnResponse("abc", "", 0));
		Bun.spawn = spawnMock as typeof Bun.spawn;

		const result = await runConfiguredHelper<string>({
			selector: defaultSelector(),
			vars: {},
			parser: () => {
				throw new Error("parser boom");
			},
			fallback: "FB",
			callerLabel: "test-caller",
		});

		expect(result).toBe("FB");
		const helperWarns = (warnMock.mock.calls as unknown[][]).filter(
			(c) => typeof c[1] === "object" && c[1] !== null,
		) as WarnArgs[];
		expect(helperWarns.length).toBe(1);
		const [, meta] = helperWarns[0];
		expect(meta.callerLabel).toBe("test-caller");
		expect(meta.failureMode).toBe("parse");
	});

	test("default timeoutMs 30_000 forwarded when omitted", async () => {
		await runConfiguredHelper<string>({
			selector: defaultSelector(),
			vars: {},
			parser: (s) => s,
			fallback: "fb",
			callerLabel: "test",
		});

		// runClaude calls setTimeout with options.timeoutMs as the delay (line 96 of claude-spawn.ts).
		const delays = (setTimeoutMock.mock.calls as unknown[][])
			.map((c) => c[1])
			.filter((d): d is number => typeof d === "number");
		expect(delays).toContain(30_000);
	});

	test("custom timeoutMs forwarded unchanged", async () => {
		await runConfiguredHelper<string>({
			selector: defaultSelector(),
			vars: {},
			parser: (s) => s,
			fallback: "fb",
			callerLabel: "test",
			timeoutMs: 60_000,
		});

		const delays = (setTimeoutMock.mock.calls as unknown[][])
			.map((c) => c[1])
			.filter((d): d is number => typeof d === "number");
		expect(delays).toContain(60_000);
		expect(delays).not.toContain(30_000);
	});

	test("selector throw → fallback + warn 'spawn'; runClaude NOT called", async () => {
		const result = await runConfiguredHelper<string>({
			selector: () => {
				throw new Error("selector boom");
			},
			vars: {},
			parser: (s) => s,
			fallback: "FB",
			callerLabel: "test-caller",
		});

		expect(result).toBe("FB");
		expect(spawnMock).not.toHaveBeenCalled();
		const helperWarns = (warnMock.mock.calls as unknown[][]).filter(
			(c) => typeof c[1] === "object" && c[1] !== null,
		) as WarnArgs[];
		expect(helperWarns.length).toBe(1);
		const [, meta] = helperWarns[0];
		expect(meta.callerLabel).toBe("test-caller");
		expect(meta.failureMode).toBe("spawn");
	});

	for (const field of ["promptTemplate", "model", "effort"] as const) {
		for (const value of [undefined, ""] as const) {
			const label = value === undefined ? "undefined" : '""';
			test(`${field} = ${label} → fallback + warn 'spawn'; runClaude NOT called`, async () => {
				const result = await runConfiguredHelper<string>({
					selector: defaultSelector({
						[field]: value,
					} as Partial<{ promptTemplate: string; model: string; effort: EffortLevel }>),
					vars: {},
					parser: (s) => s,
					fallback: "FB",
					callerLabel: "test-caller",
				});

				expect(result).toBe("FB");
				expect(spawnMock).not.toHaveBeenCalled();
				const helperWarns = (warnMock.mock.calls as unknown[][]).filter(
					(c) => typeof c[1] === "object" && c[1] !== null,
				) as WarnArgs[];
				expect(helperWarns.length).toBe(1);
				const [, meta] = helperWarns[0];
				expect(meta.callerLabel).toBe("test-caller");
				expect(meta.failureMode).toBe("spawn");
			});
		}
	}
});
