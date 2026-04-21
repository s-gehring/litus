import { expect } from "@playwright/test";
import type { AppPage } from "../pages/app";
import { SpecFormPage } from "../pages/spec-form";
import type { ServerMessage, ServerMessageObserver } from "./server-messages";

export interface ClonedRepoInput {
	/** Git URL to submit. Must match a `matchArg` entry in the scenario's
	 * `git.clone[]` map for a deterministic response. */
	repo: string;
	/** Specification text. Any non-empty string works — the spec aborts before
	 * pipeline steps run. */
	specification?: string;
	/** Expected terminal state. Caller MUST specify when testing failure. */
	expect?: "complete" | "error";
	/** Max wait (ms) for the terminal clone event. Default 15_000. */
	timeoutMs?: number;
	/**
	 * When true, assert the `.modal-clone-status` progress indicator is
	 * visible with non-empty text between submit and terminal event. The
	 * scenario's scripted clone response must provide a `delayMs` wide enough
	 * to keep the indicator rendered long enough for Playwright to observe it.
	 */
	assertProgressVisible?: boolean;
}

export interface ClonedRepoResult {
	/** `owner` from `repo:clone-complete`. Undefined on failure. */
	owner?: string;
	/** `repo` from `repo:clone-complete`. Undefined on failure. */
	repo?: string;
	/** `message` from `repo:clone-error`. Undefined on success. */
	errorMessage?: string;
}

/**
 * Drive the managed-repo clone flow from the New-Specification modal.
 *
 * Preconditions: the caller must attach a `ServerMessageObserver` BEFORE
 * navigating the page, and the in-use scenario must script a `git.clone`
 * response keyed (via `matchArg`) to the URL being submitted.
 */
export async function clonedRepo(
	app: AppPage,
	observer: ServerMessageObserver,
	input: ClonedRepoInput,
): Promise<ClonedRepoResult> {
	const expectState = input.expect ?? "complete";
	const timeoutMs = input.timeoutMs ?? 15_000;

	await app.newSpecButton().click();
	const form = new SpecFormPage(app.page);
	await expect(form.modal()).toBeVisible();

	await form.repoInput().fill(input.repo);
	await form.specificationInput().fill(input.specification ?? "placeholder — not exercised");

	// Register the terminal waiter BEFORE clicking Start so we don't miss a
	// fast broadcast; `waitFor` only matches frames received strictly after
	// it's registered.
	const terminalType = expectState === "complete" ? "repo:clone-complete" : "repo:clone-error";
	const terminal = observer.waitFor((m: ServerMessage) => m.type === terminalType, timeoutMs);

	await form.submitButton().click();

	if (input.assertProgressVisible) {
		// Asserted BEFORE awaiting the terminal so we observe the indicator
		// during the scenario-scripted clone delay window.
		await expect(form.cloneStatus()).toBeVisible();
		await expect(form.cloneStatus()).not.toHaveText("");
	}

	const msg = (await terminal) as {
		type: string;
		owner?: string;
		repo?: string;
		message?: string;
	};

	if (expectState === "complete") {
		await expect(form.modal()).toBeHidden({ timeout: 5_000 });
		return { owner: msg.owner, repo: msg.repo };
	}

	await expect(form.errorMessage()).toBeVisible();
	await expect(form.errorMessage()).toHaveText(/repository|not found|failed/i, { timeout: 5_000 });
	return { errorMessage: msg.message };
}
