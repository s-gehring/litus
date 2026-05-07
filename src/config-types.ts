// Application configuration types — moved into `@litus/protocol`.
//
// This file keeps the runtime helpers that operate on the config types
// (the types themselves now live in `@litus/protocol/src/shared-types.ts`).
// Re-exports below preserve the historical import sites.

export type {
	AppConfig,
	AuditConfig,
	AutoMode,
	ConfigValidationError,
	ConfigWarning,
	DeepPartial,
	EffortConfig,
	EffortLevel,
	LimitConfig,
	ModelConfig,
	NumericSettingInputKind,
	NumericSettingMeta,
	PromptConfig,
	PromptVariableInfo,
	TelegramSettings,
	TimingConfig,
} from "@litus/protocol";

import type { AutoMode } from "@litus/protocol";

export function shouldAutoAnswer(mode: AutoMode): boolean {
	return mode === "full-auto";
}

export function shouldPauseBeforeMerge(mode: AutoMode): boolean {
	return mode === "manual";
}
