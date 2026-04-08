/** Extract a human-readable message from an unknown caught value. */
export function toErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
