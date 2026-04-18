/**
 * Decide whether a freshly `workflow:created` broadcast should pull focus into
 * the new workflow's detail view. Pulled out of app.ts as a pure helper so the
 * rule is testable in isolation.
 *
 * Navigate into the new workflow only when all of the following hold:
 *  - the workflow is standalone (no `epicId`), so it would not appear inside
 *    an existing epic view the user may be looking at;
 *  - the user is not on `/config` (creating a workflow from the config page
 *    should not yank them out of their settings);
 *  - the user is not on an `/epic/:id` view (peer-created workflows must not
 *    steal focus from an epic the user is actively viewing).
 *
 * Returns the target path when focus should move, or `null` to stay put.
 */
export function workflowCreatedTarget(
	workflow: { id: string; epicId?: string | null },
	currentPath: string | null,
): string | null {
	if (workflow.epicId) return null;
	if (currentPath === "/config") return null;
	if (currentPath?.startsWith("/epic/")) return null;
	return `/workflow/${workflow.id}`;
}
