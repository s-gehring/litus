import { delimiter, resolve } from "node:path";

export function fakesDir(): string {
	return resolve(import.meta.dir, "..", "fakes");
}

export function buildPathWithFakes(existingPath: string | undefined): string {
	const fakes = fakesDir();
	const parts = (existingPath ?? "").split(delimiter).filter(Boolean);
	const deduped = parts.filter((p) => resolve(p) !== fakes);
	return [fakes, ...deduped].join(delimiter);
}
