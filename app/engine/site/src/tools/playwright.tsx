/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import type { SiteModule } from "../common/module.ts";
import { Icon } from "../common/icon.tsx";
import { useSite } from "../common/runtime.ts";
import { errorMessage, parseConfiguration } from "../common/state.ts";
import { AnsiLog } from "../common/log.tsx";

type TestSettings = {
	enabled: boolean;
	project: string;
	browser: string;
	testFile: string;
	workers: string;
};
const testSettings = (text: string, fallback: unknown): TestSettings => {
	let value = fallback;
	try {
		value = parseConfiguration(text).playwright ?? value;
	} catch {
		/* Keep unfinished JSON. */
	}
	const settings =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	return {
		enabled: settings.enabled === true,
		project: typeof settings.project === "string" ? settings.project : "",
		browser:
			typeof settings.browser === "string" ? settings.browser : "container",
		testFile: typeof settings.testFile === "string" ? settings.testFile : "",
		workers: String(settings.workers || 1),
	};
};

export const Playwright = () => {
	const runtime = useSite();
	const next = runtime.snapshot;
	const runner = next?.playwright;
	const [draft, setDraft] = useState<{
		settings: TestSettings;
		sourceText: string;
	}>();
	const [requestError, setRequestError] = useState("");
	let validConfiguration = true;
	try {
		parseConfiguration(runtime.configText);
	} catch {
		validConfiguration = false;
	}
	if (draft && draft.sourceText !== runtime.configText && validConfiguration)
		setDraft(undefined);
	const editing =
		!!draft && (draft.sourceText === runtime.configText || !validConfiguration);
	const settings =
		editing && draft
			? draft.settings
			: testSettings(runtime.configText, runner?.settings);
	const submitting = useRef(false);
	const request = useRef<AbortController | undefined>(undefined);
	const details = useRef<HTMLDetailsElement>(null);
	const disabled = runtime.disabled || submitting.current;
	const runnerError = requestError || runner?.error;
	const message = runnerError
		? [next?.error, runtime.actionError].includes(runnerError)
			? ""
			: runnerError
		: editing
			? "Test settings changed. Save before running tests."
			: runner?.relaunch
				? "Save settings and relaunch SuiteContainer to use this test project and browser."
				: !runner?.enabled
					? "Enable the runner, save settings, and relaunch SuiteContainer."
					: !runner.settings.project
						? "Choose the directory containing your Playwright configuration and lockfile."
						: {
								idle: "Ready to run tests.",
								running: "Playwright tests are running…",
								succeeded: "Playwright tests passed.",
								failed:
									"Playwright tests failed or were stopped. Review the output.",
							}[runner.state];
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

	const edit = (changes: Partial<TestSettings>) => {
		if (disabled) return;
		const edited = { ...settings, ...changes };
		setRequestError("");
		try {
			runtime.updateConfig((config) => {
				const existing = config.playwright;
				if (
					existing !== undefined &&
					(!existing || typeof existing !== "object" || Array.isArray(existing))
				)
					throw new Error("Invalid test settings.");
				config.playwright = {
					...(existing as Record<string, unknown> | undefined),
					enabled: edited.enabled,
					project: edited.project.trim(),
					browser: edited.browser,
					testFile: edited.testFile.trim(),
					workers: Number(edited.workers),
				};
			});
		} catch {
			setRequestError(
				"Fix the configuration JSON in Settings before changing test settings.",
			);
		}
		setDraft({ settings: edited, sourceText: runtime.configText });
	};

	const act = async (operation: "run" | "cancel" | "save") => {
		if (
			submitting.current ||
			runtime.stopped ||
			runtime.connectionFailed ||
			(operation !== "cancel" && runtime.disabled)
		)
			return;
		if (operation === "cancel" && runner?.state !== "running") return;
		if (operation === "run" && (editing || !runner?.canRun)) return;
		submitting.current = true;
		setRequestError("");
		runtime.setPending("playwright", true);
		const text = runtime.configText;
		const controller = new AbortController();
		request.current = controller;
		try {
			const next = await runtime.api(
				operation === "save" ? "settings" : "playwright/" + operation,
				operation === "cancel" ? {} : { config: text },
				undefined,
				controller.signal,
			);
			if (controller.signal.aborted) return;
			if (operation === "cancel") runtime.accept(next);
			else {
				runtime.saved(next, text);
				setDraft(undefined);
			}
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
					<h2>
						<Icon name="wrench" /> Playwright tests
					</h2>
				</summary>
				<p>
					Run your SuiteApp browser tests against Current VM. Configure test
					users and roles in your Playwright project.
				</p>
				<label for="playwright-enabled">
					<input
						id="playwright-enabled"
						type="checkbox"
						disabled={disabled}
						checked={settings.enabled}
						onChange={(event) => edit({ enabled: event.currentTarget.checked })}
					/>{" "}
					Enable test runner
				</label>
				<label for="playwright-project">Project directory inside repos</label>
				<input
					id="playwright-project"
					spellcheck={false}
					placeholder="absi-nsn/test-pw"
					disabled={disabled}
					value={settings.project}
					onInput={(event) => edit({ project: event.currentTarget.value })}
				/>
				<label for="playwright-browser">Browser</label>
				<select
					id="playwright-browser"
					disabled={disabled}
					value={settings.browser}
					onChange={(event) => edit({ browser: event.currentTarget.value })}
				>
					<option value="container">Container browser</option>
					<option value="local-chrome">Local Chrome (separate window)</option>
				</select>
				<div class="grid">
					<div>
						<label for="playwright-file">Test file (optional)</label>
						<input
							id="playwright-file"
							spellcheck={false}
							placeholder="tests/example.spec.ts"
							disabled={disabled}
							value={settings.testFile}
							onInput={(event) => edit({ testFile: event.currentTarget.value })}
						/>
					</div>
					<div>
						<label for="playwright-workers">Parallel workers</label>
						<input
							id="playwright-workers"
							type="number"
							min="1"
							max="16"
							step="1"
							disabled={disabled}
							value={settings.workers}
							onInput={(event) => edit({ workers: event.currentTarget.value })}
						/>
					</div>
				</div>
				<p>
					<small>
						Save settings and relaunch after enabling the runner or changing the
						project directory or browser. Leave Test file blank to run the
						configured project.
					</small>
				</p>
				<fieldset class="grid" aria-label="Playwright actions">
					<button
						id="playwright-save"
						class="secondary"
						disabled={disabled}
						onClick={() => act("save")}
					>
						Save test settings
					</button>
					<button
						id="playwright-run"
						disabled={disabled || editing || !runner?.canRun}
						onClick={() => act("run")}
					>
						Run tests
					</button>
					<button
						id="playwright-cancel"
						class="secondary outline"
						disabled={
							runtime.stopped ||
							runtime.connectionFailed ||
							submitting.current ||
							runner?.state !== "running"
						}
						onClick={() => act("cancel")}
					>
						Stop tests
					</button>
				</fieldset>
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
	navigation: {
		target: "playwright-section",
		label: "Playwright",
		icon: "wrench",
	},
};
