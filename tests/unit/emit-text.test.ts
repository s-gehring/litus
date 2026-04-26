import { describe, expect, mock, test } from "bun:test";
import { createEmitText } from "../../src/server/emit-text";
import type { ServerMessage } from "../../src/types";

describe("createEmitText", () => {
	test("workflow channel emits workflow:output exactly once", () => {
		const broadcast = mock<(msg: ServerMessage) => void>(() => {});
		const emit = createEmitText(broadcast);
		emit({ kind: "workflow", workflowId: "wf-1" }, "hello");
		expect(broadcast).toHaveBeenCalledTimes(1);
		expect(broadcast).toHaveBeenCalledWith({
			type: "workflow:output",
			workflowId: "wf-1",
			text: "hello",
		});
	});

	test("epic channel emits epic:output exactly once", () => {
		const broadcast = mock<(msg: ServerMessage) => void>(() => {});
		const emit = createEmitText(broadcast);
		emit({ kind: "epic", epicId: "ep-2026-04-26-001" }, "Analyzed 5 files");
		expect(broadcast).toHaveBeenCalledTimes(1);
		expect(broadcast).toHaveBeenCalledWith({
			type: "epic:output",
			epicId: "ep-2026-04-26-001",
			text: "Analyzed 5 files",
		});
	});

	test("console channel emits console:output exactly once with no routing field", () => {
		const broadcast = mock<(msg: ServerMessage) => void>(() => {});
		const emit = createEmitText(broadcast);
		emit({ kind: "console" }, "git fetch took 2.4s");
		expect(broadcast).toHaveBeenCalledTimes(1);
		expect(broadcast).toHaveBeenCalledWith({
			type: "console:output",
			text: "git fetch took 2.4s",
		});
	});

	test("forwards empty text without throwing", () => {
		const broadcast = mock<(msg: ServerMessage) => void>(() => {});
		const emit = createEmitText(broadcast);
		expect(() => emit({ kind: "console" }, "")).not.toThrow();
		expect(broadcast).toHaveBeenCalledTimes(1);
		expect(broadcast).toHaveBeenCalledWith({ type: "console:output", text: "" });
	});
});
