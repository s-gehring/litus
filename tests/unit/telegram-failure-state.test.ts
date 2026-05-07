import { describe, expect, test } from "bun:test";
import {
	MAX_RECENT_FAILURES,
	TelegramFailureState,
} from "../../src/telegram/telegram-failure-state";

describe("TelegramFailureState ring buffer", () => {
	test("recordFailure inserts newest-first", () => {
		const state = new TelegramFailureState();
		state.recordFailure("a1", "first");
		state.recordFailure("a2", "second");
		const status = state.getStatus();
		expect(status.lastFailureReason).toBe("second");
		expect(status.unacknowledgedCount).toBe(2);
	});

	test("buffer caps at MAX_RECENT_FAILURES (20) entries", () => {
		const state = new TelegramFailureState();
		for (let i = 0; i < MAX_RECENT_FAILURES + 5; i++) {
			state.recordFailure(`a${i}`, `r${i}`);
		}
		// Cap is enforced; only the 20 newest count.
		expect(state.getStatus().unacknowledgedCount).toBe(MAX_RECENT_FAILURES);
		expect(state.getStatus().lastFailureReason).toBe(`r${MAX_RECENT_FAILURES + 4}`);
	});

	test("acknowledge zeros unacknowledgedCount but preserves lastFailureReason", () => {
		let now = 1_000;
		const state = new TelegramFailureState({ now: () => now });
		state.recordFailure("a", "boom");
		now = 2_000;
		state.recordFailure("b", "kaboom");
		now = 3_000;
		state.acknowledge();
		const status = state.getStatus();
		expect(status.unacknowledgedCount).toBe(0);
		expect(status.lastFailureReason).toBe("kaboom");
		expect(status.lastFailureAt).toBe(2_000);
	});

	test("subscribe listener fires on every mutation", () => {
		const state = new TelegramFailureState();
		const events: number[] = [];
		state.subscribe((s) => {
			events.push(s.unacknowledgedCount);
		});
		state.recordFailure("a", "x");
		state.recordFailure("b", "y");
		state.acknowledge();
		expect(events).toEqual([1, 2, 0]);
	});
});
