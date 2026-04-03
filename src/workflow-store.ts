import { mkdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Workflow, WorkflowIndexEntry } from "./types";

export class WorkflowStore {
	private baseDir: string;

	constructor(baseDir?: string) {
		this.baseDir = baseDir ?? join(homedir(), ".crab-studio", "workflows");
	}

	async save(workflow: Workflow): Promise<void> {
		throw new Error("Not implemented");
	}

	async load(id: string): Promise<Workflow | null> {
		throw new Error("Not implemented");
	}

	async loadAll(): Promise<Workflow[]> {
		throw new Error("Not implemented");
	}

	async loadIndex(): Promise<WorkflowIndexEntry[]> {
		throw new Error("Not implemented");
	}

	async remove(id: string): Promise<void> {
		throw new Error("Not implemented");
	}
}
