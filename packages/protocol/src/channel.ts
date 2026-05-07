// Routing target for a free-text server→client message. Not directly
// emitted on the wire — the server resolves a `Channel` to a concrete
// `workflow:output` / `epic:output` / `console:output` frame.

export type Channel =
	| { kind: "workflow"; workflowId: string }
	| { kind: "epic"; epicId: string }
	| { kind: "console" };
