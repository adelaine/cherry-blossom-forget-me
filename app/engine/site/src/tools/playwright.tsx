/** @jsxImportSource preact */
/* Copyright (c) 2026, Oracle and/or its affiliates. */
import { useEffect, useRef, useState } from "preact/hooks";
import type { SiteModule } from "../common/module.ts";
import { useSite } from "../common/runtime.ts";
import { errorMessage } from "../common/state.ts";
import { AnsiLog } from "../common/log.tsx";

export const Playwright = () => {
	const runtime = useSite();
	const runner = runtime.snapshot?.playwright;
	const [requestError, setRequestError] = useState("");
	const submitting = useRef(false);
	const request = useRef<AbortController | undefined>(undefined);
	const details = useRef<HTMLDetailsElement>(null);
	const message =
		requestError ||
		runner?.error ||
		(!runner?.available
			? "Launch SuiteContainer with --playwright to start the test runner."
			: {
					idle: "Ready to run tests.",
					running: "Playwright tests are running…",
					succeeded: "Playwright tests passed.",
					failed: "Playwright tests failed or were stopped. Review the output.",
				}[runner.state]);
	useEffect(
		() => () => {
			request.current?.abort();
			runtime.setPending("playwright", false);
		},
		[runtime],
	);
	useEffect(() => {
		if (runtime.collapseVersion && details.current)
			details.current.open = false;
	}, [runtime.collapseVersion]);

	const cancel = async () => {
		if (
			submitting.current ||
			runtime.stopped ||
			runtime.connectionFailed ||
			runner?.state !== "running"
		)
			return;
		submitting.current = true;
		setRequestError("");
		runtime.setPending("playwright", true);
		const controller = new AbortController();
		request.current = controller;
		try {
			const next = await runtime.api(
				"playwright/cancel",
				{},
				undefined,
				controller.signal,
			);
			if (!controller.signal.aborted) runtime.accept(next);
		} catch (error) {
			if (!controller.signal.aborted) setRequestError(errorMessage(error));
		} finally {
			submitting.current = false;
			runtime.setPending("playwright", false);
		}
	};

	return (
		<article>
			<details class="setup-section" id="playwright-section" ref={details}>
				<summary>
					<h2>Playwright runner</h2>
				</summary>
				<p>
					Start the runner with the launcher’s <code>--playwright</code> option.
					Submit each test run through <code>/api/playwright/run</code> with its
					project and target. No Playwright settings need to be saved.
				</p>
				<button
					id="playwright-cancel"
					class="secondary outline"
					disabled={
						runtime.stopped ||
						runtime.connectionFailed ||
						submitting.current ||
						runner?.state !== "running"
					}
					onClick={cancel}
				>
					Stop tests
				</button>
				<p id="playwright-message" role="status">
					{message}
				</p>
				<AnsiLog
					id="playwright-log"
					text={runner?.log || ""}
					label="Playwright progress"
				/>
			</details>
		</article>
	);
};

export const playwright: SiteModule = {
	id: "playwright",
	placement: "tool",
	Component: Playwright,
	navigation: { target: "playwright-section", label: "Playwright" },
};
