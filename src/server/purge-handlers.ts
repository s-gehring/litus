import { existsSync } from "node:fs";
import { toErrorMessage } from "../errors";
import { gitSpawn } from "../git-logger";
import { logger } from "../logger";
import type { MessageHandler } from "./handler-types";

export const handlePurgeAll: MessageHandler = async (_ws, _data, deps) => {
	const warnings: string[] = [];

	try {
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
					orch.abortPipeline(id);
				}
			} catch {
				// Best effort
			}
		}
		deps.orchestrators.clear();

		// Abort any in-progress epic analysis
		if (deps.epicAnalysisRef.current) {
			deps.epicAnalysisRef.current.kill();
			deps.epicAnalysisRef.current = null;
		}

		// 2. Load all workflows to find worktrees and branches to clean up
		deps.broadcast({
			type: "purge:progress",
			step: "Loading workflows...",
			current: 0,
			total: 0,
		});
		const allWorkflows = await deps.sharedStore.loadAll();

		// Group by target repository for git cleanup. Dedupe worktree paths and
		// branches per repo so that stale duplicates in persistence don't produce
		// N repeat git calls (and N repeat failures).
		const repoCleanup = new Map<string, { worktreePaths: Set<string>; branches: Set<string> }>();
		for (const w of allWorkflows) {
			if (!w.targetRepository) continue;
			let entry = repoCleanup.get(w.targetRepository);
			if (!entry) {
				entry = { worktreePaths: new Set(), branches: new Set() };
				repoCleanup.set(w.targetRepository, entry);
			}
			if (w.worktreePath) {
				entry.worktreePaths.add(w.worktreePath);
			}
			const branch = w.featureBranch ?? w.worktreeBranch;
			if (branch && !["master", "main"].includes(branch)) {
				entry.branches.add(branch);
			}
		}

		// Count total operations for progress
		let totalOps = 0;
		for (const { worktreePaths, branches } of repoCleanup.values()) {
			totalOps += worktreePaths.size + branches.size;
		}
		// +1 for prune per repo, +1 for persistence wipe
		totalOps += repoCleanup.size + 1;
		let completedOps = 0;

		// 3. Remove worktrees and delete branches per repository
		for (const [repo, { worktreePaths, branches }] of repoCleanup) {
			// Repo already gone from disk → purge's goal is already met for it.
			// Skip silently (no warning surfaced to the user); we still advance
			// completedOps so the progress bar lines up with totalOps.
			if (!existsSync(repo)) {
				logger.info(`[purge] Repository already gone, nothing to do: ${repo}`);
				completedOps += worktreePaths.size + 1 + branches.size;
				deps.broadcast({
					type: "purge:progress",
					step: `Nothing to clean for ${repo}`,
					current: completedOps,
					total: totalOps,
				});
				continue;
			}

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
					warnings.push(`Worktree remove error (${wtPath}): ${toErrorMessage(err)}`);
				}
				completedOps++;
			}

			deps.broadcast({
				type: "purge:progress",
				step: "Pruning worktree metadata",
				current: completedOps,
				total: totalOps,
			});
			try {
				const result = await gitSpawn(["git", "worktree", "prune"], { cwd: repo });
				if (result.code !== 0) {
					warnings.push(`Worktree prune failed (${repo}): ${result.stderr}`);
				}
			} catch (err) {
				warnings.push(`Worktree prune error (${repo}): ${toErrorMessage(err)}`);
			}
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
					warnings.push(`Branch delete error (${branch}): ${toErrorMessage(err)}`);
				}
				completedOps++;
			}
		}

		// 4. Wipe persistence: workflows, epics, audit logs, alerts
		deps.broadcast({
			type: "purge:progress",
			step: "Deleting persistence files",
			current: completedOps,
			total: totalOps,
		});
		await deps.sharedStore.removeAll();
		await deps.sharedEpicStore.removeAll();
		deps.sharedAuditLogger.removeAll();
		const clearedAlertIds = deps.alertQueue.clearAll();
		// Purge has strong "gone for good" semantics — wait for the empty-list
		// write to flush so a crash between here and disk sync won't resurrect
		// purged alerts on next startup via `loadFromDisk`.
		await deps.alertQueue.flush();
		if (clearedAlertIds.length > 0) {
			deps.broadcast({ type: "alert:dismissed", alertIds: clearedAlertIds });
		}
		completedOps++;

		logger.info(
			`[purge] All data purged (${allWorkflows.length} workflows, ${repoCleanup.size} repos)`,
		);
		if (warnings.length > 0) {
			logger.warn(`[purge] Warnings: ${warnings.join("; ")}`);
		}

		deps.broadcast({ type: "purge:complete", warnings });
	} catch (err) {
		const message = toErrorMessage(err);
		logger.error(`[purge] Aborted: ${message}`);
		deps.broadcast({ type: "purge:error", message, warnings });
	}
};
