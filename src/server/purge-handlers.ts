import { gitSpawn } from "../git-logger";
import type { MessageHandler } from "./handler-types";

export const handlePurgeAll: MessageHandler = async (_ws, _data, deps) => {
	const warnings: string[] = [];

	// 1. Kill all running orchestrators
	deps.broadcast({
		type: "purge:progress",
		step: "Stopping running workflows...",
		current: 0,
		total: 0,
	});
	for (const [id, orch] of deps.orchestrators) {
		try {
			const w = orch.getEngine().getWorkflow();
			if (w && (w.status === "running" || w.status === "waiting_for_input")) {
				orch.cancelPipeline(id);
			}
		} catch {
			// Best effort
		}
	}
	deps.orchestrators.clear();

	// Cancel any in-progress epic analysis
	if (deps.epicAnalysisRef.current) {
		deps.epicAnalysisRef.current.kill();
		deps.epicAnalysisRef.current = null;
	}

	// 2. Load all workflows to find worktrees and branches to clean up
	deps.broadcast({ type: "purge:progress", step: "Loading workflows...", current: 0, total: 0 });
	const allWorkflows = await deps.sharedStore.loadAll();

	// Group by target repository for git cleanup
	const repoCleanup = new Map<string, { worktreePaths: string[]; branches: string[] }>();
	for (const w of allWorkflows) {
		if (!w.targetRepository) continue;
		let entry = repoCleanup.get(w.targetRepository);
		if (!entry) {
			entry = { worktreePaths: [], branches: [] };
			repoCleanup.set(w.targetRepository, entry);
		}
		if (w.worktreePath) {
			entry.worktreePaths.push(w.worktreePath);
		}
		const branch = w.featureBranch ?? w.worktreeBranch;
		if (branch && !["master", "main"].includes(branch)) {
			entry.branches.push(branch);
		}
	}

	// Count total operations for progress
	let totalOps = 0;
	for (const { worktreePaths, branches } of repoCleanup.values()) {
		totalOps += worktreePaths.length + branches.length;
	}
	// +1 for prune per repo, +1 for persistence wipe
	totalOps += repoCleanup.size + 1;
	let completedOps = 0;

	// 3. Remove worktrees and delete branches per repository
	for (const [repo, { worktreePaths, branches }] of repoCleanup) {
		for (const wtPath of worktreePaths) {
			const shortPath = wtPath.split(/[/\\]/).slice(-2).join("/");
			deps.broadcast({
				type: "purge:progress",
				step: `Removing worktree ${shortPath}`,
				current: completedOps,
				total: totalOps,
			});
			try {
				const result = await gitSpawn(["git", "worktree", "remove", wtPath, "--force"], {
					cwd: repo,
				});
				if (result.code !== 0) {
					warnings.push(`Worktree remove failed (${wtPath}): ${result.stderr}`);
				}
			} catch (err) {
				warnings.push(`Worktree remove error (${wtPath}): ${err}`);
			}
			completedOps++;
		}

		deps.broadcast({
			type: "purge:progress",
			step: "Pruning worktree metadata",
			current: completedOps,
			total: totalOps,
		});
		await gitSpawn(["git", "worktree", "prune"], { cwd: repo });
		completedOps++;

		for (const branch of branches) {
			deps.broadcast({
				type: "purge:progress",
				step: `Deleting branch ${branch}`,
				current: completedOps,
				total: totalOps,
			});
			try {
				const result = await gitSpawn(["git", "branch", "-D", branch], { cwd: repo });
				if (result.code !== 0 && !result.stderr.includes("not found")) {
					warnings.push(`Branch delete failed (${branch}): ${result.stderr}`);
				}
			} catch (err) {
				warnings.push(`Branch delete error (${branch}): ${err}`);
			}
			completedOps++;
		}
	}

	// 4. Wipe persistence: workflows, epics, audit logs
	deps.broadcast({
		type: "purge:progress",
		step: "Deleting persistence files",
		current: completedOps,
		total: totalOps,
	});
	await deps.sharedStore.removeAll();
	await deps.sharedEpicStore.removeAll();
	deps.sharedAuditLogger.removeAll();
	completedOps++;

	console.log(
		`[purge] All data purged (${allWorkflows.length} workflows, ${repoCleanup.size} repos)`,
	);
	if (warnings.length > 0) {
		console.warn(`[purge] Warnings: ${warnings.join("; ")}`);
	}

	deps.broadcast({ type: "purge:complete", warnings });
};
