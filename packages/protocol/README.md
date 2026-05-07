# @litus/protocol

Wire-protocol contract between the Litus server and any client. Single source of truth for the WebSocket frame schemas, the version handshake, and the error frame.

## Surface

The package exports:

- `ServerMessage` / `ClientMessage` — `z.infer<>` of the discriminated unions over every wire frame.
- `serverMessageSchema` / `clientMessageSchema` — the Zod schemas used for `safeParse` validation at the server's WebSocket boundary and (in dev/test only) at every `sendTo` / `broadcast` site.
- `errorFrameSchema` / `errorCodeSchema` — the unified `error` frame and its `code` enum.
- `serverHelloSchema` / `clientHelloSchema` — version-handshake frames (`hello` / `client:hello`).
- `validateOutgoingInDev(msg)` — dev/test-only outbound assertion. No-op in production.
- `Channel` / `channelSchema` — server-internal routing target for free-text frames.
- `StateChange` / `StateChangeListener` / `StateChangeScope` / `StateChangeAction` — in-process observer types (do not cross the wire).
- Constants: `DELTA_FLUSH_TIMEOUT_MS = 50`, `TELEGRAM_TOKEN_SENTINEL = "***configured***"`, `CLOSE_CODE_PROTOCOL = 4001`.
- `PROTOCOL_VERSION` — current `{ major: 1, minor: 0 }`.
- All shared dependent types (`AppConfig`, `WorkflowState`, `Alert`, …) referenced by wire variants.

## Version handshake

On `websocket.open`, the server emits `{ type: "hello", protocolVersion }` as the **first** frame. The client emits `{ type: "client:hello", protocolVersion }` as **its** first frame after the connection opens (concurrent send — the client does not need to wait for the server's hello).

The server tracks `helloReceived: boolean` per socket. Until set:

- A non-`client:hello` first frame → typed `error` with `code: "missing_protocol_version"` + `ws.close(CLOSE_CODE_PROTOCOL)`.
- A `client:hello` whose `protocolVersion.major` differs from the server's → typed `error` with `code: "version_mismatch"` and `details: { observed, expected }` + `ws.close(CLOSE_CODE_PROTOCOL)`.
- A `client:hello` whose `protocolVersion.major` matches → handshake completes.

After the handshake, a second `client:hello` is accepted as a no-op.

`CLOSE_CODE_PROTOCOL = 4001` is the WebSocket close code used for both flavors of handshake failure.

## Versioning policy

Bump rules for `PROTOCOL_VERSION`:

### Minor bump (M.N → M.N+1)

A change is **minor** if every existing client continues to work without modification:

- Add an optional field to an existing variant.
- Add a new `ServerMessage` variant.
- Add a new `ClientMessage` variant.
- Add a new value to the `errorCodeSchema` enum.
- Add a new value to a closed enum *only* in cases where existing clients ignore unknown enum values.

### Major bump (M.N → M+1.0)

A change is **major** if any existing client could observe a regression:

- Remove any field from any variant.
- Rename any field on any variant.
- Change a field's type in a non-strictly-extending way (e.g. `string` → `number`, `string` → `string | number`).
- Remove a `ServerMessage` or `ClientMessage` variant.
- Rename a `ServerMessage` or `ClientMessage` variant (i.e. change its `type` discriminator).
- Tighten the constraints on an existing field (e.g. change a previously-permissive enum to a stricter one).

A major bump emits `error` with `code: "version_mismatch"` to clients pinned at the prior major and closes their sockets with `CLOSE_CODE_PROTOCOL = 4001`.

## Adding a new wire-protocol message

See `specs/001-protocol-package/quickstart.md` in the repo for the contributor flow. The exhaustiveness guard in `packages/protocol/tests/exhaustiveness.test.ts` fails the suite if a new schema variant is added without a corresponding round-trip fixture, so adding a variant is mechanically forced to update the test surface in the same change.

## Files

- `src/index.ts` — barrel.
- `src/server-messages.ts` / `src/client-messages.ts` — the discriminated unions.
- `src/error-frame.ts` — error-frame contract (FR-021).
- `src/hello-frame.ts` — hello-frame contract (FR-010..FR-014).
- `src/version.ts` — `PROTOCOL_VERSION` and `protocolVersionSchema`.
- `src/validate.ts` — `validateOutgoingInDev` helper.
- `src/channel.ts` — `Channel` discriminated union.
- `src/state-change.ts` — in-process observer types.
- `src/constants.ts` — `DELTA_FLUSH_TIMEOUT_MS`, `TELEGRAM_TOKEN_SENTINEL`, `CLOSE_CODE_PROTOCOL`.
- `src/shared-types.ts` — type aliases referenced by wire variants.
- `tests/` — frontend-agnostic round-trip + handshake suites (run with `bun --cwd packages/protocol test`).
