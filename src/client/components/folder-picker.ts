export interface FolderPicker {
	element: HTMLElement;
	getValue: () => string;
	setValue: (value: string) => void;
	/**
	 * Register a handler invoked on input blur with the trimmed field value.
	 * Intended for folder-existence validation in creation modals (FR-011).
	 */
	onBlurValidate: (handler: (trimmedValue: string) => void) => void;
}

export function createFolderPicker(placeholder = "~/git"): FolderPicker {
	const container = document.createElement("div");
	container.className = "folder-picker";

	const input = document.createElement("input");
	input.type = "text";
	input.placeholder = placeholder;
	container.appendChild(input);

	const dropdown = document.createElement("ul");
	dropdown.className = "folder-picker-dropdown hidden";
	container.appendChild(dropdown);

	let suggestions: string[] = [];
	let selectedIndex = -1;

	function showDropdown() {
		if (suggestions.length === 0) {
			dropdown.classList.add("hidden");
			return;
		}
		dropdown.innerHTML = "";
		for (let i = 0; i < suggestions.length; i++) {
			const li = document.createElement("li");
			li.textContent = suggestions[i];
			if (i === selectedIndex) li.classList.add("active");
			li.addEventListener("mousedown", (e) => {
				e.preventDefault();
				input.value = suggestions[i];
				input.dispatchEvent(new Event("input", { bubbles: true }));
				hideDropdown();
			});
			dropdown.appendChild(li);
		}
		dropdown.classList.remove("hidden");
	}

	function hideDropdown() {
		dropdown.classList.add("hidden");
		selectedIndex = -1;
	}

	async function fetchSuggestions(parentDir: string) {
		if (!parentDir) {
			suggestions = [];
			hideDropdown();
			return;
		}
		try {
			const res = await fetch(`/api/suggest-folders?parent=${encodeURIComponent(parentDir)}`);
			if (!res.ok) {
				suggestions = [];
				hideDropdown();
				return;
			}
			const data = (await res.json()) as { folders: string[] };
			suggestions = data.folders ?? [];
			selectedIndex = -1;
			showDropdown();
		} catch (err) {
			console.warn("[folder-picker] Failed to fetch suggestions:", err);
			suggestions = [];
			hideDropdown();
		}
	}

	// Extract parent directory from a path
	function getParentDir(path: string): string {
		const sep = path.includes("\\") ? "\\" : "/";
		const parts = path.split(sep).filter(Boolean);
		if (parts.length <= 1) return "";
		// On Windows, preserve drive letter
		if (/^[a-zA-Z]:/.test(path)) {
			return parts.slice(0, -1).join(sep) + sep;
		}
		return sep + parts.slice(0, -1).join(sep) + sep;
	}

	// Load suggestions when the field gets initial value or focus
	function loadSuggestionsFromValue() {
		const val = input.value.trim();
		if (val) {
			const parent = getParentDir(val);
			if (parent) fetchSuggestions(parent);
		}
	}

	input.addEventListener("focus", () => {
		if (suggestions.length > 0) {
			showDropdown();
		} else {
			loadSuggestionsFromValue();
		}
	});

	let blurValidator: ((trimmedValue: string) => void) | null = null;
	input.addEventListener("blur", () => {
		hideDropdown();
		if (blurValidator) blurValidator(input.value.trim());
	});

	input.addEventListener("keydown", (e) => {
		if (dropdown.classList.contains("hidden")) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			selectedIndex = Math.min(selectedIndex + 1, suggestions.length - 1);
			showDropdown();
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			selectedIndex = Math.max(selectedIndex - 1, 0);
			showDropdown();
		} else if (e.key === "Enter" && selectedIndex >= 0) {
			e.preventDefault();
			input.value = suggestions[selectedIndex];
			input.dispatchEvent(new Event("input", { bubbles: true }));
			hideDropdown();
		} else if (e.key === "Escape") {
			hideDropdown();
		}
	});

	return {
		element: container,
		getValue: () => input.value.trim(),
		setValue: (value: string) => {
			input.value = value;
			// Pre-fetch suggestions based on initial value
			const parent = getParentDir(value);
			if (parent) fetchSuggestions(parent);
		},
		onBlurValidate: (handler) => {
			blurValidator = handler;
		},
	};
}
