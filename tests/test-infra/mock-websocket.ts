import { type CallTracker, createCallTracker } from "./call-tracker";

export interface MockWebSocket {
	mock: {
		send(message: string): void;
		close(): void;
		publish(topic: string, message: string): void;
		subscribe(topic: string): void;
	};
	tracker: CallTracker;
	sentMessages: string[];
}

/** Create a mock WebSocket with call tracking and message capture */
export function createMockWebSocket(): MockWebSocket {
	const tracker = createCallTracker();
	const sentMessages: string[] = [];

	const mock = {
		send(message: string): void {
			tracker.calls.push({ method: "send", args: [message] });
			sentMessages.push(message);
		},
		close(): void {
			tracker.calls.push({ method: "close", args: [] });
		},
		publish(topic: string, message: string): void {
			tracker.calls.push({ method: "publish", args: [topic, message] });
		},
		subscribe(topic: string): void {
			tracker.calls.push({ method: "subscribe", args: [topic] });
		},
	};

	return { mock, tracker, sentMessages };
}
