/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import type { SiteModule } from "../common/module.ts";
import { useSite } from "../common/runtime.ts";
import { errorMessage, parseConfiguration } from "../common/state.ts";

type SuiteApp = Record<string, unknown>;
type SuiteAppConfig = Record<string, unknown> & { suiteapps: SuiteApp[] };
type Row = { key: number; source: string; url: string; branch: string };

const suiteappConfig = (text: string): SuiteAppConfig => {
	const config = parseConfiguration(text);
	if (
		!Array.isArray(config.suiteapps) ||
		config.suiteapps.some(
			(app) => !app || typeof app !== "object" || Array.isArray(app),
		)
	)
		throw new Error(
			"Fix the SuiteApps list in Advanced configuration before editing SuiteApps.",
		);
	return config as SuiteAppConfig;
};

export const directoryFromUrl = (value: string): string => {
	return value
		.trim()
		.split(/[?#]/)[0]!
		.replace(/\/+$/, "")
		.split(/[/:]/)
		.pop()!
		.replace(/\.git$/i, "");
};

export const SuiteApps = () => {
	const runtime = useSite();
	const [message, setMessage] = useState("");
	const [saving, setSaving] = useState(false);
	const [focusKey, setFocusKey] = useState<number>();
	const request = useRef<AbortController | undefined>(undefined);
	const submitting = useRef(false);
	const nextKey = useRef(0);
	const cache = useRef<{ text: string; rows: Row[] }>({ text: "", rows: [] });
	const inputs = useRef(new Map<number, HTMLInputElement>());
	let config: SuiteAppConfig | undefined;
	try {
		config = suiteappConfig(runtime.configText);
	} catch {
		/* The raw draft remains editable. */
	}
	if (config && cache.current.text !== runtime.configText) {
		const available = [...cache.current.rows];
		const rows = config.suiteapps.map((app) => {
			const source = JSON.stringify(app);
			const matching = available.findIndex((row) => row.source === source);
			const previous =
				matching >= 0 ? available.splice(matching, 1)[0] : undefined;
			return {
				key: previous?.key ?? ++nextKey.current,
				source,
				url: typeof app.url === "string" ? app.url : "",
				branch: typeof app.branch === "string" ? app.branch : "",
			};
		});
		cache.current = { text: runtime.configText, rows };
	}
	const disabled = runtime.disabled || saving || !config;
	const rows = cache.current.rows;
	useEffect(
		() => () => {
			request.current?.abort();
			runtime.setPending("suiteapps", false);
		},
		[],
	);
	useEffect(() => {
		if (focusKey !== undefined) inputs.current.get(focusKey)?.focus();
	}, [focusKey]);

	const write = (next: SuiteAppConfig, nextRows: Row[]) => {
		const text = JSON.stringify(next, null, 4);
		cache.current = {
			text,
			rows: nextRows.map((row, index) => ({
				...row,
				source: JSON.stringify(next.suiteapps[index]),
			})),
		};
		runtime.changeConfig(text);
		setMessage(
			"SuiteApps changed. Save SuiteApps, or click Deploy to save and deploy.",
		);
	};

	const edit = (index: number, field: "url" | "branch", value: string) => {
		if (disabled) return;
		const next = suiteappConfig(runtime.configText);
		const app = next.suiteapps[index]!;
		const trimmed = value.trim();
		if (field === "url") {
			if (trimmed) {
				app.url = trimmed;
				app.directory = directoryFromUrl(trimmed);
			} else {
				delete app.url;
				if (!app.localPath) app.directory = "";
			}
		} else if (trimmed) app.branch = trimmed;
		else delete app.branch;
		write(
			next,
			rows.map((row, position) =>
				position === index ? { ...row, [field]: value } : row,
			),
		);
	};

	const add = () => {
		if (disabled) return;
		const next = suiteappConfig(runtime.configText);
		next.suiteapps.push({ url: "", directory: "" });
		const key = ++nextKey.current;
		write(next, [...rows, { key, source: "", url: "", branch: "" }]);
		setFocusKey(key);
	};

	const remove = (index: number) => {
		if (disabled) return;
		const next = suiteappConfig(runtime.configText);
		next.suiteapps.splice(index, 1);
		write(
			next,
			rows.filter((_row, position) => position !== index),
		);
	};

	const save = async () => {
		if (disabled || submitting.current) return;
		submitting.current = true;
		setSaving(true);
		runtime.setPending("suiteapps", true);
		runtime.setActionError("");
		const controller = new AbortController();
		request.current = controller;
		const text = runtime.configText;
		try {
			const next = await runtime.api(
				"settings",
				{ config: text },
				undefined,
				controller.signal,
			);
			if (!controller.signal.aborted) {
				runtime.saved(next, text);
				setMessage("SuiteApps saved.");
			}
		} catch (error) {
			if (!controller.signal.aborted) setMessage(errorMessage(error));
		} finally {
			submitting.current = false;
			if (!controller.signal.aborted) setSaving(false);
			runtime.setPending("suiteapps", false);
		}
	};

	return (
		<>
			<h2 id="suiteapps-heading">SuiteApps</h2>
			<article class="suiteapps-card">
				<div id="suiteapp-blocks">
					{rows.map((row, index) => {
						const app = config?.suiteapps[index];
						const title =
							typeof app?.directory === "string" && app.directory
								? app.directory
								: "New SuiteApp";
						const removeLabel = "Remove SuiteApp " + (index + 1);
						return (
							<div class="suiteapp-block" key={row.key}>
								<div class="suiteapp-fields">
									<label>
										<span>{title}</span>
										<input
											aria-label={title + " GitLab URL"}
											type="text"
											inputMode="url"
											spellcheck={false}
											autocomplete="off"
											placeholder="https://gitlab.eng.netsuite.com/team/suiteapp.git"
											data-index={index}
											data-field="url"
											value={row.url}
											disabled={disabled}
											onInput={(event) =>
												edit(index, "url", event.currentTarget.value)
											}
											ref={(input) => {
												if (input) inputs.current.set(row.key, input);
												else inputs.current.delete(row.key);
											}}
										/>
									</label>
									<label>
										Branch
										<input
											type="text"
											spellcheck={false}
											autocomplete="off"
											placeholder="Default branch"
											data-index={index}
											data-field="branch"
											value={row.branch}
											disabled={disabled}
											onInput={(event) =>
												edit(index, "branch", event.currentTarget.value)
											}
										/>
									</label>
									<button
										type="button"
										class="suiteapp-remove secondary outline"
										data-index={index}
										aria-label={removeLabel}
										title={removeLabel}
										disabled={disabled}
										onClick={() => remove(index)}
									>
										<svg
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											stroke-width="1.8"
											stroke-linecap="round"
											stroke-linejoin="round"
											aria-hidden="true"
											focusable="false"
										>
											<path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" />
										</svg>
									</button>
								</div>
								<small class="suiteapp-local">
									{app?.localPath
										? "Local checkout: " +
											app.localPath +
											". Manage it in Advanced configuration."
										: ""}
								</small>
							</div>
						);
					})}
					{rows.length === 0 && (
						<p class="suiteapps-empty">
							No SuiteApps added yet. Add one to get started.
						</p>
					)}
				</div>
				<div class="suiteapps-footer">
					<button
						type="button"
						class="secondary outline"
						id="add-suiteapp"
						disabled={disabled}
						onClick={add}
					>
						+ Add SuiteApp
					</button>
					<button
						type="button"
						id="save-suiteapps"
						disabled={disabled}
						onClick={save}
					>
						Save SuiteApps
					</button>
				</div>
				<p id="suiteapps-message" role="status">
					{!config
						? "Fix the configuration JSON in Advanced configuration to edit SuiteApps. Your JSON edits are preserved."
						: message}
				</p>
			</article>
		</>
	);
};

export const suiteapps: SiteModule = {
	id: "suiteapps",
	placement: "feature",
	slot: "suiteapps",
	Component: SuiteApps,
	navigation: { target: "suiteapps-section", label: "SuiteApps" },
	styleOrder: 3,
	style: /* css */ `.suiteapp-block{padding:1.5rem;border-bottom:1px solid var(--pico-muted-border-color)}
.suiteapps-footer{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.suiteapp-fields{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr) 2.75rem;align-items:end;gap:1.25rem}
.suiteapp-fields label{min-width:0;margin-bottom:0}
.suiteapp-fields input{margin-bottom:0}
.suiteapp-remove{display:inline-flex;align-items:center;justify-content:center;width:2.75rem;height:3.25rem;padding:0;margin:0;border:0;border-radius:0.25rem;box-shadow:none;color:var(--pico-secondary);background:transparent}
.suiteapp-remove svg{width:1.25rem;height:1.25rem;pointer-events:none}
.suiteapp-remove:enabled:hover{color:var(--pico-del-color);background:color-mix(in srgb,var(--pico-del-color) 10%,transparent)}
.suiteapp-remove:focus-visible{outline:2px solid var(--pico-primary);outline-offset:2px}
.suiteapp-local{display:block;margin-top:0.5rem;color:var(--pico-muted-color);overflow-wrap:anywhere}
.suiteapp-local:empty{display:none}
.suiteapps-empty{padding:1.5rem;margin:0;color:var(--pico-muted-color)}
.suiteapps-footer button{margin:0}
#suiteapps-message{padding:0 1.5rem 1.25rem}
`,
};
