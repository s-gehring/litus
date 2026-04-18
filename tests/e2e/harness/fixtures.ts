import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test as base } from "@playwright/test";
import { createSandbox, type Sandbox } from "./sandbox";
import { type ServerProcess, spawnServer } from "./server";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

export interface Fixtures {
	scenarioName: string;
	autoMode: "manual" | "normal" | "full-auto";
	sandbox: Sandbox;
	scenario: { path: string; name: string };
	server: ServerProcess;
}

export const test = base.extend<Fixtures>({
	scenarioName: ["happy-path", { option: true }],
	autoMode: ["manual", { option: true }],

	sandbox: async ({ autoMode }, use) => {
		const sandbox = await createSandbox({ autoMode });
		try {
			await use(sandbox);
		} finally {
			await sandbox.cleanup();
		}
	},

	scenario: async ({ scenarioName }, use) => {
		const path = resolve(REPO_ROOT, "tests/e2e/scenarios", `${scenarioName}.json`);
		await readFile(path, "utf8"); // fail fast if missing
		await use({ path, name: scenarioName });
	},

	server: [
		async ({ sandbox, scenario }, use, testInfo) => {
			const server = await spawnServer({
				homeDir: sandbox.homeDir,
				scenarioPath: scenario.path,
				counterFile: sandbox.counterFile,
				logPath: sandbox.serverLogPath,
				repoRoot: REPO_ROOT,
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

	baseURL: async ({ server }, use) => {
		await use(server.baseUrl);
	},
});

export const expect = test.expect;
