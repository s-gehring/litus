import type { Page } from "@playwright/test";

/**
 * Send a raw `epic:feedback` client message over the active WebSocket and
 * collect the next `epic:feedback:rejected` or `epic:feedback:accepted`
 * response. Useful for E2E tests that verify server-authoritative rejection
 * paths without navigating the UI.
 */
export async function submitEpicFeedbackRaw(
	page: Page,
	epicId: string,
	text: string,
): Promise<{
	type: "epic:feedback:accepted" | "epic:feedback:rejected";
	reasonCode?: string;
	reason?: string;
}> {
	return await page.evaluate(
		async ({ epicId, text }) => {
			return await new Promise((resolve, reject) => {
				const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
				const ws = new WebSocket(url);
				ws.onopen = () => {
					ws.send(JSON.stringify({ type: "epic:feedback", epicId, text }));
				};
				ws.onmessage = (ev) => {
					try {
						const msg = JSON.parse(String(ev.data));
						if (msg?.type === "epic:feedback:accepted" || msg?.type === "epic:feedback:rejected") {
							ws.close();
							resolve({
								type: msg.type,
								reasonCode: msg.reasonCode,
								reason: msg.reason,
							});
						}
					} catch {
						// ignore non-JSON
					}
				};
				ws.onerror = () => reject(new Error("ws error"));
				setTimeout(() => {
					ws.close();
					reject(new Error("epic feedback response timeout"));
				}, 10_000);
			});
		},
		{ epicId, text },
	);
}
