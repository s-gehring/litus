import { renameSync, unlinkSync } from "node:fs";

/**
 * Write data to a file atomically via tmp-rename.
 * On Windows, rename can fail with EPERM when another handle holds the
 * target file open (antivirus, concurrent read, etc.) — retries briefly.
 */
export async function atomicWrite(filePath: string, data: string): Promise<void> {
	const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const tmpPath = `${filePath}.${suffix}.tmp`;
	await Bun.write(tmpPath, data);

	for (let attempt = 0; ; attempt++) {
		try {
			renameSync(tmpPath, filePath);
			return;
		} catch (err) {
			if (attempt >= 3) {
				// Final fallback: direct overwrite (non-atomic but won't EPERM)
				try {
					unlinkSync(tmpPath);
				} catch {
					/* tmp cleanup */
				}
				await Bun.write(filePath, data);
				return;
			}
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "EPERM" || code === "EACCES") {
				await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
				continue;
			}
			throw err;
		}
	}
}
