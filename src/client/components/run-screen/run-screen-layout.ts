import { type TaskAccent, typeAccent } from "../../design-system/tokens";
import { createConfigRow } from "./config-row";
import { createEnvironmentCard } from "./environment-card";
import { createLogConsole } from "./log-console";
import { createPipelineStepper } from "./pipeline-stepper";
import type { RunScreenModel } from "./run-screen-model";
import { createTaskHeader } from "./task-header";
import { createTouchedFilesCard } from "./touched-files-card";
import { createUpcomingCard } from "./upcoming-card";

export interface RunScreenLayoutHandlers {
	onPauseToggle: () => void;
	onModelChange: (model: string) => void;
	onEffortChange: (effort: "low" | "medium" | "high" | "xhigh" | "max") => void;
	onStepClick: (stepName: string) => void;
}

export interface RunScreenLayoutController {
	element: HTMLElement;
	update(model: RunScreenModel): void;
	tick(): void;
	destroy(): void;
}

export function createRunScreenLayout(
	initial: RunScreenModel,
	handlers: RunScreenLayoutHandlers,
): RunScreenLayoutController {
	const accent: TaskAccent = typeAccent(initial.type);

	const host = document.createElement("div");
	host.dataset.runScreen = "layout";
	Object.assign(host.style, {
		flex: "1",
		display: "flex",
		gap: "16px",
		minHeight: "0",
		padding: "8px 22px 22px",
	} satisfies Partial<CSSStyleDeclaration>);

	const left = document.createElement("div");
	Object.assign(left.style, {
		flex: "1",
		display: "flex",
		flexDirection: "column",
		minWidth: "0",
		gap: "14px",
	} satisfies Partial<CSSStyleDeclaration>);
	host.appendChild(left);

	const right = document.createElement("div");
	Object.assign(right.style, {
		width: "300px",
		display: "flex",
		flexDirection: "column",
		gap: "14px",
		minWidth: "0",
	} satisfies Partial<CSSStyleDeclaration>);
	host.appendChild(right);

	const header = createTaskHeader(initial, accent, {
		onPauseToggle: handlers.onPauseToggle,
	});
	left.appendChild(header.element);

	const stepper = createPipelineStepper(initial.pipeline, accent, {
		onStepClick: (stepName) => {
			handlers.onStepClick(stepName);
			logConsole.scrollToSection(stepName);
		},
	});
	left.appendChild(stepper.element);

	const config = createConfigRow(initial.config, {
		onModelChange: handlers.onModelChange,
		onEffortChange: handlers.onEffortChange,
	});
	left.appendChild(config.element);

	const logConsole = createLogConsole(initial.log);
	left.appendChild(logConsole.element);

	const env = createEnvironmentCard(initial.env);
	right.appendChild(env.element);

	const touched = createTouchedFilesCard(initial.touched);
	right.appendChild(touched.element);

	const upcoming = createUpcomingCard(initial.upcoming);
	right.appendChild(upcoming.element);

	function update(model: RunScreenModel): void {
		const a = typeAccent(model.type);
		header.update(model, a);
		stepper.update(model.pipeline, a);
		config.update(model.config);
		logConsole.update(model.log);
		env.update(model.env);
		touched.update(model.touched);
		upcoming.update(model.upcoming);
	}

	return {
		element: host,
		update,
		tick: () => header.tick(),
		destroy: () => {
			host.remove();
		},
	};
}
