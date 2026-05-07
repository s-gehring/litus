# @litus/protocol

Wire-protocol contract between the Litus server and any client. Single source of truth for the WebSocket frame schemas, the version handshake, and the error frame.

See [`../../specs/001-protocol-package/contracts/`](../../specs/001-protocol-package/contracts/) for the full per-variant contract documents:

- `server-messages.md`
- `client-messages.md`
- `error-frame.md`
- `version-handshake.md`

The versioning policy (minor- vs major-bump rules) is filled in by US3.
