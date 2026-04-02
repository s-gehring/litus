import { describe, test, expect } from "bun:test";
import { VALID_TRANSITIONS } from "../src/types";
import type { WorkflowStatus } from "../src/types";

describe("VALID_TRANSITIONS", () => {
  test("idle can only transition to running", () => {
    expect(VALID_TRANSITIONS.idle).toEqual(["running"]);
  });

  test("running can transition to waiting_for_input, completed, error, cancelled", () => {
    expect(VALID_TRANSITIONS.running).toEqual(["waiting_for_input", "completed", "error", "cancelled"]);
  });

  test("waiting_for_input can transition to running or cancelled", () => {
    expect(VALID_TRANSITIONS.waiting_for_input).toEqual(["running", "cancelled"]);
  });

  test("terminal states have no transitions", () => {
    expect(VALID_TRANSITIONS.completed).toEqual([]);
    expect(VALID_TRANSITIONS.cancelled).toEqual([]);
    expect(VALID_TRANSITIONS.error).toEqual([]);
  });

  test("all workflow statuses are covered", () => {
    const allStatuses: WorkflowStatus[] = [
      "idle", "running", "waiting_for_input", "completed", "cancelled", "error",
    ];
    for (const status of allStatuses) {
      expect(VALID_TRANSITIONS).toHaveProperty(status);
    }
  });
});
