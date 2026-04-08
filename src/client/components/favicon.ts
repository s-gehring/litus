let currentState: boolean | null = null;
let logoImg: HTMLImageElement | null = null;

export function resetFaviconState(): void {
	currentState = null;
	logoImg = null;
}

function ensureLogoLoaded(): Promise<HTMLImageElement> {
	if (logoImg) return Promise.resolve(logoImg);
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => {
			logoImg = img;
			resolve(img);
		};
		img.onerror = reject;
		img.src = "/logo.svg";
	});
}

export function updateFavicon(needsAttention: boolean): void {
	if (needsAttention === currentState) return;
	currentState = needsAttention;

	ensureLogoLoaded().then((img) => {
		const size = 64;
		const canvas = document.createElement("canvas");
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		ctx.drawImage(img, 0, 0, size, size);

		if (needsAttention) {
			const dotR = 14;
			const cx = size - dotR - 1;
			const cy = size - dotR - 1;
			ctx.beginPath();
			ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
			ctx.fillStyle = "#e94560";
			ctx.fill();
		}

		const link =
			document.querySelector<HTMLLinkElement>("link[rel='icon']") ??
			(() => {
				const el = document.createElement("link");
				el.rel = "icon";
				document.head.appendChild(el);
				return el;
			})();
		link.type = "image/png";
		link.href = canvas.toDataURL("image/png");
	});
}
