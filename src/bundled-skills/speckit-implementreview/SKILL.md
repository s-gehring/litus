---
name: speckit-implementreview
description: Implement the latest review remarks.
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
   - **REQUIRED**: Read code-review.md for the actual code review. There might be multiple files starting with `code-review` and having different number as suffix. For this command, use the latest review (the file with the HIGHEST number). Treat the original `code-review.md` file as review number 1.
   - **REQUIRED**: Read tasks.md for the complete task list and execution plan
   - **REQUIRED**: Read plan.md for tech stack, architecture, and file structure
   - **IF EXISTS**: Read data-model.md for entities and relationships
   - **IF EXISTS**: Read contracts/ for API specifications and test requirements
   - **IF EXISTS**: Read research.md for technical decisions and constraints
   - **IF EXISTS**: Read quickstart.md for integration scenarios

4. Improve on the written suggestions and review remarks of the code review. If something is clearly out-of-scope, or the
ROI is too low, leave it be and annotate it instead. However, if you agree that something should be implemented/fixed at some point,
it is technically speaking OOS for this branch, but would only be very minor effort/changes, fix it directly and do not defer it
to a different task/ticket/branch. Especially remarks about code coverage and test quality should be taken
at heart, as well as any unexpected behavior and issues with correctness.

5. Verify all your changes by running all tests and building the project.

6. Write a review response and append it to the `code-review.md` file. It should cover an expressive explanation of each item
and how it was fixed OR why it is out of scope and not relevant for the current branch.

7. Commit all the changes you have done related to the review.
