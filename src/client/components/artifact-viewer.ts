import type { ArtifactDescriptor } from "../../types";
import { renderMarkdown } from "../render-markdown";

interface OpenArtifactOptions {
	workflowId: string;
	descriptor: ArtifactDescriptor;
	triggerEl: HTMLElement | null;
}

// Preview dispatch: pick a renderer based on the descriptor's content type
// (manifest hint for artifacts step) or filename extension. Unsupported kinds
// fall back to a download-only notice.
type PreviewKind = "markdown" | "image" | "text" | "json" | "unsupported";

function inferPreviewKind(descriptor: ArtifactDescriptor): PreviewKind {
	const ct = descriptor.contentType?.toLowerCase() ?? "";
	if (ct.startsWith("image/")) return "image";
	if (ct === "text/markdown" || ct === "application/markdown") return "markdown";
	if (ct === "application/json" || ct.endsWith("+json")) return "json";
	if (ct.startsWith("text/")) return "text";

	const rel = descriptor.relPath.toLowerCase();
	const dot = rel.lastIndexOf(".");
	const ext = dot >= 0 ? rel.slice(dot) : "";
	if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".bmp", ".ico"].includes(ext)) {
		return "image";
	}
	if (ext === ".md") return "markdown";
	if (ext === ".json") return "json";
	if ([".txt", ".log", ".csv", ".yaml", ".yml", ".xml", ".html", ".htm"].includes(ext)) {
		return "text";
	}
	return "unsupported";
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

	function getTabbable(): HTMLElement[] {
		const sel =
			'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
		return Array.from(dialog.querySelectorAll<HTMLElement>(sel)).filter(
			(el) => !el.hasAttribute("disabled") && el.tabIndex !== -1,
		);
	}

	function onKeydown(e: KeyboardEvent): void {
		if (e.key === "Escape") {
			e.preventDefault();
			close();
			return;
		}
		if (e.key !== "Tab") return;
		const focusable = getTabbable();
		if (focusable.length === 0) {
			e.preventDefault();
			dialog.focus();
			return;
		}
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		const active = document.activeElement as HTMLElement | null;
		if (e.shiftKey) {
			if (active === first || !dialog.contains(active)) {
				e.preventDefault();
				last.focus();
			}
		} else {
			if (active === last || !dialog.contains(active)) {
				e.preventDefault();
				first.focus();
			}
		}
	}

	document.addEventListener("keydown", onKeydown);
	closeBtn.addEventListener("click", close);
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) close();
	});

	dialog.focus();

	const previewKind = inferPreviewKind(descriptor);
	const contentUrl = `/api/workflows/${encodeURIComponent(workflowId)}/artifacts/${encodeURIComponent(descriptor.id)}/content`;

	if (previewKind === "image") {
		body.textContent = "";
		const img = document.createElement("img");
		img.className = "artifact-modal-image";
		img.alt = descriptor.displayLabel;
		img.src = contentUrl;
		img.onerror = () => {
			body.textContent = "";
			const empty = document.createElement("div");
			empty.className = "artifact-modal-unavailable";
			empty.textContent = "Artifact unavailable.";
			body.appendChild(empty);
		};
		body.appendChild(img);
		return;
	}

	if (previewKind === "unsupported") {
		body.textContent = "";
		const notice = document.createElement("div");
		notice.className = "artifact-modal-unavailable";
		notice.textContent =
			"Inline preview is not available for this file type. Use the Download button above to save the file.";
		body.appendChild(notice);
		return;
	}

	void fetch(contentUrl, { cache: "no-store" })
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

			if (previewKind === "markdown") {
				body.innerHTML = renderMarkdown(text);
				return;
			}

			// text / json renderers share a <pre> fallback — readable, no script
			// injection surface. JSON is pretty-printed when possible, otherwise
			// shown verbatim.
			let rendered = text;
			if (previewKind === "json") {
				try {
					rendered = JSON.stringify(JSON.parse(text), null, 2);
				} catch {
					// Fall back to the raw bytes if JSON parsing fails.
				}
			}
			body.textContent = "";
			const pre = document.createElement("pre");
			pre.className = "artifact-modal-text";
			pre.textContent = rendered;
			body.appendChild(pre);
		})
		.catch((err) => {
			body.textContent = `Failed to load artifact: ${err instanceof Error ? err.message : String(err)}`;
		});
}
