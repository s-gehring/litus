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
  tests/            # *.spec.ts Playwright tests
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

1. Copy `scenarios/happy-path.json` to `scenarios/<my-scenario>.json`. The JSON schema is documented at `specs/001-e2e-browser-tests/contracts/scenario-script.schema.json`.
2. Edit the `claude` list (one entry per `claude` invocation, FIFO across the whole scenario — including side calls like `QuestionDetector.classifyWithHaiku` and `ReviewClassifier.classify`). Each entry uses `{"events": [...]}` for `--output-format stream-json` (pipeline steps) or `{"text": "..."}` for `--output-format text` (detectors/classifier). Probe invocations like `claude --version` / `gh --version` are short-circuited inside the fake and do NOT consume a scenario slot. The `Summarizer` (which would otherwise race the pipeline's claude spawns) is skipped entirely when `LITUS_E2E_SCENARIO` is set, so scenarios do not need to script its calls. The `gh` map keys subcommands like `"pr create"`, `"pr merge"`, `"auth status"`.
3. Add a new spec under `tests/` that declares `test.use({ scenarioName: "<my-scenario>" })` and composes helpers from `../helpers`.
4. Run `bun run test:e2e`.

## Authoring rules

- No raw selectors in `tests/*.spec.ts`. Selectors live in `pages/*.ts`; user-facing actions live in `helpers/*.ts`.
- Uncovered invocations fail loudly: any unknown `claude` index or unknown `gh` subcommand key emits `[litus-e2e-fake:<name>] ...` on stderr and exits non-zero.

## Failure artifacts

On a failing test:

- `tests/e2e/test-results/<test>/trace.zip` — open with `bunx playwright show-trace <path>`
- `tests/e2e/test-results/<test>/test-failed-*.png` — final screenshot
- `tests/e2e/test-results/<test>/video.webm`
- `server.log` attached to the test — the captured server stdout/stderr

## CI

A dedicated GitHub Actions workflow (`.github/workflows/e2e.yml`) runs the suite on pull requests. It is configured as a **required status check** on the default branch (`master`); this is a repo-admin setting and lives outside this repo's tree.

## Troubleshooting

- **Real `claude` / `gh` was invoked** — ensure `bunx playwright install chromium` is run and that `PATH` in the spawned server env starts with the fakes dir (the harness enforces this).
- **Port already in use** — ephemeral ports are used; retry or check for orphaned server processes.
- **Sandbox leaked** — teardown is idempotent; safe to `rm -rf $TMPDIR/litus-e2e-*` between runs.

See also `specs/001-e2e-browser-tests/quickstart.md` for the end-to-end acceptance walkthrough.

## Spec files

- `tests/happy-path.spec.ts` — baseline end-to-end path (`scenarios/happy-path.json`)
- `tests/run-controls.spec.ts` — US1 workflow run-control surface: pause/resume, abort, full-auto merge, automation-mode toggle (`scenarios/run-controls.json`)
- `tests/mid-run-question.spec.ts` — US2 mid-run question handling in both manual and full-auto modes; asserts resume-call payload via the argv capture in `fakes/claude.ts` + `harness/claude-captures.ts` (`scenarios/mid-run-question.json`)
- `tests/review-feedback-loop.spec.ts` — US3 manual-mode feedback panel loop at the merge-pr pause, including iteration-history persistence (`scenarios/review-feedback-loop.json`)

US4 (merge-conflict resolution dispatch) and US5 (WebSocket reconnection resilience) from the `001-workflow-interaction-tests` feature are **not yet implemented**; see `specs/001-workflow-interaction-tests/tasks.md` for the remaining T017–T021 tasks.
