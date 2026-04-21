import { looksLikeGitUrl } from "../git-url";
import type { FolderPicker } from "./components/folder-picker";

export type FolderExistsResponse =
	| { exists: true; usable: true }
	| {
			exists: true;
			usable: false;
			reason: "not_a_directory" | "permission_denied" | "not_a_git_repo";
	  }
	| { exists: false; usable: false; reason: "not_found" };

export function folderErrorMessageFor(res: FolderExistsResponse): string | null {
	if (res.exists && res.usable) return null;
	if (!res.exists) return "Folder does not exist.";
	if (res.reason === "not_a_directory") return "Path is not a folder.";
	if (res.reason === "not_a_git_repo") return "Folder is not a git repository.";
	if (res.reason === "permission_denied") {
		return "Folder is not accessible (permission denied).";
	}
	return "Folder is not accessible.";
}

// Timeout for a single /api/folder-exists probe. Without it, a hung fetch
// would pin the blur-time inFlight counter open forever and submitCheck
// would silently wait out the user.
export const PROBE_TIMEOUT_MS = 5000;

/**
 * Probe `/api/folder-exists` for `trimmedPath`. URLs are skipped (empty string
 * → null so the caller treats them as "no local folder to validate"; a GitHub
 * URL is validated server-side during the subsequent start flow). Returns the
 * error message to display inline, or null when the folder is usable.
 * Fail-closed on network / 5xx / timeout so an unreachable probe blocks submit
 * (contracts/http-folder-exists.md).
 */
export async function probeFolder(trimmedPath: string): Promise<string | null> {
	if (!trimmedPath) return null;
	if (looksLikeGitUrl(trimmedPath)) return null;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		const res = await fetch(`/api/folder-exists?path=${encodeURIComponent(trimmedPath)}`, {
			signal: controller.signal,
		});
		if (res.status === 400) return "Folder path is required.";
		if (!res.ok) return "Could not validate folder — please try again.";
		const body = (await res.json()) as FolderExistsResponse;
		return folderErrorMessageFor(body);
	} catch {
		return "Could not validate folder — please try again.";
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Wire blur-time folder-existence validation to a picker. Creates a dedicated
 * field-scoped error element adjacent to the picker (FR-012: "inline validation
 * error on the folder field") and appends it to `field`, so the message does
 * not collide with top-level modal errors. Exposes a `submitCheck` that awaits
 * any pending blur probe, re-probes, and reports the result to the user —
 * never silently aborting the submit.
 */
export function attachFolderValidation(
	picker: FolderPicker,
	field: HTMLElement,
): {
	submitCheck: () => Promise<boolean>;
} {
	// Track the most recent blur-time probe so submitCheck can await it
	// rather than bailing silently when the user clicks Start before the
	// blur probe has settled.
	let pendingProbe: Promise<void> | null = null;
	const fieldErrorEl = document.createElement("div");
	fieldErrorEl.className = "modal-field-error hidden";
	field.appendChild(fieldErrorEl);

	const successEl = document.createElement("div");
	successEl.className = "modal-field-success hidden";
	successEl.setAttribute("aria-label", "Valid target repository");
	successEl.textContent = "✓ Valid git repository";
	field.appendChild(successEl);

	function setError(msg: string | null, validated: boolean) {
		if (msg) {
			fieldErrorEl.textContent = msg;
			fieldErrorEl.classList.remove("hidden");
			successEl.classList.add("hidden");
		} else {
			fieldErrorEl.textContent = "";
			fieldErrorEl.classList.add("hidden");
			if (validated) {
				successEl.classList.remove("hidden");
			} else {
				successEl.classList.add("hidden");
			}
		}
	}

	picker.onBlurValidate((value) => {
		const probe = probeFolder(value)
			.then((err) => {
				// GitHub-URL inputs return `null` from probeFolder without
				// hitting the server (they're validated later during clone);
				// suppress the green check in that case so the affordance
				// reads as "validated the folder" rather than "looks URL-ish".
				const validated = err === null && value !== "" && !looksLikeGitUrl(value);
				setError(err, validated);
			})
			.finally(() => {
				if (pendingProbe === probe) pendingProbe = null;
			});
		pendingProbe = probe;
	});

	return {
		async submitCheck() {
			// If a blur probe is still in flight, wait for it rather than
			// returning false silently — probeFolder has its own timeout,
			// so this cannot hang indefinitely.
			if (pendingProbe) {
				await pendingProbe;
			}
			const value = picker.getValue();
			const err = await probeFolder(value);
			const validated = err === null && value !== "" && !looksLikeGitUrl(value);
			setError(err, validated);
			return err === null;
		},
	};
}
