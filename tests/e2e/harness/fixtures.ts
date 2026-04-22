import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base } from "@playwright/test";
import { createSandbox, type Sandbox } from "./sandbox";
import { type ServerHandle, spawnServer } from "./server";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface Fixtures {
	scenarioName: string;
	autoMode: "manual" | "normal" | "full-auto";
	configOverrides: Record<string, unknown> | null;
	sandbox: Sandbox;
	scenario: { path: string; name: string };
	server: ServerHandle;
}

export const test = base.extend<Fixtures>({
	scenarioName: ["happy-path", { option: true }],
	autoMode: ["manual", { option: true }],
	configOverrides: [null, { option: true }],

	// Block third-party network requests (Google Fonts) in e2e tests. The app
	// loads Inter / Instrument Serif / JetBrains Mono from fonts.googleapis.com
	// via a render-blocking <link rel="stylesheet">; in CI sandboxes those
	// hosts can be slow/unreachable, which makes `page.goto` hang on the
	// `load` event until the test-level 120s timeout fires. Fonts are pure
	// presentation — aborting them has no effect on the DOM contracts the
	// tests assert against.
	page: async ({ page }, use) => {
		await page.route(/^https?:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
		await use(page);
	},

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

	scenario: async ({ scenarioName }, use) => {
		const path = resolve(REPO_ROOT, "tests/e2e/scenarios", `${scenarioName}.json`);
		await access(path); // fail fast if missing
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
});

export const expect = test.expect;
