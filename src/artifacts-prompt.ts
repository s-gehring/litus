// Prompt builder for the `artifacts` pipeline step. The LLM is given an
// output directory, the manifest contract (inline), and is encouraged to run
// any helpers (test runner, Playwright, build tools) it finds useful. Only
// files named in the manifest survive the step.

export function buildArtifactsPrompt(outputDir: string): string {
	return `You are the "Generating Artifacts" step of a specification workflow. The feature has been implemented and its code review loop has completed. Your job is to produce any helpful take-away artifacts from the finished implementation — for example: test-run reports, coverage reports, screenshots or videos from end-to-end tools, bundled build outputs, release notes, diagrams, performance traces, or any other evidence a reviewer would want to look at alongside the PR.

## Output directory

Write every file you want to keep under this absolute path:

    ${outputDir}

You may create subdirectories inside it. Do NOT write outside it. Files written elsewhere are ignored by the pipeline.

## Manifest contract — strongly recommended

Before you exit, write a single file at:

    ${outputDir}/manifest.json

with this exact shape:

    {
      "version": 1,
      "artifacts": [
        { "path": "<relative/path/inside/output-dir>", "description": "<short 1–500 char description>", "contentType": "<optional MIME type>" }
      ]
    }

The \`description\` is shown next to the file in the UI — make it informative and short. Listing each artifact in the manifest lets you control the per-file description and the optional MIME hint, so always prefer to write one.

If you do NOT write a manifest, every regular file you leave in the output directory is auto-collected as an artifact with a generic description. This is a fallback; the manifest path is the right one to take.

If there is genuinely nothing worth keeping, emit:

    { "version": 1, "artifacts": [] }

…and do not write any other files inside the output directory. This is a valid outcome; do not invent artifacts.

## Helpers you may invoke

You have the same tool surface as other steps (bash, file edit, etc). You are encouraged to:
- run the project's test runner and capture its output to a file
- run Playwright or any E2E tool the repo defines
- run linters / formatters / type checks
- generate coverage reports or profile traces
- produce human-readable summary reports from tool output

Favour quality over quantity. A single well-labelled report is better than a pile of raw logs.

## Constraints

- Stay within the output directory for anything you want kept.
- Do NOT commit, push, or open PRs — a later step handles that.
- Do NOT modify source code: this step only observes and records.
- Keep individual files reasonably sized; files that exceed the configured per-file cap are rejected with a clear notice.

When done, print a short summary of what you generated and exit.`;
}
