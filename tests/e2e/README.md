# Litus E2E Browser Test Suite

Browser-driven end-to-end tests covering the Litus primary-workflow happy path: specification creation → pipeline run → merged PR. The suite boots the real production server build in a hermetic sandbox, prepends scripted fake `claude` and `gh` binaries to `PATH`, and drives the UI in Chromium via Playwright.

## Prerequisites

- Bun (version pinned in `package.json` `engines.bun`)
- Internet access on first run so `bunx playwright install chromium` can download the browser (subsequent runs are offline-capable)

## Run locally

```bash
bun install
bunx playwright install --with-deps chromium
bun run test:e2e
```

`test:e2e` rebuilds the client bundle (`bun run build:client`) and invokes Playwright with `tests/e2e/playwright.config.ts`.

## Directory layout

```
tests/e2e/
  harness/          # Sandbox + server + fixture composition
  fakes/            # Fake `claude` + `gh` binaries (POSIX shims + Windows .cmd)
  pages/            # Page objects (selectors live here)
  helpers/          # Named user actions composing page objects
  scenarios/        # *.json scripts consumed by fake CLIs
  tests/            # *.e2e.ts Playwright tests
  playwright.config.ts
```

## Harness lifecycle (per test)

1. `beforeEach` creates a per-test sandbox via `fs.mkdtemp`.
2. `$HOME` / `$USERPROFILE` in the spawned server's env are redirected to the sandbox.
3. The fakes directory is prepended to `PATH` (with any pre-existing `claude`/`gh` directories stripped).
4. `LITUS_E2E_SCENARIO` is set to the absolute scenario path; `LITUS_E2E_COUNTER` tracks FIFO `claude` invocation indices.
5. The server is spawned on an ephemeral port (`PORT=0`); stdout/stderr are captured to `<sandbox>/server.log`.
6. Harness waits for `Litus running at http://localhost:<port>` readiness marker.
7. Test runs; on failure the server log is attached via `testInfo.attach` and trace/screenshot/video land under `test-results/`.
8. `afterEach` stops the server (SIGTERM with SIGKILL fallback), removes the sandbox recursively.

## Adding a new scenario

1. Copy `scenarios/happy-path.json` (or one of the peripheral fixtures — `scenarios/peripheral-alerts.json`, `scenarios/peripheral-artifacts.json`, `scenarios/peripheral-concurrency.json` — each covers a different surface and is a better starting point than `happy-path` for non-happy-path coverage) to `scenarios/<my-scenario>.json`. The JSON schema is documented at `specs/001-e2e-browser-tests/contracts/scenario-script.schema.json`.
2. Edit the `claude` list (one entry per `claude` invocation, FIFO across the whole scenario — including side calls like `QuestionDetector.classifyWithHaiku` and `ReviewClassifier.classify`). Each entry uses `{"events": [...]}` for `--output-format stream-json` (pipeline steps) or `{"text": "..."}` for `--output-format text` (detectors/classifier). Probe invocations like `claude --version` / `gh --version` are short-circuited inside the fake and do NOT consume a scenario slot. The `Summarizer` (which would otherwise race the pipeline's claude spawns) is skipped entirely when `LITUS_E2E_SCENARIO` is set, so scenarios do not need to script its calls. The `gh` map keys subcommands like `"pr create"`, `"pr merge"`, `"auth status"`.
3. Add a new spec under `tests/` that declares `test.use({ scenarioName: "<my-scenario>" })` and composes helpers from `../helpers`.
4. Run `bun run test:e2e`.

### Per-subcommand FIFO for `gh` responses

The `gh` map values may be either a single `GhResponse` or an **array** of them. Arrays unlock ordered, stateful responses for a subcommand across successive calls in the same test — e.g. scripting `pr checks` to return a failed check on the first poll and a passing check on the second.

Selection rules (implemented in `tests/e2e/fakes/gh.ts`):

1. **Match-first for `matchFlags`.** Any array entry that defines a non-empty `matchFlags` object is tried first, in declaration order. The first entry whose `matchFlags` fully match the invocation's flags wins, and it does **not** consume a FIFO slot (matching is content-addressed, not order-sensitive).
2. **FIFO across unconstrained entries.** Entries without `matchFlags` (or with an empty `matchFlags`) are consumed one per call, keyed on the normalised positional prefix (`"pr checks"`, `"pr view"`, …). Each call to that subcommand advances the per-key counter by one.
3. **Last entry repeats indefinitely.** Once the FIFO index passes the end of the unconstrained list, the final unconstrained entry is returned for every subsequent call. This lets authors script only the transitions that matter (e.g. one `failure` then one `pass`) and rely on the fallback to absorb any extra polls without bookkeeping.
4. **Single-object entries never advance any counter** — they always return the same response.

See `scenarios/ci-failure-and-fix.json` (`pr checks` key) for a concrete example: a 2-entry array drives `monitor-ci` through `failure` → `pass` across the CI failure / fix / re-monitor loop.

## Authoring rules

- No raw selectors in `tests/*.e2e.ts`. Selectors live in `pages/*.ts`; user-facing actions live in `helpers/*.ts`.
- Uncovered invocations fail loudly: any unknown `claude` index or unknown `gh` subcommand key emits `[litus-e2e-fake:<name>] ...` on stderr and exits non-zero.

## Local recordings

Local (non-CI) runs of `bun run test:e2e` always produce the full set of recordings for **every** test, passing or failing, under `tests/e2e/test-results/<test>/`:

- `video.webm` — full browser-session video (`use.video: "on"`)
- `*.png` — final-state screenshot (`use.screenshot: "on"`)
- `trace.zip` — Playwright trace, viewable with `bunx playwright show-trace <path>` (`use.trace: "on"`)

The toggle is `process.env.CI` in `playwright.config.ts`: when `CI` is unset (the default on a developer workstation), all three keys resolve to `"on"`. When `CI` is truthy (GitHub Actions sets `CI=true` automatically), they resolve to the CI values described in **CI failure artifacts** below — `screenshot: only-on-failure`, `video: retain-on-failure`, `trace: retain-on-failure` — so CI keeps artifacts only for failing tests, exactly as before.

The output directory (`tests/e2e/test-results/`) is gitignored, so local recordings never leak into commits.

## CI failure artifacts

On CI (`process.env.CI` truthy), a failing test produces:

- `tests/e2e/test-results/<test>/trace.zip` — open with `bunx playwright show-trace <path>`
- `tests/e2e/test-results/<test>/test-failed-*.png` — final screenshot (this exact filename is specific to `screenshot: "only-on-failure"`; locally, see **Local recordings** above for the differing filename pattern)
- `tests/e2e/test-results/<test>/video.webm`
- `server.log` attached to the test — the captured server stdout/stderr

## CI

A dedicated GitHub Actions workflow (`.github/workflows/e2e.yml`) runs the suite on pull requests. It is configured as a **required status check** on the default branch (`master`); this is a repo-admin setting and lives outside this repo's tree.

> [!IMPORTANT]
> CI currently runs on `ubuntu-latest` only. Tests that exercise multi-line agent prompts (e.g. the `artifacts` and `fix-implement` step prompts) can pass on Linux but fail on Windows because of how the fake CLI shims forward arguments — see **Fake CLI shims (Windows vs POSIX)** below. Adding a `windows-latest` job to `.github/workflows/e2e.yml` would close this coverage gap; until then, regressions in multi-line argument handling are only caught by local Windows runs.

## Fake CLI shims (Windows vs POSIX)

The fakes (`claude`, `gh`, `git`, `uv`, `uvx`) are TypeScript files invoked through a thin platform-specific shim placed on `PATH`:

- **POSIX** (Linux, macOS): an extensionless shell script (`#!/usr/bin/env bash` + `exec bun run "$(dirname "$0")/<name>.ts" "$@"`). Bash's `"$@"` preserves every argument byte-for-byte, including embedded newlines.
- **Windows**: a compiled `.exe` produced by `bun build --compile --target=bun-windows-x64`, generated on demand by `tests/e2e/build-fakes.ts` and dropped next to the `.cmd` shim. `PATHEXT` defaults to `.COM;.EXE;.BAT;.CMD;…`, so the `.exe` always wins over the `.cmd` when both are present.

The build runs automatically as part of `bun run test:e2e` (via the `build:e2e-fakes` script) and is a no-op on non-Windows platforms. Compiled `.exe` files are gitignored.

### Why the `.cmd` shim is not enough

The original Windows shim (`@bun run "%~dp0<name>.ts" %*`) forwards arguments via `cmd.exe`'s `%*` expansion. cmd.exe re-tokenises the command line text it received from the OS, and its tokeniser splits on newline — so any multi-line argument is truncated at the first newline AND every argument that follows is dropped. The `fix-implement` and `artifacts` step prompts are multi-line, so their full payload (including the manifest path embedded later in the prompt) never reached the fake — the steps errored with `"artifacts prompt missing manifest path"` and `"called with --output-format text but scenario entry has no \`text\`"` respectively. The `.exe` route bypasses cmd.exe entirely; arguments flow through libuv's `CreateProcess` argv unmodified.

The `.cmd` files remain in the tree as a fallback so a fresh checkout that hasn't run the build script still produces a recognisable error from the fake instead of a confusing "command not found".

## Troubleshooting

- **Real `claude` / `gh` was invoked** — ensure `bunx playwright install chromium` is run and that `PATH` in the spawned server env starts with the fakes dir (the harness enforces this).
- **Port already in use** — ephemeral ports are used; retry or check for orphaned server processes.
- **Sandbox leaked** — teardown is idempotent; safe to `rm -rf $TMPDIR/litus-e2e-*` between runs.
- **Simulating a mid-run WebSocket drop** — `await dropWebSocket({ server })` from `../helpers` closes the active server-side socket without killing the server; tolerant of no-active-socket and double-invocation. Gated on `LITUS_E2E_SCENARIO`, unreachable in production — see `specs/001-ws-reconnect-e2e/contracts/drop-ws.md` for the full contract.

## Spec files

- `tests/happy-path.e2e.ts` — baseline end-to-end path (`scenarios/happy-path.json`)
- `tests/run-controls.e2e.ts` — workflow run-control surface: pause/resume, abort, full-auto merge, automation-mode toggle (`scenarios/run-controls.json`)
- `tests/mid-run-question.e2e.ts` — mid-run question handling in both manual and full-auto modes; asserts resume-call payload via the argv capture in `fakes/claude.ts` + `harness/claude-captures.ts` (`scenarios/mid-run-question.json`)
- `tests/review-feedback-loop.e2e.ts` — manual-mode feedback panel loop at the merge-pr pause, including iteration-history persistence (`scenarios/review-feedback-loop.json`)
- `tests/ws-reconnect.e2e.ts` — mid-run WebSocket drop: asserts disconnected indicator, reconnect, `workflow:list` re-hydration, and post-reconnect alert delivery (`scenarios/ws-reconnect.json`)

Merge-conflict resolution dispatch is **not yet implemented**.
