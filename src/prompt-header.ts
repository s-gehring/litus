/**
 * A constant block prepended to every CLI-spawned agent step prompt. Tells the
 * agent that the worktree CLAUDE.md is assembled by Litus and will be reverted
 * before any PR is pushed. Corresponds to FR-001 / Story 2.
 */
export const CLAUDE_MD_CONTRACT_HEADER = `## CLAUDE.md is Litus-managed local context

The CLAUDE.md at the root of this worktree is assembled by Litus (your base guidance + the project's own CLAUDE.md appended). It is LOCAL-ONLY. Any modifications you make to CLAUDE.md will be automatically reverted before the pull request is created, and will never reach the remote. Do not bother editing CLAUDE.md, and do not include it in any commit you author — Litus will restore it in a standalone \`chore:\` commit before pushing.`;
