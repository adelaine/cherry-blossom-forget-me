/** @jsxImportSource preact */
import { useEffect, useRef } from "preact/hooks";
import type { SiteModule } from "../common/module.ts";
import { useSite } from "../common/runtime.ts";
import { errorMessage } from "../common/state.ts";
import { AnsiLog } from "../common/log.tsx";

export const Deployment = () => {
	const runtime = useSite();
	const next = runtime.snapshot;
	const request = useRef<AbortController | undefined>(undefined);
	const submitting = useRef(false);
	useEffect(
		() => () => {
			request.current?.abort();
			runtime.setPending("deployment", false);
		},
		[],
	);

	const deploy = async () => {
		if (
			runtime.disabled ||
			runtime.credentialEditing ||
			!runtime.snapshot?.ready ||
			submitting.current
		)
			return;
		submitting.current = true;
		runtime.setActionError("");
		runtime.setPending("deployment", true);
		const controller = new AbortController();
		request.current = controller;
		const text = runtime.configText;
		try {
			const result = await runtime.api(
				"deploy",
				{ config: text },
				undefined,
				controller.signal,
			);
			if (!controller.signal.aborted) runtime.saved(result, text);
		} catch (error) {
			if (!controller.signal.aborted)
				runtime.setActionError(errorMessage(error));
		} finally {
			submitting.current = false;
			runtime.setPending("deployment", false);
		}
	};

	const validation =
		runtime.actionError ||
		(runtime.busy
			? next?.playwright?.state === "running" ||
				runtime.pending.has("playwright")
				? "Playwright tests are running. Stop the tests or wait for them to finish before deploying or changing settings."
				: next?.sql?.preparing
					? "Unlocking the saved SQL password. Please wait."
					: next?.sql?.state === "running" || runtime.pending.has("sql")
						? "SQL is running. Wait for it to finish before deploying or changing settings."
						: "Deployment is running. Wait for it to finish before changing settings or credentials."
			: next?.relaunch
				? "Relaunch required. Save your changes, stop this app, and start the launcher again."
				: next?.error ||
					(runtime.credentialEditing
						? "Save your credential changes before deploying."
						: runtime.editing
							? "Settings are ready."
							: "Ready to deploy."));
	const status = next
		? {
				idle: "No deployment started.",
				running: "Deployment in progress…",
				succeeded: "Deployment completed.",
				failed:
					"Deployment failed. Review the message below, correct settings or credentials, and retry.",
			}[next.run.state]
		: "Loading…";

	return (
		<article id="deployment-section">
			<h2>Deploy SuiteApps</h2>
			<p id="validation" role="status">
				{validation}
			</p>
			<fieldset aria-label="Deployment actions">
				<button
					id="deploy"
					disabled={
						runtime.disabled || !next?.ready || runtime.credentialEditing
					}
					onClick={deploy}
				>
					Deploy SuiteApps
				</button>
			</fieldset>
			<blockquote class="status-message" id="run-state" role="status">
				{runtime.stopMessage || status}
			</blockquote>
			<AnsiLog
				id="log"
				text={next?.run.log || ""}
				label="Deployment progress"
			/>
		</article>
	);
};

export const deployment: SiteModule = {
	id: "deployment",
	placement: "feature",
	slot: "deployment",
	Component: Deployment,
	navigation: { target: "deployment-section", label: "Deploy" },
};
