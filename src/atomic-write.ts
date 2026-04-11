import { mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "./logger";

/**
 * Write data to a file atomically via tmp-rename.
 * Creates parent directories if they don't exist.
 * On Windows, rename can fail with EPERM when another handle holds the
 * target file open (antivirus, concurrent read, etc.) — retries briefly.
 */
export async function atomicWrite(filePath: string, data: string): Promise<void> {
	mkdirSync(dirname(filePath), { recursive: true });
	const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const tmpPath = `${filePath}.${suffix}.tmp`;
	await Bun.write(tmpPath, data);

	try {
		for (let attempt = 0; ; attempt++) {
			try {
				renameSync(tmpPath, filePath);
				return;
			} catch (err) {
				if (attempt >= 3) {
					logger.warn(
						`[atomic-write] Rename failed after retries, falling back to direct write: ${filePath}`,
					);
					await Bun.write(filePath, data);
					return;
				}
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "EPERM" || code === "EACCES") {
					logger.warn(
						`[atomic-write] ${code} on rename (attempt ${attempt}), retrying: ${filePath}`,
					);
					await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
					continue;
				}
				throw err;
			}
		}
	} finally {
		try {
			unlinkSync(tmpPath);
		} catch {
			/* tmp already renamed or gone */
		}
	}
}
