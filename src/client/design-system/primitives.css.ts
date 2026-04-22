import { LITUS, type LitusTokens, TOKEN_CSS_VAR } from "./tokens";

function rootCustomProperties(tokens: LitusTokens): string {
	const lines: string[] = [];
	for (const key of Object.keys(TOKEN_CSS_VAR) as Array<keyof LitusTokens>) {
		lines.push(`  ${TOKEN_CSS_VAR[key]}: ${tokens[key]};`);
	}
	return `.litus {\n${lines.join("\n")}\n}`;
}

export function buildLitusPrimitivesCss(tokens: LitusTokens = LITUS): string {
	return `${rootCustomProperties(tokens)}

.litus {
  font-family: 'Inter', -apple-system, sans-serif;
  color: var(--litus-text);
  font-feature-settings: 'ss01','cv11';
}
.litus .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
.litus .serif { font-family: 'Instrument Serif', Georgia, serif; font-weight: 400; letter-spacing: -0.01em; }
.litus *::selection { background: rgba(255,255,255,.16); }

.litus .chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 8px; border-radius: 999px;
  font-size: 10.5px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
}
.litus .dot { width: 6px; height: 6px; border-radius: 3px; display: inline-block; }
.litus .pulse-dot {
  width: 7px; height: 7px; border-radius: 4px;
  box-shadow: 0 0 0 0 currentColor;
  animation: litusPulse 1.8s ease-out infinite;
}
@keyframes litusPulse {
  0% { box-shadow: 0 0 0 0 currentColor; opacity: 1; }
  70% { box-shadow: 0 0 0 8px transparent; opacity: .6; }
  100% { box-shadow: 0 0 0 0 transparent; opacity: 1; }
}
.litus .glass {
  background: linear-gradient(180deg, rgba(30,38,54,.55) 0%, rgba(14,19,28,.55) 100%);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid var(--litus-border);
}
@supports not (backdrop-filter: blur(14px)) {
  .litus .glass { background: rgba(16, 22, 32, 0.92); }
}
.litus .hairline {
  background: linear-gradient(90deg, transparent, var(--litus-border-strong) 20%, var(--litus-border-strong) 80%, transparent);
  height: 1px;
}
.litus .btn {
  font-family: inherit; font-size: 12.5px; color: var(--litus-text);
  padding: 7px 12px; border-radius: 8px;
  background: rgba(255,255,255,.04);
  border: 1px solid var(--litus-border);
  cursor: pointer; letter-spacing: 0.01em;
  transition: background .12s, border-color .12s;
  display: inline-flex; align-items: center; gap: 6px;
}
.litus .btn:hover { background: rgba(255,255,255,.07); border-color: var(--litus-border-strong); }
.litus .btn-ghost { background: transparent; border-color: transparent; }
.litus .btn-ghost:hover { background: rgba(255,255,255,.05); border-color: var(--litus-border); }
.litus .kbd {
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 10px; padding: 1px 5px; border-radius: 3px;
  background: rgba(255,255,255,.06); color: var(--litus-text-dim);
  border: 1px solid var(--litus-border);
}
.litus .scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.litus .scroll::-webkit-scrollbar-thumb { background: rgba(148,163,184,.15); border-radius: 4px; }
.litus .scroll::-webkit-scrollbar-track { background: transparent; }
@keyframes litusBlink { 0%,49%{opacity:1} 50%,100%{opacity:0} }
.litus .caret {
  display: inline-block; width: 7px; height: 14px;
  background: var(--litus-amber); vertical-align: -2px;
  animation: litusBlink 1s steps(1) infinite; margin-left: 2px;
}
@keyframes litusShimmer { 0%{background-position:0% 50%} 100%{background-position:200% 50%} }
.litus .shimmer-text {
  background: linear-gradient(90deg, var(--litus-text-dim) 30%, var(--litus-text) 50%, var(--litus-text-dim) 70%);
  background-size: 200% 100%;
  -webkit-background-clip: text; background-clip: text; color: transparent;
  animation: litusShimmer 2.5s linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  .litus .pulse-dot,
  .litus .caret,
  .litus .shimmer-text,
  .litus [data-litus-animate] {
    animation: none !important;
  }
}
`;
}
