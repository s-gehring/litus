import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runClaude } from "./claude-spawn";
import { defaultModelCacheFile } from "./litus-paths";
import { logger } from "./logger";

export interface DefaultModelInfo {
	modelId: string;
	displayName: string;
}

const DETECTION_PROMPT = `Respond with ONLY a single JSON object (no markdown, no explanation) containing exactly these two string fields:
- "modelId": your exact model ID (e.g. "claude-opus-4-7")
- "displayName": your short natural-language name (e.g. "Opus 4.7")`;

let cached: DefaultModelInfo | null = null;
const listeners = new Set<(info: DefaultModelInfo) => void>();

function loadFromDisk(): DefaultModelInfo | null {
	try {
		const cachePath = defaultModelCacheFile();
		if (!existsSync(cachePath)) return null;
		const parsed = JSON.parse(readFileSync(cachePath, "utf-8"));
		if (
			parsed &&
			typeof parsed.modelId === "string" &&
			typeof parsed.displayName === "string" &&
			parsed.modelId.trim() &&
			parsed.displayName.trim()
		) {
			return { modelId: parsed.modelId, displayName: parsed.displayName };
		}
	} catch (err) {
		logger.warn("[default-model] Failed to load cached default model:", err);
	}
	return null;
}

function saveToDisk(info: DefaultModelInfo): void {
	try {
		const cachePath = defaultModelCacheFile();
		mkdirSync(dirname(cachePath), { recursive: true });
		writeFileSync(cachePath, JSON.stringify(info, null, 2));
	} catch (err) {
		logger.warn("[default-model] Failed to cache default model:", err);
	}
}

function parseResponse(stdout: string): DefaultModelInfo | null {
	const cleaned = stdout
		.trim()
		.replace(/^```(?:json)?\s*\n?/i, "")
		.replace(/\n?```\s*$/, "");
	const match = cleaned.match(/\{[\s\S]*\}/);
	if (!match) return null;
	try {
		const parsed = JSON.parse(match[0]);
		const modelId = typeof parsed.modelId === "string" ? parsed.modelId.trim() : "";
		const displayName = typeof parsed.displayName === "string" ? parsed.displayName.trim() : "";
		if (!modelId || !displayName) return null;
		return { modelId, displayName };
	} catch {
		return null;
	}
}

export function getDefaultModelInfo(): DefaultModelInfo | null {
	return cached;
}

export function onDefaultModelInfoChange(listener: (info: DefaultModelInfo) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function setInfo(info: DefaultModelInfo): void {
	cached = info;
	for (const l of listeners) {
		try {
			l(info);
		} catch (err) {
			logger.warn("[default-model] listener threw:", err);
		}
	}
}

export async function detectDefaultModel(): Promise<DefaultModelInfo | null> {
	const { ok, stdout, stderr } = await runClaude({
		prompt: DETECTION_PROMPT,
		callerLabel: "default-model",
		timeoutMs: 30_000,
	});
	if (!ok) {
		logger.warn(`[default-model] Detection failed: ${stderr.slice(0, 200)}`);
		return null;
	}
	const parsed = parseResponse(stdout);
	if (!parsed) {
		logger.warn(`[default-model] Could not parse response: ${stdout.slice(0, 200)}`);
		return null;
	}
	return parsed;
}

export function initializeDefaultModelInfo(): void {
	const fromDisk = loadFromDisk();
	if (fromDisk) {
		cached = fromDisk;
		logger.info(`[default-model] Loaded cached: ${fromDisk.displayName} (${fromDisk.modelId})`);
	}

	detectDefaultModel()
		.then((info) => {
			if (!info) return;
			if (cached && cached.modelId === info.modelId && cached.displayName === info.displayName) {
				return;
			}
			logger.info(`[default-model] Detected: ${info.displayName} (${info.modelId})`);
			saveToDisk(info);
			setInfo(info);
		})
		.catch((err) => {
			logger.warn("[default-model] Detection threw:", err);
		});
}

// Test helper — reset in-memory state without touching disk.
export function __resetDefaultModelInfoForTests(): void {
	cached = null;
	listeners.clear();
}
