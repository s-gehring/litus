import createDOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ async: false, breaks: true });

const purify = createDOMPurify(window);

export function renderMarkdown(input: string): string {
	if (!input) return "";
	return purify.sanitize(marked.parse(input) as string);
}
