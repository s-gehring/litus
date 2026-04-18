/**
 * Decide whether a freshly `epic:created` broadcast should pull focus into the
 * new epic's detail view. Pulled out of app.ts as a pure helper so the rule is
 * testable in isolation and stays symmetric with
 * `workflowCreatedTarget` for standalone workflows.
 *
 * Navigate into the new epic only when the user is not in a context we must
 * preserve:
 *  - not on `/config` (creating an epic from the config page should not yank
 *    them out of their settings);
 *  - not on another `/epic/:id` view (peer-created epics, or epics created by
 *    the current user while they are still reading a different one, must not
 *    steal focus).
 *
 * Returns the target path when focus should move, or `null` to stay put.
 */
export function epicCreatedTarget(epicId: string, currentPath: string | null): string | null {
	if (currentPath === "/config") return null;
	if (currentPath?.startsWith("/epic/")) return null;
	return `/epic/${epicId}`;
}
