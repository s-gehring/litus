export interface FolderPicker {
	element: HTMLElement;
	getValue: () => string;
	setValue: (value: string) => void;
}

export function createFolderPicker(placeholder = "~/git"): FolderPicker {
	const container = document.createElement("div");
	container.className = "folder-picker";

	const input = document.createElement("input");
	input.type = "text";
	input.placeholder = placeholder;
	container.appendChild(input);

	const browseBtn = document.createElement("button");
	browseBtn.type = "button";
	browseBtn.className = "folder-picker-btn";
	browseBtn.textContent = "Browse";
	container.appendChild(browseBtn);

	// Feature detect: try the endpoint, hide button on failure
	let endpointAvailable = true;
	browseBtn.addEventListener("click", async () => {
		if (!endpointAvailable) return;
		browseBtn.disabled = true;
		browseBtn.textContent = "...";
		try {
			const res = await fetch("/api/browse-folder");
			if (!res.ok) {
				endpointAvailable = false;
				browseBtn.classList.add("hidden");
				return;
			}
			const data = (await res.json()) as { path: string | null; error?: string };
			if (data.path) {
				input.value = data.path;
				input.dispatchEvent(new Event("input", { bubbles: true }));
			}
		} catch {
			endpointAvailable = false;
			browseBtn.classList.add("hidden");
		} finally {
			browseBtn.disabled = false;
			browseBtn.textContent = "Browse";
		}
	});

	return {
		element: container,
		getValue: () => input.value.trim(),
		setValue: (value: string) => {
			input.value = value;
		},
	};
}
