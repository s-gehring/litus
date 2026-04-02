# Code Review 3: Multi LLM Agent Orchestrator

**Date**: 2026-04-02  
**Branch**: `001-build-multi-llm`  
**Reviewer**: Automated review (post-CR2 fixes)  
**Baseline**: 70 tests reported passing. TypeScript compiles cleanly. Client bundle builds. Bun not available in PATH to verify test execution independently.

---

## Critical Issues

### CR3-001: FR-013 contradiction — worktree cleanup was added despite being explicitly out of scope

The spec at FR-013 states: "Worktree cleanup is explicitly out of scope for MVP." Clarifications section reiterates: "Worktree is preserved for review. Worktree cleanup is out of scope for MVP." However, CR2-008 added `removeWorktree()` which calls `git worktree remove --force` on every terminal state (completed, cancelled, error) and before starting a new workflow.

This directly violates the spec. The user explicitly asked for worktrees to be preserved so they can manually review the agent's work product. A workflow that completes and immediately deletes the worktree removes the user's ability to inspect what was done. This is a functional regression against a stated requirement.

**Action**: Remove the `removeWorktree` call from `cleanupWorkflow()` and delete the `removeWorktree` method from `WorkflowEngine`, or guard it behind an explicit user-triggered action.

### CR3-002: Question detection races with workflow completion

In `server.ts:94-115`, when the heuristic detects an uncertain question, `classifyWithHaiku()` is called asynchronously (fire-and-forget). By the time Haiku responds, the workflow may have already transitioned to `completed` or `error`. The code has a try/catch around the transition, but this means:
1. A question notification (`workflow:question`) may be broadcast to clients after the workflow has already ended.
2. The client receives `workflow:question` for a workflow that is already in a terminal state, potentially showing a stale question panel.

The handler should check `engine.getWorkflow()?.status === "running"` before calling `engine.setQuestion` and `engine.transition`.

---

## Major Issues

### CR3-003: `sendAnswer` kills the process without waiting for stream reader to finish

In `cli-runner.ts:54-55`, `sendAnswer` calls `entry.process.kill()` and then `this.running.delete(workflowId)`. However, `streamOutput()` has an active `while (true)` loop reading from the process's stdout. After the process is killed:
1. The reader may throw an error (caught by the outer try/catch in `streamOutput`).
2. `streamOutput` then awaits `proc.exited`, gets the exit code, and checks `this.running.get(workflowId)`. Since `sendAnswer` already deleted the entry, `currentEntry` is `null`, so neither `onComplete` nor `onError` fires — which is correct.
3. But the new process is already started by `sendAnswer` and also has `streamOutput` running.

The concern: if the old `streamOutput` hasn't reached its check yet and `sendAnswer` re-inserts a new entry for the same `workflowId`, there's a brief window where both the old and new `streamOutput` are active on the same `workflowId`. The guard `currentEntry.process === proc` prevents double-completion, but the old reader could still emit `onOutput` events from the killed process's remaining buffered data, interleaving with the new process's output.

**Action**: Consider awaiting or flagging the old reader as stale before starting the new process.

### CR3-004: Summarizer tests still use `setTimeout` for async assertions

Despite CR2-016 fixing timing-based tests in `cli-runner.test.ts`, `summarizer.test.ts` still uses `await new Promise((r) => setTimeout(r, 50))` in 4 out of 8 tests (lines 38, 55, 66, 85). These are the same class of flaky timing-based assertions that CR2-016 identified. The same deferred promise pattern should be applied here.

### CR3-005: `workflow-engine.test.ts` uses `afterAll` without importing it in the describe scope

`workflow-engine.test.ts:215` imports `afterAll` from `"bun:test"` at the bottom of the file, outside the `describe` block. The `afterAll` on line 27 is called inside the `describe` block but `afterAll` isn't in scope at that point — it relies on hoisting behavior. This works in practice but is confusing and fragile. Additionally, `mock` is imported at line 2 but never used.

### CR3-006: `handleStreamEvent` treats `any` typed event without validation

`cli-runner.ts:167`: `handleStreamEvent(entry, event: any)` accesses `event.session_id`, `event.type`, `event.message?.content`, `event.delta?.text`, `event.result` without any type narrowing or validation. If the Claude Code CLI changes its stream-json format, this will silently produce wrong behavior rather than surfacing an error. At minimum, the event types from the CLI should be documented as a type union, even if not exhaustively validated.

---

## Minor Issues

### CR3-007: `onSessionId` callback is optional but always provided

In `cli-runner.ts:7`, `onSessionId` is declared as `onSessionId?: (sessionId: string) => void`. However, the only call site in `server.ts:151` always provides it. The optional marker suggests it might not be called, but the server always passes it. Consider making it required for API clarity, or documenting why it's optional.

### CR3-008: `cleanupWorkflow` in `server.ts` calls `engine.removeWorktree` with `.catch(() => {})`

Beyond the FR-013 issue (CR3-001), the error swallowing pattern `.catch(() => {})` means any `git worktree remove` failures — disk permission errors, locked files on Windows — are silently ignored. If this functionality is kept (after addressing CR3-001), at minimum log the error.

### CR3-009: `createWorktree` uses a manual Promise wrapper around `Bun.spawn`

`workflow-engine.ts:108-132`: The `createWorktree` method wraps `Bun.spawn` in `new Promise()` manually. This is unnecessary complexity — `proc.exited` is already a promise. The method could be simplified to an async function that awaits `proc.exited` directly, matching the pattern used in `removeWorktree`.

### CR3-010: `content_block_delta` handler in `handleStreamEvent` may emit partial words

`cli-runner.ts:183`: The handler emits `event.delta.text` directly via `onOutput`. Since `content_block_delta` events contain partial token text (sometimes individual characters or word fragments), the output log will receive many small fragments. Combined with `appendOutput` creating a new `<div>` per call, this produces a DOM element per token fragment — potentially hundreds of elements per sentence. This is a significant contributor to the unbounded DOM growth noted in CR2's architecture observations.

### CR3-011: [pre-existing] `$` utility is duplicated across client files

Both `src/client/app.ts:6` and `src/client/components/workflow-window.ts:3` and `src/client/components/question-panel.ts:3` each define `const $ = (sel: string) => document.querySelector(sel) as HTMLElement`. This could be a single shared utility, though for 3 files the duplication is marginal.

### CR3-012: `EXCLUSION_PATTERNS` regex for "let me" has a negative lookahead that may confuse

`question-detector.ts:24`: `Let me (?!know\b)` uses a negative lookahead to allow "Let me know" through while excluding "Let me read/create/etc.". The full pattern is `^(here'?s?|this is|i('ll| will)|let me (?!know\b)|now i|i('m| am))\b` — the `\b` at the end applies to the last alternative in the group, not to "let me". This means "let me" matches "let me know" only if the lookahead fails, which it does because "know" follows — so "let me know" is NOT excluded, which is the intended behavior. However, the regex is complex enough that a comment explaining the intent would prevent future maintenance errors.

### CR3-013: `WorkflowState` duplicates most of `Workflow` fields

`types.ts:44-55`: `WorkflowState` is nearly identical to `Workflow` minus `sessionId`. This could use `Omit<Workflow, 'sessionId'>` to avoid field drift. If `Workflow` gains a new field, `WorkflowState` won't include it unless manually added — and conversely, `getWorkflowState()` in `server.ts` must be manually updated.

---

## Test Quality Issues

### CR3-014: No test for `classifyWithHaiku` integration

`classifyWithHaiku` is called from `server.ts` for uncertain question detections (the CR2-001 fix), but there is no test that verifies this integration. The `question-detector.test.ts` tests the heuristic `detect()` method thoroughly but does not test `classifyWithHaiku`. There is no mock of the Anthropic SDK in that test file. The server-side integration (heuristic returns uncertain -> Haiku called -> question surfaced or suppressed) is entirely untested.

### CR3-015: `workflow-engine.test.ts` does not test `removeWorktree`

The `removeWorktree` method added in CR2-008 has no test coverage. The test file mocks `Bun.spawn` but never exercises `removeWorktree` to verify it calls git with the correct arguments, handles errors gracefully, or skips when worktreePath is null.

### CR3-016: No test for `sendAnswer` / resume behavior

`cli-runner.test.ts` tests `start`, `kill`, and `killAll`, but `sendAnswer` (the resume-with-answer flow) is not tested at all. This is a critical path — answering questions is a P1 user story. A test should verify: the old process is killed, a new process is spawned with `--resume <sessionId>`, and the correct `cwd` is used.

---

## Spec Compliance Check

| Requirement | Status | Notes |
|-------------|--------|-------|
| FR-001: Web UI on localhost | Pass | `Bun.serve` on configurable port, defaults to 3000 |
| FR-002: Single workflow window with status | Pass | All 6 statuses implemented and styled |
| FR-003: Specification input, start disabled while active | Pass | `canStart` logic in `workflow-window.ts` |
| FR-004: Git worktree per workflow | Pass | `createWorktree` in `workflow-engine.ts` |
| FR-005: Claude Code CLI invocation in worktree | Pass | `cli-runner.ts` spawns with `cwd: worktreePath` |
| FR-006: Session ID persistence | Pass | `--resume` with extracted session ID |
| FR-007: Question detection from output | Pass | `question-detector.ts` with heuristics |
| FR-008: Question surfacing with uncertain/skip | Pass | Haiku fallback wired, skip button shown |
| FR-009: Answer relay to same session | Pass | `sendAnswer` uses `--resume` |
| FR-010: Haiku summary generation | Pass | `summarizer.ts` with periodic triggering |
| FR-011: Near real-time status updates | Pass | WebSocket streaming |
| FR-012: Cancel at any time | Pass | `handleCancel` kills process, transitions to cancelled |
| FR-013: Worktree cleanup out of scope | **Fail** | `removeWorktree` actively deletes worktrees (CR3-001) |

---

## Summary of Required Actions

| Priority | Issue | Action |
|----------|-------|--------|
| Critical | CR3-001 | Remove worktree cleanup — violates FR-013 |
| Critical | CR3-002 | Guard async Haiku question detection against stale workflow state |
| Major | CR3-003 | Address potential output interleaving in sendAnswer |
| Major | CR3-004 | Replace setTimeout in summarizer tests with deterministic signals |
| Major | CR3-005 | Fix afterAll import placement in workflow-engine tests |
| Major | CR3-006 | Type the stream event or add runtime validation |
| Minor | CR3-007 | Make onSessionId required or document optional rationale |
| Minor | CR3-008 | Log errors in removeWorktree catch (if kept) |
| Minor | CR3-009 | Simplify createWorktree to async/await pattern |
| Minor | CR3-010 | Batch content_block_delta fragments before appending to DOM |
| Minor | CR3-013 | Use `Omit<Workflow, 'sessionId'>` for WorkflowState |
| Test | CR3-014 | Add tests for classifyWithHaiku integration |
| Test | CR3-015 | Add tests for removeWorktree |
| Test | CR3-016 | Add tests for sendAnswer/resume flow |

---

## Review Response (2026-04-02)

**Baseline after fixes**: 77 tests pass (up from 70). TypeScript compiles cleanly (`tsc --noEmit`). Client bundle builds successfully.

### CR3-001: FR-013 contradiction — worktree cleanup removed — FIXED

Removed the `removeWorktree()` method from `WorkflowEngine` entirely and removed the `engine.removeWorktree()` call from `cleanupWorkflow()` in `server.ts`. Worktrees are now preserved after workflow completion, cancellation, and error, per FR-013: "Worktree cleanup is explicitly out of scope for MVP." The user can manually inspect the worktree contents after a workflow ends.

**Changed**: `src/workflow-engine.ts` (method removed), `src/server.ts` (call removed from `cleanupWorkflow`).

### CR3-002: Question detection race with workflow completion — FIXED

Added a guard in the async Haiku callback that checks `engine.getWorkflow()?.status === "running"` and verifies the workflow ID still matches before calling `engine.setQuestion` and `engine.transition`. If the workflow has already transitioned to a terminal state by the time Haiku responds, the question is silently dropped. This prevents stale `workflow:question` broadcasts to clients after a workflow has ended.

**Changed**: `src/server.ts` — added status guard in the `classifyWithHaiku().then()` callback.

### CR3-003: `sendAnswer` output interleaving — FIXED

Added a `stale: boolean` flag to the `RunningProcess` interface. When `sendAnswer` is called, the old entry is marked `stale = true` before killing the process. The `streamOutput` loop checks `entry.stale` before emitting any output or processing events. The `handleStreamEvent` method also returns early if the entry is stale. This prevents the old reader from emitting buffered output that would interleave with the new process's output. The same `stale` flag is set in `kill()` for consistency.

**Changed**: `src/cli-runner.ts` — `stale` flag on `RunningProcess`, checks in `streamOutput`, `handleStreamEvent`, `sendAnswer`, and `kill`.

### CR3-004: Summarizer tests timing — FIXED

Replaced all `await new Promise((r) => setTimeout(r, 50))` calls in `summarizer.test.ts` with a `flushAsync()` helper that awaits two microtask ticks via `Promise.resolve()`. Since the mock `Anthropic` client returns immediately-resolving promises, two microtask flushes are sufficient to let the fire-and-forget `.then()` chain complete. This eliminates the timing-based flakiness entirely.

**Changed**: `tests/summarizer.test.ts` — full rewrite of async waiting pattern.

### CR3-005: `afterAll` import placement — FIXED

Moved the `afterAll` import to the top of `workflow-engine.test.ts` alongside the other `bun:test` imports. Removed the stale duplicate import at the bottom of the file. Also removed the unused `mock` import.

**Changed**: `tests/workflow-engine.test.ts` — consolidated imports at top.

### CR3-006: `handleStreamEvent` typed event — FIXED

Added a `CLIStreamEvent` interface to `cli-runner.ts` that documents the expected shape of Claude Code CLI stream-json events. The interface uses optional fields with a `[key: string]: unknown` index signature for forward compatibility. The `handleStreamEvent` method now accepts `CLIStreamEvent` instead of `any`, providing type safety for known fields while remaining resilient to CLI format changes.

**Changed**: `src/cli-runner.ts` — new `CLIStreamEvent` interface, updated `handleStreamEvent` signature.

### CR3-007: `onSessionId` made required — FIXED

Changed `onSessionId` from optional (`?`) to required in the `CLICallbacks` interface. The only consumer (server.ts) always provides it, and the session ID is critical for the resume/answer flow. Updated the call site from `onSessionId?.()` to `onSessionId()`. All test callbacks now include `onSessionId`.

**Changed**: `src/cli-runner.ts` (interface), all test files (callbacks).

### CR3-008: `removeWorktree` error logging — NOT APPLICABLE

This issue was about error swallowing in `removeWorktree`. Since CR3-001 removed the method entirely, this is no longer applicable.

### CR3-009: `createWorktree` simplified to async/await — FIXED

Replaced the manual `new Promise()` wrapper with a straightforward `async` function that `await`s `proc.exited` directly. The error path reads stderr inline with `await`. This matches the pattern used elsewhere in the codebase and eliminates the nested `.then()` callback chains.

**Changed**: `src/workflow-engine.ts` — `createWorktree` rewritten as async function.

### CR3-010: Delta fragment batching — FIXED

Added `deltaBuffer` and `deltaFlushTimer` fields to `RunningProcess`. When `content_block_delta` events arrive, their text is accumulated in `deltaBuffer` instead of being emitted immediately. A 50ms debounce timer flushes the buffer, batching multiple token fragments into a single `onOutput` call. The buffer is also flushed when non-delta events arrive (assistant messages, result) and when the stream ends. This reduces the number of DOM elements created from potentially hundreds per sentence to a manageable number.

**Changed**: `src/cli-runner.ts` — new `deltaBuffer`/`deltaFlushTimer` fields, `flushDeltaBuffer()` method, updated `handleStreamEvent` and `streamOutput`.

### CR3-011: `$` utility duplication — OUT OF SCOPE

This is a pre-existing pattern across 3 client files. Extracting a one-liner to a shared module adds a file and import for negligible benefit. The duplication is marginal for 3 files in a single-page MVP.

### CR3-012: Exclusion regex comment — FIXED

Added a comment above `EXCLUSION_PATTERNS` explaining the negative lookahead behavior: `"let me (?!know\b)"` excludes "let me read/create/..." but allows "let me know" through as a potential question indicator.

**Changed**: `src/question-detector.ts` — added clarifying comment.

### CR3-013: `WorkflowState` type — FIXED

Changed `WorkflowState` from a manually duplicated interface to `Omit<Workflow, "sessionId">`. Updated `getWorkflowState()` in `server.ts` to use destructuring (`const { sessionId: _, ...state } = w`) instead of manual field-by-field copying. This ensures `WorkflowState` automatically stays in sync when `Workflow` gains new fields.

**Changed**: `src/types.ts` (type definition), `src/server.ts` (`getWorkflowState` function).

### CR3-014: Tests for `classifyWithHaiku` — FIXED

Added 4 tests for `classifyWithHaiku` in `question-detector.test.ts`:
1. Returns `true` when Haiku confirms a question — also verifies correct model (`claude-haiku-4-5-20251001`) and `max_tokens` (10)
2. Returns `false` when Haiku rejects a question
3. Returns `false` on API error (graceful degradation)
4. Prevents concurrent classifications — second call returns `false` immediately while first is pending

The Anthropic SDK is mocked via `mock.module("@anthropic-ai/sdk")`.

**Changed**: `tests/question-detector.test.ts` — added `classifyWithHaiku` describe block with 4 tests.

### CR3-015: Tests for `removeWorktree` — NOT APPLICABLE

Since CR3-001 removed the `removeWorktree` method entirely, there is nothing to test. The existing `createWorktree` test (worktree creation failure) still covers the git worktree creation path.

### CR3-016: Tests for `sendAnswer`/resume — FIXED

Added 3 tests for `sendAnswer` in `cli-runner.test.ts`:
1. **Resume with correct args**: Verifies the old process is killed, the new spawn includes `--resume <sessionId>` and the answer text in `-p`, and uses the correct `cwd` from the original worktree path.
2. **Error on missing session ID**: When `sendAnswer` is called before a session ID is extracted, it calls `onError` with a descriptive message.
3. **No-op for non-existent workflow**: `sendAnswer` on an unknown workflow ID does not throw.

Also refactored the test file to use shared `makeWorkflow()` and `makeCallbacks()` helpers, reducing boilerplate across all tests.

**Changed**: `tests/cli-runner.test.ts` — added `sendAnswer` describe block, refactored helpers.

### Summary

| Issue | Resolution |
|-------|-----------|
| CR3-001 | **Fixed** — `removeWorktree` removed, worktrees preserved per FR-013 |
| CR3-002 | **Fixed** — Status guard in async Haiku callback |
| CR3-003 | **Fixed** — Stale flag prevents output interleaving |
| CR3-004 | **Fixed** — Deterministic `flushAsync()` replaces `setTimeout` |
| CR3-005 | **Fixed** — Imports consolidated at top of file |
| CR3-006 | **Fixed** — `CLIStreamEvent` interface added |
| CR3-007 | **Fixed** — `onSessionId` now required |
| CR3-008 | **N/A** — Removed with CR3-001 |
| CR3-009 | **Fixed** — Async/await pattern |
| CR3-010 | **Fixed** — Delta fragment batching with 50ms debounce |
| CR3-011 | **OOS** — Pre-existing, marginal duplication |
| CR3-012 | **Fixed** — Clarifying regex comment added |
| CR3-013 | **Fixed** — `Omit<Workflow, "sessionId">` |
| CR3-014 | **Fixed** — 4 tests for `classifyWithHaiku` |
| CR3-015 | **N/A** — Method removed in CR3-001 |
| CR3-016 | **Fixed** — 3 tests for `sendAnswer`/resume |

**13 of 16 items fixed. 2 not applicable (removed code). 1 out of scope (pre-existing). Test count: 70 → 77. All pass.**
