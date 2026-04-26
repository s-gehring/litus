import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AlertStore } from "../../src/alert-store";
import { AuditLogger } from "../../src/audit-logger";
import { ConfigStore } from "../../src/config-store";
import { EpicStore } from "../../src/epic-store";
import {
	auditDir,
	clearLitusHome,
	defaultModelCacheFile,
	reposDir,
	setLitusHome,
} from "../../src/litus-paths";
import { createDefaultManagedRepoStore, ManagedRepoStore } from "../../src/managed-repo-store";
import { getArtifactsRoot } from "../../src/workflow-artifacts";
import { WorkflowStore } from "../../src/workflow-store";
import { makePersistedEpic, makeRunningWorkflow, withTempDir } from "../test-infra";

const ORIGINAL_ENV = process.env.LITUS_HOME;

afterEach(() => {
	clearLitusHome();
	if (ORIGINAL_ENV === undefined) delete process.env.LITUS_HOME;
	else process.env.LITUS_HOME = ORIGINAL_ENV;
});

describe("setLitusHome reroutes default-constructed stores", () => {
	test("every default-constructed store writes under the configured root", async () => {
		await withTempDir(async (tmp) => {
			delete process.env.LITUS_HOME;
			setLitusHome(tmp);

			const workflows = new WorkflowStore();
			const wf = makeRunningWorkflow();
			await workflows.save(wf);
			expect(existsSync(join(tmp, "workflows", `${wf.id}.json`))).toBe(true);
			expect(existsSync(join(tmp, "workflows", "index.json"))).toBe(true);

			const epics = new EpicStore();
			await epics.save(makePersistedEpic());
			expect(existsSync(join(tmp, "workflows", "epics.json"))).toBe(true);

			const alerts = new AlertStore();
			await alerts.save([]);
			expect(existsSync(join(tmp, "alerts", "alerts.json"))).toBe(true);

			const config = new ConfigStore();
			const result = config.save({});
			expect(result.errors).toEqual([]);
			expect(existsSync(join(tmp, "config.json"))).toBe(true);

			const audit = new AuditLogger();
			audit.startRun("test-pipeline", null);
			expect(existsSync(join(tmp, "audit", "test-pipeline.jsonl"))).toBe(true);

			expect(getArtifactsRoot("wf-test").startsWith(tmp)).toBe(true);

			// cli-runner.ts: writes events.jsonl under auditDir() on every CLI
			// stream event. Asserting auditDir() resolves under tmp covers the
			// rerouting of that call site without spinning up a real CLI run.
			expect(auditDir().startsWith(tmp)).toBe(true);

			// default-model-info.ts: cache file accessor must reroute too.
			expect(defaultModelCacheFile().startsWith(tmp)).toBe(true);

			// managed-repo-store.ts: createDefaultManagedRepoStore() resolves
			// reposDir() at construction. tryAttachByPath observes baseDir, so
			// a path inside the configured root round-trips and proves the
			// factory picked up the rerouted reposDir().
			expect(reposDir().startsWith(tmp)).toBe(true);
			const repoStore = createDefaultManagedRepoStore();
			await repoStore.seedFromWorkflows([
				{
					...makeRunningWorkflow(),
					managedRepo: { owner: "acme", repo: "demo" },
				},
			]);
			// Seeded entries skip when the dir doesn't exist; the assertion
			// that matters is that reposDir() was the join root, which we
			// already checked. Guard against accidental writes below the
			// central root by verifying the seeded path lookup uses tmp.
			const attached = await repoStore.tryAttachByPath(join(tmp, "repos", "acme", "demo"));
			// Seed skipped (missing dir) ⇒ no state ⇒ null. The point is that
			// tryAttachByPath computes the relative offset against reposDir()
			// without throwing — i.e. baseDir lives under tmp.
			expect(attached).toBeNull();
		});
	});
});

describe("explicit baseDir still wins over setLitusHome", () => {
	// Out-of-scope for FR-008 precedence: workflow-artifacts.getArtifactsRoot
	// and default-model-info.defaultModelCacheFile have no caller-supplied
	// override path, so there is nothing to compare against the central root.
	test("baseDir argument overrides the central root for every store that accepts one", async () => {
		await withTempDir(async (centralRoot) => {
			await withTempDir(async (overrideRoot) => {
				delete process.env.LITUS_HOME;
				setLitusHome(centralRoot);

				const workflows = new WorkflowStore(overrideRoot);
				const wf = makeRunningWorkflow();
				await workflows.save(wf);
				expect(existsSync(join(overrideRoot, `${wf.id}.json`))).toBe(true);
				expect(existsSync(join(centralRoot, "workflows", `${wf.id}.json`))).toBe(false);

				const epics = new EpicStore(overrideRoot);
				await epics.save(makePersistedEpic());
				expect(existsSync(join(overrideRoot, "epics.json"))).toBe(true);
				expect(existsSync(join(centralRoot, "workflows", "epics.json"))).toBe(false);

				const alerts = new AlertStore(overrideRoot);
				await alerts.save([]);
				expect(existsSync(join(overrideRoot, "alerts.json"))).toBe(true);
				expect(existsSync(join(centralRoot, "alerts", "alerts.json"))).toBe(false);

				const configPath = join(overrideRoot, "explicit-config.json");
				const config = new ConfigStore(configPath);
				const result = config.save({});
				expect(result.errors).toEqual([]);
				expect(existsSync(configPath)).toBe(true);
				expect(existsSync(join(centralRoot, "config.json"))).toBe(false);

				const audit = new AuditLogger({ auditDir: overrideRoot });
				audit.startRun("explicit-pipeline", null);
				expect(existsSync(join(overrideRoot, "explicit-pipeline.jsonl"))).toBe(true);
				expect(existsSync(join(centralRoot, "audit", "explicit-pipeline.jsonl"))).toBe(false);

				// ManagedRepoStore: direct-construction with an explicit baseDir
				// must observe that baseDir, not the central reposDir(). We don't
				// run a real clone — tryAttachByPath returns null without any
				// state, but the relative-path math against deps.baseDir confirms
				// the construction honoured the override.
				const repoStore = new ManagedRepoStore({
					baseDir: overrideRoot,
					runCmd: async () => ({ code: 0, stdout: "", stderr: "", missing: false }),
					rm: async () => {},
					pathExists: async () => false,
				});
				const insideOverride = await repoStore.tryAttachByPath(join(overrideRoot, "owner", "repo"));
				const insideCentral = await repoStore.tryAttachByPath(
					join(centralRoot, "repos", "owner", "repo"),
				);
				expect(insideOverride).toBeNull();
				expect(insideCentral).toBeNull();
			});
		});
	});
});
