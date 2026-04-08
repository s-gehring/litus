# Security Policy

## Important Warning

Litus runs Claude Code with `--dangerously-skip-permissions`. This means the agent can read, write, and delete files,
create PRs, and merge them — all without confirmation. **Only run Litus against repositories where you are comfortable
with autonomous, unsupervised changes.**

## Reporting a Vulnerability

If you discover a security vulnerability in Litus, please report it responsibly:

1. **Do not** open a public GitHub issue.
2. Email **simon@gehring.tv** with a description of the vulnerability.
3. Include steps to reproduce if possible.

I will acknowledge receipt within 48 hours and aim to provide a fix or mitigation within 7 days for critical issues.

## Scope

Security reports are welcome for:

- Vulnerabilities in Litus itself (e.g., XSS in the web UI, command injection, path traversal)
- Issues with how Litus handles user input or spawns child processes
- Unintended data exposure through the WebSocket or HTTP server

Out of scope:

- Vulnerabilities in Claude Code, GitHub CLI, or other external tools Litus depends on — report those to their
  respective maintainers
- Issues that require the attacker to already have local access to the machine running Litus
