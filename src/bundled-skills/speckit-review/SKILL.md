---
name: speckit-review
description: Make a comprehensive review.
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: litus
disable-model-invocation: true
---

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty).

## Outline

1. Run `.specify/scripts/powershell/check-prerequisites.ps1 -Json -RequireTasks -IncludeTasks` from repo root and parse FEATURE_DIR and AVAILABLE_DOCS list. All paths must be absolute. For single quotes in args like "I'm Groot", use escape syntax: e.g 'I'\''m Groot' (or double-quote if possible: "I'm Groot").

2. **Check checklists status** (if FEATURE_DIR/checklists/ exists):
   - Scan all checklist files in the checklists/ directory
   - For each checklist, count:
     - Total items: All lines matching `- [ ]` or `- [X]` or `- [x]`
     - Completed items: Lines matching `- [X]` or `- [x]`
     - Incomplete items: Lines matching `- [ ]`
   - Assert that every item is completed, otherwise abort and suggest to the user to execute `speckit-implement` first.

3. Load and analyze the implementation context:
   - **REQUIRED**: Read tasks.md for the complete task list and execution plan
   - **REQUIRED**: Read plan.md for tech stack, architecture, and file structure
   - **IF EXISTS**: Read data-model.md for entities and relationships
   - **IF EXISTS**: Read contracts/ for API specifications and test requirements
   - **IF EXISTS**: Read research.md for technical decisions and constraints
   - **IF EXISTS**: Read quickstart.md for integration scenarios

4. Analyse the implemented code (as in this current repository state as opposed to the current `master` branch), regarding the following items:
   - The implementation MUST be correctly implementing the specified behavior.
   - The implementation SHOULD be minimal, with as few fuzz as possible.
   - The implementation MUST be tested thoroughly
   - All implementation tests MUST assert something of value. Tests that are not doing that should be flagged.
   - Newly introduced behavior MUST be covered by a test.
   - Dead code SHOULD be removed.
   - In-Code documentation SHOULD be minimal, but MUST be sufficient.

5. Write a comprehensive review into FEATURE_DIR/code-review.md. Focus on items to improve and do not include praise for the developer. Do flag issues, that were pre-existing with "[pre-existing]".
There might be FEATURE_DIR/code-review.md` file already existing. In that case, do not override, but use `code-review-2.md` as a name, and
increase the suffix until there is no existing file. There can be numerous reviews and this should be the last one.
6. When done, suggest to the user to run `speckit-implementreview`
