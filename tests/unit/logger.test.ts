import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../src/logger";

describe("logger", () => {
	let infoSpy: ReturnType<typeof spyOn>;
	let warnSpy: ReturnType<typeof spyOn>;
	let errorSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		infoSpy = spyOn(console, "info").mockImplementation(() => {});
		warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		errorSpy = spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		infoSpy.mockRestore();
		warnSpy.mockRestore();
		errorSpy.mockRestore();
	});

	test("logger.info delegates to console.info with ISO timestamp prefix", () => {
		logger.info("hello", 42);
		expect(infoSpy).toHaveBeenCalledTimes(1);
		const [ts, ...rest] = infoSpy.mock.calls[0] as unknown[];
		expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		expect(rest).toEqual(["hello", 42]);
	});

	test("logger.warn delegates to console.warn with ISO timestamp prefix", () => {
		logger.warn("danger", { detail: true });
		expect(warnSpy).toHaveBeenCalledTimes(1);
		const [ts, ...rest] = warnSpy.mock.calls[0] as unknown[];
		expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		expect(rest).toEqual(["danger", { detail: true }]);
	});

	test("logger.error delegates to console.error with ISO timestamp prefix", () => {
		logger.error("boom");
		expect(errorSpy).toHaveBeenCalledTimes(1);
		const [ts, ...rest] = errorSpy.mock.calls[0] as unknown[];
		expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		expect(rest).toEqual(["boom"]);
	});

	test("timestamp is a valid ISO 8601 string", () => {
		logger.info("test");
		const ts = (infoSpy.mock.calls[0] as unknown[])[0] as string;
		expect(() => new Date(ts)).not.toThrow();
		expect(new Date(ts).toISOString()).toBe(ts);
	});
});
