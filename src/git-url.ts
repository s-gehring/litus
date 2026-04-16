/**
 * Parse a GitHub repository URL into `{ owner, repo }`. Returns `null` for
 * any URL that is not a recognised GitHub form.
 *
 * Accepted forms:
 *   https://github.com/<owner>/<repo>[.git][/]
 *   http://github.com/<owner>/<repo>[.git][/]
 *   git@github.com:<owner>/<repo>[.git]
 *   ssh://git@github.com/<owner>/<repo>[.git]
 */
export function parseGitHubUrl(raw: string): { owner: string; repo: string } | null {
	if (!raw) return null;
	const input = raw.trim();
	if (!input) return null;

	const patterns: RegExp[] = [
		/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
		/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i,
		/^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
	];

	for (const re of patterns) {
		const m = input.match(re);
		if (m) {
			const [, owner, repo] = m;
			if (!owner || !repo) return null;
			return { owner, repo };
		}
	}

	return null;
}

/** Canonical lookup key for a managed repo: lowercased `<owner>/<repo>`. */
export function canonicalKey(owner: string, repo: string): string {
	return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/**
 * Cheap probe: does this string look like a git URL of any kind? Used by the
 * target-repo validator to distinguish "user pasted a URL for a non-GitHub
 * host" from "user typed a local path".
 */
export function looksLikeGitUrl(raw: string): boolean {
	const s = raw.trim();
	return /^(https?:\/\/|ssh:\/\/|git@)/i.test(s);
}
