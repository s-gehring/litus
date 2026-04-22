// Boot helper that injects Google Fonts <link> tags for the LITUS typography
// stack (Inter / Instrument Serif / JetBrains Mono). No-op if the link is
// already present (covers SSR-rendered HTML and HMR).
const FONTS_HREF =
	"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500&display=swap";

const PRECONNECT_HOSTS: Array<{ href: string; crossorigin: boolean }> = [
	{ href: "https://fonts.googleapis.com", crossorigin: false },
	{ href: "https://fonts.gstatic.com", crossorigin: true },
];

export function ensureLitusFonts(doc: Document = document): void {
	for (const { href, crossorigin } of PRECONNECT_HOSTS) {
		if (!doc.querySelector(`link[rel="preconnect"][href="${href}"]`)) {
			const link = doc.createElement("link");
			link.rel = "preconnect";
			link.href = href;
			if (crossorigin) link.crossOrigin = "";
			doc.head.appendChild(link);
		}
	}
	if (!doc.querySelector(`link[rel="stylesheet"][href="${FONTS_HREF}"]`)) {
		const link = doc.createElement("link");
		link.rel = "stylesheet";
		link.href = FONTS_HREF;
		doc.head.appendChild(link);
	}
}
