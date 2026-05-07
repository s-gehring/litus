// Wire-protocol surface — re-exported from `@litus/protocol`.
//
// This file is a backward-compatibility shim during the workspace
// migration. The canonical location for these types and constants is
// `packages/protocol/`. Importers should migrate to `@litus/protocol`
// directly; this shim will be removed when the migration finishes.

export {
	type Channel,
	type ClientMessage,
	DELTA_FLUSH_TIMEOUT_MS,
	type ServerMessage,
	type StateChange,
	type StateChangeAction,
	type StateChangeListener,
	type StateChangeScope,
	TELEGRAM_TOKEN_SENTINEL,
} from "@litus/protocol";
