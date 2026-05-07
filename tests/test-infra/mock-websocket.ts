import { type CallTracker, createCallTracker } from "./call-tracker";

export interface MockWebSocket {
	mock: {
		send(message: string): void;
		close(code?: number): void;
		publish(topic: string, message: string): void;
		subscribe(topic: string): void;
		data: { helloReceived: boolean; socketId?: string };
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
		close(code?: number): void {
			tracker.calls.push({ method: "close", args: code === undefined ? [] : [code] });
		},
		publish(topic: string, message: string): void {
			tracker.calls.push({ method: "publish", args: [topic, message] });
		},
		subscribe(topic: string): void {
			tracker.calls.push({ method: "subscribe", args: [topic] });
		},
		// Default mock state: past the version handshake. Tests that
		// exercise the handshake itself flip this to false.
		data: { helloReceived: true } as { helloReceived: boolean; socketId?: string },
	};

	return { mock, tracker, sentMessages };
}
