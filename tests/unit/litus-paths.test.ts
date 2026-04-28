import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
	alertsDir,
	artifactsDir,
	auditDir,
	clearLitusHome,
	configFile,
	defaultModelCacheFile,
	epicsFile,
	litusHome,
	reposDir,
	setLitusHome,
	workflowsDir,
} from "../../src/litus-paths";

const ORIGINAL_ENV = process.env.LITUS_HOME;

function restoreEnv(): void {
	if (ORIGINAL_ENV === undefined) delete process.env.LITUS_HOME;
	else process.env.LITUS_HOME = ORIGINAL_ENV;
}

afterEach(() => {
	clearLitusHome();
	restoreEnv();
});

describe("litusHome resolution", () => {
	test("R1: defaults to ~/.litus when nothing is set", () => {
		clearLitusHome();
		delete process.env.LITUS_HOME;
		expect(litusHome()).toBe(join(homedir(), ".litus"));
	});

	test("R2: env var absolute path is honoured", () => {
		clearLitusHome();
		process.env.LITUS_HOME = resolve("/tmp/litus-alt");
		expect(litusHome()).toBe(resolve("/tmp/litus-alt"));
	});

	test("R3: empty env var falls back to home default", () => {
		clearLitusHome();
		process.env.LITUS_HOME = "";
		expect(litusHome()).toBe(join(homedir(), ".litus"));
	});

	test("R4: whitespace-only env var falls back to home default", () => {
		clearLitusHome();
		process.env.LITUS_HOME = "   ";
		expect(litusHome()).toBe(join(homedir(), ".litus"));
	});

	test("R5: env var '~' expands to homedir", () => {
		clearLitusHome();
		process.env.LITUS_HOME = "~";
		expect(litusHome()).toBe(homedir());
	});

	test("R6: env var '~/litus-test' expands tilde", () => {
		clearLitusHome();
		process.env.LITUS_HOME = "~/litus-test";
		expect(litusHome()).toBe(join(homedir(), "litus-test"));
	});

	test("R6b: env var '~\\litus-test' expands tilde (Windows-style separator)", () => {
		clearLitusHome();
		process.env.LITUS_HOME = "~\\litus-test";
		expect(litusHome()).toBe(join(homedir(), "litus-test"));
	});

	test("R7: relative env var resolves against cwd", () => {
		clearLitusHome();
		process.env.LITUS_HOME = "rel/dir";
		const result = litusHome();
		expect(isAbsolute(result)).toBe(true);
		expect(result).toBe(join(process.cwd(), "rel", "dir"));
		expect(result.endsWith(`${sep}rel${sep}dir`)).toBe(true);
	});

	test("R7b: env var with surrounding whitespace is trimmed", () => {
		clearLitusHome();
		process.env.LITUS_HOME = `  ${resolve("/tmp/trim-me")}  `;
		expect(litusHome()).toBe(resolve("/tmp/trim-me"));
	});

	test("R8: setLitusHome wins over env-default state", () => {
		clearLitusHome();
		setLitusHome(resolve("/tmp/setter"));
		expect(litusHome()).toBe(resolve("/tmp/setter"));
	});

	test("R9: setLitusHome with relative path resolves at set-time", () => {
		clearLitusHome();
		setLitusHome("rel/abs");
		expect(litusHome()).toBe(resolve("rel/abs"));
	});

	test("R10: setter wins over env var", () => {
		clearLitusHome();
		process.env.LITUS_HOME = resolve("/tmp/env");
		setLitusHome(resolve("/tmp/setter"));
		expect(litusHome()).toBe(resolve("/tmp/setter"));
	});

	test("R11: clearLitusHome restores env-var precedence", () => {
		setLitusHome(resolve("/tmp/setter"));
		clearLitusHome();
		process.env.LITUS_HOME = resolve("/tmp/env");
		expect(litusHome()).toBe(resolve("/tmp/env"));
	});

	test("R12: latest setLitusHome wins", () => {
		setLitusHome(resolve("/a"));
		setLitusHome(resolve("/b"));
		expect(litusHome()).toBe(resolve("/b"));
	});
});

describe("named accessors", () => {
	test("A1: defaults compose under ~/.litus", () => {
		clearLitusHome();
		delete process.env.LITUS_HOME;
		const home = join(homedir(), ".litus");
		expect(workflowsDir()).toBe(join(home, "workflows"));
		expect(epicsFile()).toBe(join(home, "workflows", "epics.json"));
		expect(auditDir()).toBe(join(home, "audit"));
		expect(alertsDir()).toBe(join(home, "alerts"));
		expect(configFile()).toBe(join(home, "config.json"));
		expect(defaultModelCacheFile()).toBe(join(home, "default-model.json"));
		expect(reposDir()).toBe(join(home, "repos"));
		expect(artifactsDir("wf-1")).toBe(join(home, "artifacts", "wf-1"));
	});

	test("A2: setLitusHome reroutes every accessor", () => {
		const root = resolve("/tmp/x");
		setLitusHome(root);
		expect(workflowsDir()).toBe(join(root, "workflows"));
		expect(epicsFile()).toBe(join(root, "workflows", "epics.json"));
		expect(auditDir()).toBe(join(root, "audit"));
		expect(alertsDir()).toBe(join(root, "alerts"));
		expect(configFile()).toBe(join(root, "config.json"));
		expect(defaultModelCacheFile()).toBe(join(root, "default-model.json"));
		expect(reposDir()).toBe(join(root, "repos"));
		expect(artifactsDir("wf-1")).toBe(join(root, "artifacts", "wf-1"));
	});

	test("A3: artifactsDir keeps dashed workflow ids verbatim", () => {
		const root = resolve("/tmp/x");
		setLitusHome(root);
		expect(artifactsDir("workflow-with-dashes")).toBe(
			join(root, "artifacts", "workflow-with-dashes"),
		);
	});

	test("A4: artifactsDir does not validate path-like ids", () => {
		const root = resolve("/tmp/x");
		setLitusHome(root);
		expect(artifactsDir("a/b")).toBe(join(root, "artifacts", "a", "b"));
	});
});

describe("invariants", () => {
	test("I1: setter mid-test reroutes every subsequent call", () => {
		setLitusHome(resolve("/tmp/old"));
		const oldRoot = resolve("/tmp/old");
		expect(workflowsDir().startsWith(oldRoot)).toBe(true);

		const newRoot = resolve("/tmp/new");
		setLitusHome(newRoot);
		expect(workflowsDir().startsWith(newRoot)).toBe(true);
		expect(auditDir().startsWith(newRoot)).toBe(true);
		expect(reposDir().startsWith(newRoot)).toBe(true);
		expect(artifactsDir("wf").startsWith(newRoot)).toBe(true);
	});

	test("I2: rapid alternating setters are observed at each call", () => {
		setLitusHome(resolve("/a"));
		const first = workflowsDir();
		setLitusHome(resolve("/b"));
		const second = workflowsDir();
		expect(first).toBe(join(resolve("/a"), "workflows"));
		expect(second).toBe(join(resolve("/b"), "workflows"));
	});
});
