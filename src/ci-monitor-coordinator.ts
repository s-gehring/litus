import type { MonitorResult } from "./ci-monitor";
import type { CiCycle, Workflow } from "./types";

type StartMonitoringFn = (
	prUrl: string,
	ciCycle: CiCycle,
	onOutput: (msg: string) => void,
	signal?: AbortSignal,
) => Promise<MonitorResult>;

type DiscoverPrUrlFn = (workflow: Workflow) => Promise<string | null>;

export class CIMonitorCoordinator {
	private abortController: AbortController | null = null;
	private startMonitoringFn: StartMonitoringFn;
	private discoverPrUrlFn: DiscoverPrUrlFn;

	constructor(startMonitoringFn: StartMonitoringFn, discoverPrUrlFn?: DiscoverPrUrlFn) {
		this.startMonitoringFn = startMonitoringFn;
		this.discoverPrUrlFn = discoverPrUrlFn ?? (() => Promise.resolve(null));
	}

	async startMonitoring(
		workflow: Workflow,
		onOutput: (msg: string) => void,
	): Promise<MonitorResult> {
		workflow.ciCycle.monitorStartedAt =
			workflow.ciCycle.monitorStartedAt ?? new Date().toISOString();

		this.abortController = new AbortController();

		try {
			const result = await this.startMonitoringFn(
				workflow.prUrl as string,
				workflow.ciCycle,
				onOutput,
				this.abortController.signal,
			);
			return result;
		} finally {
			this.abortController = null;
		}
	}

	abort(): void {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
	}

	isMonitoring(): boolean {
		return this.abortController !== null;
	}

	async discoverPrUrl(workflow: Workflow): Promise<string | null> {
		return this.discoverPrUrlFn(workflow);
	}
}
