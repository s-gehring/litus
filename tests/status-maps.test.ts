import { describe, expect, test } from "bun:test";
import { STATUS_LABELS } from "../src/client/components/status-maps";

describe("STATUS_LABELS differentiation", () => {
	test("waiting_for_input maps to 'Waiting: Input'", () => {
		expect(STATUS_LABELS.waiting_for_input).toBe("Waiting: Input");
	});

	test("waiting_for_dependencies maps to 'Waiting: Deps'", () => {
		expect(STATUS_LABELS.waiting_for_dependencies).toBe("Waiting: Deps");
	});

	test("waiting labels are distinct from each other", () => {
		expect(STATUS_LABELS.waiting_for_input).not.toBe(STATUS_LABELS.waiting_for_dependencies);
	});
});
