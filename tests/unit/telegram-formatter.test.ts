import { describe, expect, test } from "bun:test";
import {
	formatAlertForTelegram,
	TELEGRAM_MAX_TEXT_LENGTH,
} from "../../src/telegram/telegram-formatter";
import type { Alert, AlertType } from "../../src/types";

function makeAlert(overrides: Partial<Alert> = {}): Alert {
	return {
		id: "alert_test_0001",
		type: "workflow-finished",
		title: "Build feature X",
		description: "All tests passed.",
		workflowId: "wf_abc123",
		epicId: null,
		targetRoute: "/workflow/wf_abc123",
		createdAt: 1_700_000_000_000,
		seen: false,
		...overrides,
	};
}

const BASE_URL = "http://localhost:3000";

describe("formatAlertForTelegram — reserved block per type", () => {
	const labels: Record<AlertType, string> = {
		"workflow-finished": "Workflow finished",
		"epic-finished": "Epic finished",
		"question-asked": "Question asked",
		"pr-opened-manual": "PR opened (manual review)",
		error: "Error",
	};

	for (const [type, expectedLabel] of Object.entries(labels) as [AlertType, string][]) {
		test(`type ${type} renders label "${expectedLabel}", origin id, route link`, () => {
			const text = formatAlertForTelegram(
				makeAlert({
					type,
					workflowId: type === "epic-finished" ? null : "wf_xyz",
					epicId: type === "epic-finished" ? "ep_abc" : null,
					targetRoute: type === "epic-finished" ? "/epic/ep_abc" : "/workflow/wf_xyz",
				}),
				BASE_URL,
			);
			expect(text).toContain(`<b>${expectedLabel}</b>`);
			if (type === "epic-finished") {
				expect(text).toContain("<code>ep_abc</code>");
			} else {
				expect(text).toContain("<code>wf_xyz</code>");
			}
			expect(text).toContain('<a href="http://localhost:3000');
			expect(text).toContain(">Open in Litus</a>");
		});
	}
});

describe("formatAlertForTelegram — HTML escaping", () => {
	test("escapes <, >, & in title and description", () => {
		const text = formatAlertForTelegram(
			makeAlert({ title: "a<b>&c", description: "x>y<z&" }),
			BASE_URL,
		);
		expect(text).toContain("a&lt;b&gt;&amp;c");
		expect(text).toContain("x&gt;y&lt;z&amp;");
		// Safe HTML tags Litus emits must NOT be re-escaped.
		expect(text).toContain("<b>Workflow finished</b>");
	});
});

describe("formatAlertForTelegram — truncation", () => {
	test("description truncated with … so total ≤ 4096 chars", () => {
		const longDescription = "x".repeat(8000);
		const text = formatAlertForTelegram(makeAlert({ description: longDescription }), BASE_URL);
		expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT_LENGTH);
		expect(text.endsWith("…")).toBe(true);
		// Reserved fields must remain.
		expect(text).toContain("<b>Workflow finished</b>");
		expect(text).toContain("<code>wf_abc123</code>");
		expect(text).toContain(">Open in Litus</a>");
	});

	test("short payload is left intact (no ellipsis)", () => {
		const text = formatAlertForTelegram(makeAlert({ description: "ok" }), BASE_URL);
		expect(text.endsWith("…")).toBe(false);
	});

	test("HTML escaping happens BEFORE truncation budget check", () => {
		// All `<` characters expand to `&lt;` (3 extra chars each), so the budget
		// must be measured against the escaped representation.
		const description = "<".repeat(2000);
		const text = formatAlertForTelegram(makeAlert({ description }), BASE_URL);
		expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT_LENGTH);
	});

	test("reserved-block alone exceeding budget collapses to reserved + ellipsis", () => {
		// Pathological case: the title itself blows the 4096-char budget. The
		// formatter must still emit something within the limit (data-model §6).
		const hugeTitle = "T".repeat(5000);
		const text = formatAlertForTelegram(
			makeAlert({ title: hugeTitle, description: "ignored" }),
			BASE_URL,
		);
		expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT_LENGTH);
		expect(text.endsWith("…")).toBe(true);
	});

	test("empty description produces clean reserved-only output", () => {
		const text = formatAlertForTelegram(makeAlert({ description: "" }), BASE_URL);
		expect(text.endsWith("…")).toBe(false);
		expect(text.endsWith("\n")).toBe(false);
		expect(text).not.toContain("\n\n");
		expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT_LENGTH);
	});
});

describe("formatAlertForTelegram — attribute escaping", () => {
	test("targetRoute containing a literal quote is attribute-safe", () => {
		// Defensive: today's targetRoute values are safe by construction
		// (`/workflow/<id>`, `/epic/<id>`), but the encoder must still produce
		// HTML that Telegram will accept if a future caller forwards a stray `"`.
		const text = formatAlertForTelegram(
			makeAlert({ targetRoute: '/workflow/wf_"injected' }),
			BASE_URL,
		);
		// The raw `"` must be encoded inside the href attribute.
		expect(text).not.toContain('wf_"injected');
		expect(text).toContain("&quot;injected");
		// And the surrounding anchor structure stays intact.
		expect(text).toContain('<a href="');
		expect(text).toContain('">Open in Litus</a>');
	});
});
