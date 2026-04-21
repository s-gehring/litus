import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";
import { type PurgeSeedOptions, seedPurgeState } from "./purge-seed";
import { createSandbox, type Sandbox } from "./sandbox";
import { type ServerHandle, spawnServer } from "./server";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface Fixtures {
	scenarioName: string;
	autoMode: "manual" | "normal" | "full-auto";
	configOverrides: Record<string, unknown> | null;
	/**
	 * Pre-purge seed state written to `$HOME/.litus/workflows/` BEFORE the
	 * server spawns. Used by the `purge-all` spec. Null for all other tests.
	 */
	purgeSeed: PurgeSeedOptions | null;
	/**
	 * Additional top-level keys to merge into the scenario JSON for this
	 * test before the server spawns. Used by the `purge-all` failure
	 * sub-case to layer a `purgeError` field onto the base scenario
	 * without duplicating the whole JSON. The merge writes into a per-test
	 * scratch copy of the scenario so the original file on disk is never
	 * mutated.
	 */
	scenarioOverride: Record<string, unknown> | null;
	sandbox: Sandbox;
	scenario: { path: string; name: string };
	server: ServerHandle;
}

export const test = base.extend<Fixtures>({
	scenarioName: ["happy-path", { option: true }],
	autoMode: ["manual", { option: true }],
	configOverrides: [null, { option: true }],
	purgeSeed: [null, { option: true }],
	scenarioOverride: [null, { option: true }],

	sandbox: async ({ autoMode, configOverrides }, use) => {
		const sandbox = await createSandbox({
			autoMode,
			configOverrides: configOverrides ?? undefined,
		});
		try {
			await use(sandbox);
		} finally {
			await sandbox.cleanup();
		}
	},

	scenario: async ({ scenarioName, scenarioOverride, sandbox }, use) => {
		const basePath = resolve(REPO_ROOT, "tests/e2e/scenarios", `${scenarioName}.json`);
		await access(basePath); // fail fast if missing
		// When the test declares a scenarioOverride, write a merged copy into
		// the sandbox's home so the original scenario file on disk stays pristine.
		// Otherwise use the repo-tracked file directly.
		if (!scenarioOverride) {
			await use({ path: basePath, name: scenarioName });
			return;
		}
		const raw = JSON.parse(await readFile(basePath, "utf8")) as Record<string, unknown>;
		const merged = { ...raw, ...scenarioOverride };
		const scratchPath = join(sandbox.homeDir, `${scenarioName}.override.json`);
		await writeFile(scratchPath, JSON.stringify(merged, null, 2), "utf8");
		await use({ path: scratchPath, name: scenarioName });
	},

	server: [
		async ({ sandbox, scenario, purgeSeed }, use, testInfo) => {
			if (purgeSeed) {
				await seedPurgeState(sandbox.homeDir, purgeSeed);
			}
			const server = await spawnServer({
				homeDir: sandbox.homeDir,
				scenarioPath: scenario.path,
				counterFile: sandbox.counterFile,
				logPath: sandbox.serverLogPath,
				repoRoot: REPO_ROOT,
				cloneTemplate: sandbox.cloneTemplate,
			});
			try {
				await use(server);
			} finally {
				await server.stop();
				if (testInfo.status !== testInfo.expectedStatus) {
					await testInfo.attach("server.log", { path: server.logPath });
				}
			}
		},
		{ auto: false },
	],
});

export const expect = test.expect;
