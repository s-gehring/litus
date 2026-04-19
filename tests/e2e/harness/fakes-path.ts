import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function fakesDir(): string {
	return resolve(HERE, "..", "fakes");
}

export function buildPathWithFakes(existingPath: string | undefined): string {
	const fakes = fakesDir();
	const parts = (existingPath ?? "").split(delimiter).filter(Boolean);
	const deduped = parts.filter((p) => resolve(p) !== fakes);
	return [fakes, ...deduped].join(delimiter);
}
