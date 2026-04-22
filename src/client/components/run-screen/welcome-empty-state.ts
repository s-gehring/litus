import { LITUS } from "../../design-system/tokens";

export interface WelcomeEmptyStateController {
	element: HTMLElement;
}

export function createWelcomeEmptyState(): WelcomeEmptyStateController {
	const host = document.createElement("div");
	host.className = "glass";
	host.dataset.runScreen = "welcome";
	Object.assign(host.style, {
		margin: "22px",
		padding: "40px 48px",
		borderRadius: "16px",
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-start",
		gap: "10px",
		maxWidth: "720px",
	} satisfies Partial<CSSStyleDeclaration>);

	const eyebrow = document.createElement("span");
	eyebrow.className = "mono";
	Object.assign(eyebrow.style, {
		fontSize: "10.5px",
		letterSpacing: "0.18em",
		color: LITUS.textMute,
		textTransform: "uppercase",
	} satisfies Partial<CSSStyleDeclaration>);
	eyebrow.textContent = "LITUS";
	host.appendChild(eyebrow);

	const title = document.createElement("h1");
	title.className = "serif";
	Object.assign(title.style, {
		fontSize: "34px",
		margin: "4px 0 0",
		lineHeight: "1.1",
		letterSpacing: "-0.5px",
	} satisfies Partial<CSSStyleDeclaration>);
	title.textContent = "Pipeline-grade Claude Code.";
	host.appendChild(title);

	const lede = document.createElement("p");
	Object.assign(lede.style, {
		margin: "0",
		color: LITUS.textDim,
		fontSize: "14px",
		lineHeight: "1.55",
		maxWidth: "620px",
	} satisfies Partial<CSSStyleDeclaration>);
	lede.textContent =
		"Start a Quick Fix, a Specification, or an Epic from the top bar — your active tasks land on the rail above.";
	host.appendChild(lede);

	return { element: host };
}
