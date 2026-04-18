import type { ArtifactDescriptor } from "../../types";
import { renderMarkdown } from "../render-markdown";

interface OpenArtifactOptions {
	workflowId: string;
	descriptor: ArtifactDescriptor;
	triggerEl: HTMLElement | null;
}

/**
 * Open a modal rendering the markdown content of one artifact. Fetches the
 * current bytes from `/content` on each open (no cache). Shows an inline
 * "Artifact unavailable" message on 404.
 */
export function openArtifactViewer(opts: OpenArtifactOptions): void {
	const { workflowId, descriptor, triggerEl } = opts;
	const overlay = document.createElement("div");
	overlay.className = "artifact-modal-overlay";

	const dialog = document.createElement("div");
	dialog.className = "artifact-modal";
	dialog.setAttribute("role", "dialog");
	dialog.setAttribute("aria-modal", "true");
	dialog.setAttribute("aria-label", descriptor.displayLabel);
	dialog.tabIndex = -1;

	const header = document.createElement("div");
	header.className = "artifact-modal-header";

	const title = document.createElement("div");
	title.className = "artifact-modal-title";
	title.textContent = descriptor.displayLabel;
	header.appendChild(title);

	const downloadBtn = document.createElement("a");
	downloadBtn.className = "btn btn-secondary artifact-modal-download";
	downloadBtn.textContent = "Download";
	downloadBtn.href = `/api/workflows/${encodeURIComponent(workflowId)}/artifacts/${encodeURIComponent(descriptor.id)}/download`;
	downloadBtn.setAttribute("download", "");
	header.appendChild(downloadBtn);

	const closeBtn = document.createElement("button");
	closeBtn.className = "artifact-modal-close";
	closeBtn.setAttribute("aria-label", "Close");
	closeBtn.textContent = "×";
	header.appendChild(closeBtn);

	dialog.appendChild(header);

	const body = document.createElement("div");
	body.className = "artifact-modal-body";
	body.textContent = "Loading…";
	dialog.appendChild(body);

	overlay.appendChild(dialog);
	document.body.appendChild(overlay);

	document.body.classList.add("artifact-modal-open");

	function close(): void {
		overlay.remove();
		document.body.classList.remove("artifact-modal-open");
		document.removeEventListener("keydown", onKeydown);
		if (triggerEl && typeof triggerEl.focus === "function") {
			triggerEl.focus();
		}
	}

	function onKeydown(e: KeyboardEvent): void {
		if (e.key === "Escape") {
			e.preventDefault();
			close();
		}
	}

	document.addEventListener("keydown", onKeydown);
	closeBtn.addEventListener("click", close);
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) close();
	});

	dialog.focus();

	void fetch(
		`/api/workflows/${encodeURIComponent(workflowId)}/artifacts/${encodeURIComponent(descriptor.id)}/content`,
		{ cache: "no-store" },
	)
		.then(async (res) => {
			if (res.status === 404) {
				body.textContent = "";
				const empty = document.createElement("div");
				empty.className = "artifact-modal-unavailable";
				empty.textContent = "Artifact unavailable.";
				body.appendChild(empty);
				return;
			}
			if (!res.ok) {
				body.textContent = `Failed to load artifact (HTTP ${res.status}).`;
				return;
			}
			const text = await res.text();
			body.innerHTML = renderMarkdown(text);
		})
		.catch((err) => {
			body.textContent = `Failed to load artifact: ${err instanceof Error ? err.message : String(err)}`;
		});
}
